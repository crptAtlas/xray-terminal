import type { PublicClient } from "viem";
import { ADDR, TOPIC, type Hex } from "../chain.ts";
import { SWAP_TOPIC } from "../abi/pool.ts";
import { getLogsAdaptive, type RawLog } from "../providers/logs.ts";
import { decodeV4Rows } from "./indexer.ts";
import type { Cache } from "../cache.ts";

/**
 * Repair pass for v4 buys the first decoder dropped: every such buy
 * carried a fee leg poolManager -> hook in its tx. The hook is one
 * address, so the fee legs are a narrow topic query; their tx hashes
 * name exactly the transactions to re-decode. Per window: fee legs ->
 * tx set -> all pool transfers and swaps in the window -> re-decode
 * only those txs -> INSERT OR IGNORE (rows already present are kept).
 */

const PM_PADDED = `0x000000000000000000000000${ADDR.poolManager.slice(2)}` as Hex;
const HOOK_PADDED = `0x000000000000000000000000${ADDR.hook.slice(2)}` as Hex;

export async function repairWindow(client: PublicClient, cache: Cache, fromBlock: bigint, toBlock: bigint): Promise<number> {
  const fees = await getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, PM_PADDED, HOOK_PADDED], fromBlock, toBlock }, { parallel: 1 });
  if (fees.length === 0) return 0;
  const txs = new Set(fees.map((l) => l.transactionHash));
  // a dropped buy is poolManager -> wallet with a fee leg beside it, so
  // only the pm -> * transfers and the swaps matter; the fee blocks are
  // a small subset of the window, so both queries run over exactly the
  // block spans that carry fees (merged into runs to keep requests few)
  const blocks = [...new Set(fees.map((l) => l.blockNumber))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const runs: { a: bigint; b: bigint }[] = [];
  for (const bn of blocks) {
    const last = runs[runs.length - 1];
    if (last && bn - last.b <= 50n) last.b = bn;
    else runs.push({ a: bn, b: bn });
  }
  const fromPm: RawLog[] = [];
  const swaps: RawLog[] = [];
  for (const r of runs) {
    const [f, s] = await Promise.all([
      getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, PM_PADDED], fromBlock: r.a, toBlock: r.b }, { parallel: 1 }),
      getLogsAdaptive(client, { address: ADDR.poolManager as Hex, topics: [SWAP_TOPIC as Hex], fromBlock: r.a, toBlock: r.b }, { parallel: 1 }),
    ]);
    fromPm.push(...f);
    swaps.push(...s);
  }
  const transfers = fromPm.filter((l) => txs.has(l.transactionHash));
  const sw = swaps.filter((l) => txs.has(l.transactionHash));
  const rows = decodeV4Rows(transfers, sw);
  if (rows.length) cache.appendChainTrades(rows);
  return rows.length;
}
