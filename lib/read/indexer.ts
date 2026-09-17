import { decodeEventLog, type PublicClient } from "viem";
import { CHAIN, TOPIC, type Hex } from "../chain.ts";
import { curveAbi } from "../abi/pons.ts";
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
const WINDOW_MAX = 640_000n; // empty pre-launchpad desert: grow up to this
const PARALLEL = 3;

type Row = {
  block: bigint;
  logIndex: number;
  tx: string;
  curve: string;
  wallet: string;
  kind: "buy" | "sell";
  tokens: bigint;
  eth: bigint;
};

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

/** Catch the index up from its tip to the chain head. Cheap; run before profiles. */
export async function syncTradeIndexTail(client: PublicClient, cache: Cache): Promise<void> {
  const span = cache.tradeIndexSpan();
  const latest = await client.getBlockNumber();
  if (!span) {
    // first contact: an empty span at the head; backfill grows it downward
    cache.setTradeIndexSpan(latest + 1n, latest);
    return;
  }
  let tip = span.tip;
  while (tip < latest) {
    const to = tip + WINDOW > latest ? latest : tip + WINDOW;
    const rows = await fetchWindow(client, tip + 1n, to);
    if (rows.length) cache.appendChainTrades(rows);
    tip = to;
    cache.setTradeIndexSpan(span.floor, tip);
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
  opts: { budgetMs?: number; onProgress?: (p: BackfillProgress) => void } = {},
): Promise<BackfillProgress> {
  await syncTradeIndexTail(client, cache);
  const stopAt = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  let { floor, tip } = cache.tradeIndexSpan()!;
  let window = WINDOW;
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
    const parts = await Promise.all(jobs.map((j) => fetchWindow(client, j.from, j.to)));
    let batchRows = 0;
    for (const rows of parts) {
      if (rows.length) cache.appendChainTrades(rows);
      batchRows += rows.length;
    }
    total += batchRows;
    floor = cursor;
    cache.setTradeIndexSpan(floor, tip);
    if (batchRows === 0) {
      emptyStreak++;
      if (emptyStreak >= 2 && window < WINDOW_MAX) window *= 2n;
    } else {
      emptyStreak = 0;
      window = WINDOW;
    }
    opts.onProgress?.({ floor, tip, rows: total, done: floor === 0n });
  }
  return { floor, tip, rows: total, done: floor === 0n };
}

/** How many days of history the index currently holds, tip to floor. */
export function tradeIndexDepthDays(cache: Cache): number | null {
  const span = cache.tradeIndexSpan();
  if (!span || span.tip <= span.floor) return null;
  return Number(span.tip - span.floor) / Number(CHAIN.blocksPerDay);
}
