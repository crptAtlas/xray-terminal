import { decodeEventLog, type PublicClient } from "viem";
import { ADDR, CHAIN, INFRA, TOPIC, type Hex } from "../chain.ts";
import { curveAbi } from "../abi/pons.ts";
import { poolManagerAbi, SWAP_TOPIC } from "../abi/pool.ts";
import { getLogsAdaptive, type RawLog } from "../providers/logs.ts";
import type { Cache } from "../cache.ts";

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
const WINDOW_V4 = 3_000n;
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

async function fetchWindow(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<Row[]> {
  const logs = await getLogsAdaptive(
    client,
    { topics: [[TOPIC.curveBuy as Hex, TOPIC.curveSell as Hex]], fromBlock, toBlock },
    { parallel: 1 },
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
  // tx -> list of |amount0|,|amount1| pairs from its swaps
  const swapsByTx = new Map<string, { a0: bigint; a1: bigint }[]>();
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
    list.push({ a0: abs(a.amount0), a1: abs(a.amount1) });
    swapsByTx.set(l.transactionHash, list);
  }
  const rows: Row[] = [];
  for (const l of transferLogs) {
    if (l.topics.length < 3 || l.data === "0x") continue;
    const from = ("0x" + (l.topics[1] as string).slice(26)).toLowerCase();
    const to = ("0x" + (l.topics[2] as string).slice(26)).toLowerCase();
    const pm = ADDR.poolManager;
    const kind: "buy" | "sell" | null = to === pm ? "sell" : from === pm ? "buy" : null;
    if (!kind) continue;
    const wallet = kind === "sell" ? from : to;
    if (INFRA.has(wallet)) continue; // liquidity moves, not trades
    const tokens = BigInt(l.data);
    if (tokens === 0n) continue;
    // the swap whose token side equals the moved amount carries the quote
    const swaps = swapsByTx.get(l.transactionHash);
    if (!swaps) continue;
    let eth: bigint | null = null;
    for (const s of swaps) {
      if (s.a0 === tokens) { eth = s.a1; break; }
      if (s.a1 === tokens) { eth = s.a0; break; }
    }
    if (eth === null || eth === 0n) continue; // no matching swap: not a simple trade
    rows.push({
      block: l.blockNumber,
      logIndex: l.logIndex,
      tx: l.transactionHash,
      curve: "",
      wallet,
      kind,
      tokens,
      eth,
      token: l.address.toLowerCase(),
    });
  }
  return rows;
}

async function fetchWindowV4(client: PublicClient, fromBlock: bigint, toBlock: bigint): Promise<Row[]> {
  const [toPm, fromPm, swaps] = await Promise.all([
    getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, null, PM_PADDED], fromBlock, toBlock }, { parallel: 1 }),
    getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, PM_PADDED], fromBlock, toBlock }, { parallel: 1 }),
    getLogsAdaptive(client, { address: ADDR.poolManager as Hex, topics: [SWAP_TOPIC as Hex], fromBlock, toBlock }, { parallel: 1 }),
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
  opts: { budgetMs?: number; onProgress?: (p: BackfillProgress) => void; lane?: Lane } = {},
): Promise<BackfillProgress> {
  const lane = opts.lane ?? "curve";
  const fetch = laneFetch[lane];
  await syncTradeIndexTail(client, cache, lane);
  const stopAt = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  let { floor, tip } = cache.tradeIndexSpan(lane)!;
  let window = laneWindow[lane];
  let emptyStreak = 0;
  let total = 0;
  while (floor > 0n && Date.now() < stopAt) {
    // PARALLEL adjacent windows below the floor, fetched concurrently
    const jobs: { from: bigint; to: bigint }[] = [];
    let cursor = floor;
    for (let i = 0; i < PARALLEL && cursor > 0n; i++) {
      const from = cursor > window ? cursor - window : 0n;
      jobs.push({ from, to: cursor - 1n });
      cursor = from;
    }
    let parts: Row[][];
    try {
      parts = await Promise.all(jobs.map((j) => fetch(client, j.from, j.to)));
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
    if (batchRows === 0) {
      emptyStreak++;
      if (emptyStreak >= 2 && window < WINDOW_MAX) window *= 2n;
    } else {
      emptyStreak = 0;
      window = laneWindow[lane];
    }
    opts.onProgress?.({ floor, tip, rows: total, done: floor === 0n });
  }
  return { floor, tip, rows: total, done: floor === 0n };
}

/** How many days of history a lane currently holds, tip to floor. */
export function tradeIndexDepthDays(cache: Cache, lane: Lane = "curve"): number | null {
  const span = cache.tradeIndexSpan(lane);
  if (!span || span.tip <= span.floor) return null;
  return Number(span.tip - span.floor) / Number(CHAIN.blocksPerDay);
}
