import { decodeEventLog, type PublicClient } from "viem";
import { ADDR, CHAIN, INFRA, TOPIC, type Hex } from "../chain.ts";
import { curveAbi } from "../abi/pons.ts";
import { poolManagerAbi, SWAP_TOPIC } from "../abi/pool.ts";
import { getLogsAdaptive, type RawLog } from "../providers/logs.ts";
import type { Cache } from "../cache.ts";
import { yieldToScans } from "../scanflag.ts";

/**
 * Chain-wide curve-trade index. One pass over the chain's CurveBuy and
 * CurveSell events fills a local SQLite table keyed by trader wallet;
 * after that any wallet's full trade history is a local SELECT. The
 * public node cannot answer wide topic-filtered queries for dozens of
 * wallets at once, but it answers narrow block windows without an
 * address filter reliably - so the index is built once in windows and
 * kept fresh by a cheap tail sync before each scan.
 *
 * The span [floor, tip] grows from the tip downward during backfill
 * (freshest history lands first) and from the tip upward during tail
 * sync. Buys store eth net of fee and tax (spec 3.1: fees are not part
 * of cost basis).
 */

const WINDOW = 40_000n; // ~1.1 h of chain per request
// v4 logs are ~60x denser than curve events (every pool transfer plus
// every swap), so that lane walks in much smaller windows
const WINDOW_V4 = BigInt(process.env.XRAY_V4_WINDOW ?? "2000");
const WINDOW_MAX = 640_000n; // empty pre-launchpad desert: grow up to this
// Politeness matters: the official node temporarily 403-bans IPs that pull
// too hard. Two windows in flight plus a breath between batches finishes
// overnight without tripping the ban; a trip costs an hour-scale cooldown.
const PARALLEL = Number(process.env.XRAY_INDEX_PARALLEL ?? 2);
const BATCH_DELAY_MS = Number(process.env.XRAY_INDEX_DELAY_MS ?? 400);
const ERROR_COOLDOWN_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = {
  block: bigint;
  logIndex: number;
  tx: string;
  curve: string;
  wallet: string;
  kind: "buy" | "sell";
  tokens: bigint;
  eth: bigint;
  token?: string;
};

export type Lane = "curve" | "v4";

function decodeRows(logs: RawLog[]): Row[] {
  const rows: Row[] = [];
  for (const l of logs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: curveAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    } catch {
      continue; // unrelated event with a colliding shape
    }
    if (decoded.eventName === "CurveBuy") {
      const a = decoded.args as { recipient: Hex; quoteIn: bigint; tokensOut: bigint; fee: bigint; tax: bigint };
      const eth = a.quoteIn - a.fee - a.tax;
      rows.push({
        block: l.blockNumber,
        logIndex: l.logIndex,
        tx: l.transactionHash,
        curve: l.address.toLowerCase(),
        wallet: a.recipient.toLowerCase(),
        kind: "buy",
        tokens: a.tokensOut,
        eth: eth > 0n ? eth : a.quoteIn,
      });
    } else if (decoded.eventName === "CurveSell") {
      const a = decoded.args as { seller: Hex; tokensIn: bigint; quoteOut: bigint };
      rows.push({
        block: l.blockNumber,
        logIndex: l.logIndex,
        tx: l.transactionHash,
        curve: l.address.toLowerCase(),
        wallet: a.seller.toLowerCase(),
        kind: "sell",
        tokens: a.tokensIn,
        eth: a.quoteOut,
      });
    }
  }
  return rows;
}

async function fetchWindow(client: PublicClient, fromBlock: bigint, toBlock: bigint, onSplit?: () => void): Promise<Row[]> {
  const logs = await getLogsAdaptive(
    client,
    { topics: [[TOPIC.curveBuy as Hex, TOPIC.curveSell as Hex]], fromBlock, toBlock },
    { parallel: 1, onSplit },
  );
  return decodeRows(logs);
}

/**
 * Post-graduation v4 trades. The Swap event names no trader, but the
 * token itself moves between the trader and the pool manager in the same
 * transaction: Transfer wallet -> poolManager is a sell, poolManager ->
 * wallet a buy. The quote side comes from the Swap event in that
 * transaction whose token-side magnitude matches the transferred amount.
 */
const PM_PADDED = `0x000000000000000000000000${ADDR.poolManager.slice(2)}` as Hex;

export function decodeV4Rows(transferLogs: RawLog[], swapLogs: RawLog[]): Row[] {
  // Swaps by transaction, each with its two sides and its position in the
  // log. A trade writes its legs right next to its swap, so position is
  // what tells one hop of an arbitrage chain from the next when several
  // hops move identical amounts.
  type Swap = { sides: [bigint, bigint]; used: [boolean, boolean]; logIndex: number };
  const swapsByTx = new Map<string, Swap[]>();
  for (const l of swapLogs) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: poolManagerAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    } catch {
      continue;
    }
    const a = decoded.args as { amount0: bigint; amount1: bigint };
    const abs = (v: bigint) => (v < 0n ? -v : v);
    const list = swapsByTx.get(l.transactionHash) ?? [];
    list.push({ sides: [abs(a.amount0), abs(a.amount1)], used: [false, false], logIndex: l.logIndex });
    swapsByTx.set(l.transactionHash, list);
  }

  const pm = ADDR.poolManager;
  const byTx = new Map<string, RawLog[]>();
  for (const l of transferLogs) {
    if (l.topics.length < 3 || l.data === "0x") continue;
    const list = byTx.get(l.transactionHash) ?? [];
    list.push(l);
    byTx.set(l.transactionHash, list);
  }

  type Leg = { log: RawLog; wallet: string; tokens: bigint; kind: "buy" | "sell"; infra: boolean; token: string; taken: boolean };
  const rows: Row[] = [];
  for (const [tx, transfers] of byTx) {
    const swaps = (swapsByTx.get(tx) ?? []).sort((a, b) => a.logIndex - b.logIndex);
    if (swaps.length === 0) continue;
    const legs: Leg[] = [];
    for (const l of transfers) {
      const from = ("0x" + (l.topics[1] as string).slice(26)).toLowerCase();
      const to = ("0x" + (l.topics[2] as string).slice(26)).toLowerCase();
      const kind: "buy" | "sell" | null = to === pm ? "sell" : from === pm ? "buy" : null;
      if (!kind) continue;
      const token = l.address.toLowerCase();
      const wallet = kind === "sell" ? from : to;
      const tokens = BigInt(l.data);
      if (tokens === 0n) continue;
      // WETH legs and protocol legs are the trade's bookkeeping: they
      // claim a swap side so the real legs match the right one, but they
      // never become a position
      legs.push({ log: l, wallet, tokens, kind, infra: INFRA.has(wallet) || token === ADDR.weth, token, taken: false });
    }
    if (legs.length === 0) continue;
    legs.sort((a, b) => a.log.logIndex - b.log.logIndex);

    const emit = (leg: Leg, quote: bigint) => {
      leg.taken = true;
      if (leg.infra || quote === 0n) return;
      rows.push({ block: leg.log.blockNumber, logIndex: leg.log.logIndex, tx, curve: "", wallet: leg.wallet, kind: leg.kind, tokens: leg.tokens, eth: quote, token: leg.token });
    };

    // Walk swaps in log order. For each side, take the nearest unclaimed
    // leg with that exact amount - nearest in the log is the leg that
    // belongs to this hop.
    for (const sw of swaps) {
      for (const side of [0, 1] as const) {
        if (sw.used[side]) continue;
        const want = sw.sides[side];
        const other = sw.sides[side === 0 ? 1 : 0];
        if (want === 0n) continue;
        let best: Leg | null = null;
        let bestDist = Infinity;
        for (const leg of legs) {
          if (leg.taken || leg.tokens !== want) continue;
          const dist = Math.abs(leg.log.logIndex - sw.logIndex);
          if (dist < bestDist) {
            best = leg;
            bestDist = dist;
          }
        }
        if (!best) continue;
        sw.used[side] = true;
        emit(best, other);
      }
    }

    // Legs that carried a protocol fee: the swap side is the sum of the
    // wallet leg and the fee leg beside it, and the quote splits pro rata.
    for (const sw of swaps) {
      for (const side of [0, 1] as const) {
        if (sw.used[side]) continue;
        const want = sw.sides[side];
        const other = sw.sides[side === 0 ? 1 : 0];
        if (want === 0n || other === 0n) continue;
        const groups = new Map<string, Leg[]>();
        for (const leg of legs) {
          if (leg.taken) continue;
          const key = `${leg.token}|${leg.kind}`;
          const g = groups.get(key) ?? [];
          g.push(leg);
          groups.set(key, g);
        }
        let hit: Leg[] | null = null;
        for (const g of groups.values()) {
          if (g.reduce((sum, x) => sum + x.tokens, 0n) === want) {
            hit = g;
            break;
          }
        }
        if (!hit) continue;
        sw.used[side] = true;
        const total = hit.reduce((sum, x) => sum + x.tokens, 0n);
        for (const leg of hit) emit(leg, (other * leg.tokens) / total);
      }
    }

    // Trades that take their cut off the incoming side leave the leg a
    // few percent above the swap's side; accept the nearest such leg.
    for (const sw of swaps) {
      for (const side of [0, 1] as const) {
        if (sw.used[side]) continue;
        const want = sw.sides[side];
        const other = sw.sides[side === 0 ? 1 : 0];
        if (want === 0n || other === 0n) continue;
        let best: Leg | null = null;
        let bestDist = Infinity;
        for (const leg of legs) {
          if (leg.taken || leg.infra) continue;
          const diff = leg.tokens > want ? leg.tokens - want : want - leg.tokens;
          if ((diff * 100n) / (leg.tokens === 0n ? 1n : leg.tokens) > 5n) continue;
          const dist = Math.abs(leg.log.logIndex - sw.logIndex);
          if (dist < bestDist) {
            best = leg;
            bestDist = dist;
          }
        }
        if (!best) continue;
        sw.used[side] = true;
        emit(best, other);
      }
    }
  }
  return rows;
}

async function fetchWindowV4(client: PublicClient, fromBlock: bigint, toBlock: bigint, onSplit?: () => void): Promise<Row[]> {
  // A range whose buys are already indexed (the fee-leg repair covered
  // them) only needs the sell side, which drops a third of the traffic.
  const sellsOnly = !!process.env.XRAY_V4_SELLS_ONLY;
  const [toPm, fromPm, swaps] = await Promise.all([
    getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, null, PM_PADDED], fromBlock, toBlock }, { parallel: 1, onSplit }),
    sellsOnly
      ? Promise.resolve([] as RawLog[])
      : getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, PM_PADDED], fromBlock, toBlock }, { parallel: 1, onSplit }),
    getLogsAdaptive(client, { address: ADDR.poolManager as Hex, topics: [SWAP_TOPIC as Hex], fromBlock, toBlock }, { parallel: 1, onSplit }),
  ]);
  return decodeV4Rows(toPm.concat(fromPm), swaps);
}

const laneFetch = { curve: fetchWindow, v4: fetchWindowV4 } as const;
const laneWindow = { curve: WINDOW, v4: WINDOW_V4 } as const;

/** Catch a lane up from its tip to the chain head. Cheap; run before profiles. */
export async function syncTradeIndexTail(client: PublicClient, cache: Cache, lane: Lane = "curve"): Promise<void> {
  const span = cache.tradeIndexSpan(lane);
  const latest = await client.getBlockNumber();
  if (!span) {
    // first contact: an empty span at the head; backfill grows it downward
    cache.setTradeIndexSpan(latest + 1n, latest, lane);
    return;
  }
  const fetch = laneFetch[lane];
  const win = laneWindow[lane];
  let tip = span.tip;
  while (tip < latest) {
    // a few windows in flight: a stale tail (a server that slept) catches
    // up in seconds instead of minutes, one window at a time
    const jobs: { from: bigint; to: bigint }[] = [];
    let cursor = tip;
    for (let i = 0; i < PARALLEL && cursor < latest; i++) {
      const to = cursor + win > latest ? latest : cursor + win;
      jobs.push({ from: cursor + 1n, to });
      cursor = to;
    }
    const parts = await Promise.all(jobs.map((j) => fetch(client, j.from, j.to)));
    for (const rows of parts) {
      if (rows.length) cache.appendChainTrades(rows);
    }
    tip = cursor;
    cache.setTradeIndexSpan(span.floor, tip, lane);
  }
}

export interface BackfillProgress {
  floor: bigint;
  tip: bigint;
  rows: number;
  done: boolean;
}

/**
 * Extend the index downward toward genesis. Resumable: progress persists
 * every batch. Empty windows (before the launchpad existed) grow the
 * step so the desert costs ~a hundred requests, not thousands.
 */
export async function backfillTradeIndex(
  client: PublicClient,
  cache: Cache,
  opts: { budgetMs?: number; onProgress?: (p: BackfillProgress) => void; lane?: Lane; stopFloor?: bigint } = {},
): Promise<BackfillProgress> {
  const lane = opts.lane ?? "curve";
  const stopFloor = opts.stopFloor ?? 0n;
  const fetch = laneFetch[lane];
  await syncTradeIndexTail(client, cache, lane);
  const stopAt = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  let { floor, tip } = cache.tradeIndexSpan(lane)!;
  let window: bigint = laneWindow[lane];
  let emptyStreak = 0;
  let total = 0;
  while (floor > stopFloor && Date.now() < stopAt) {
    // PARALLEL adjacent windows below the floor, fetched concurrently
    const jobs: { from: bigint; to: bigint }[] = [];
    let cursor = floor;
    for (let i = 0; i < PARALLEL && cursor > stopFloor; i++) {
      const from = cursor - window > stopFloor ? cursor - window : stopFloor;
      jobs.push({ from, to: cursor - 1n });
      cursor = from;
    }
    await yieldToScans(); // a visitor's scan owns the node while it runs
    let parts: Row[][];
    let splits = 0;
    try {
      parts = await Promise.all(jobs.map((j) => fetch(client, j.from, j.to, () => splits++)));
    } catch (err) {
      // a 403 ban or node hiccup: cool off and try the same batch again
      // instead of dying with hours of progress left on the table
      console.error(`\nindex batch failed (${err instanceof Error ? err.message.slice(0, 80) : err}); cooling off ${ERROR_COOLDOWN_MS / 1000}s`);
      await sleep(ERROR_COOLDOWN_MS);
      continue;
    }
    let batchRows = 0;
    for (const rows of parts) {
      if (rows.length) cache.appendChainTrades(rows);
      batchRows += rows.length;
    }
    total += batchRows;
    floor = cursor;
    cache.setTradeIndexSpan(floor, tip, lane);
    if (BATCH_DELAY_MS > 0) await sleep(BATCH_DELAY_MS);
    // splits mean the window overshot the node's 10k-log cap and cost
    // three requests instead of one; a clean pass means it can grow
    if (splits > 0) {
      emptyStreak = 0;
      const half = window / 2n;
      window = half < 250n ? 250n : half;
    } else if (batchRows < 5000) {
      emptyStreak++;
      if (emptyStreak >= 2 && window < WINDOW_MAX) window *= 2n;
    } else {
      emptyStreak = 0;
      if (window < WINDOW_MAX) window = (window * 5n) / 4n;
    }

    opts.onProgress?.({ floor, tip, rows: total, done: floor <= stopFloor });
  }
  return { floor, tip, rows: total, done: floor <= stopFloor };
}

/** How many days of history a lane currently holds, tip to floor. */
export function tradeIndexDepthDays(cache: Cache, lane: Lane = "curve"): number | null {
  const span = cache.tradeIndexSpan(lane);
  if (!span || span.tip <= span.floor) return null;
  return Number(span.tip - span.floor) / Number(CHAIN.blocksPerDay);
}
