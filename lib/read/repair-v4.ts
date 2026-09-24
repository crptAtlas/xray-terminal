import type { PublicClient } from "viem";
import { ADDR, TOPIC, type Hex } from "../chain.ts";
import { SWAP_TOPIC } from "../abi/pool.ts";
import { getLogsAdaptive } from "../providers/logs.ts";
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

/** Rows added plus how many adaptive splits the window needed: the
 * caller shrinks its window when splits happen and grows it when none
 * do, so the swap sweep stays under the node's 10k cap with one request. */
export async function repairWindow(client: PublicClient, cache: Cache, fromBlock: bigint, toBlock: bigint): Promise<{ rows: number; splits: number }> {
  let splits = 0;
  const onSplit = () => splits++;
  // fee legs are the cheap key: every dropped buy carried one
  const fees = await getLogsAdaptive(client, { topics: [TOPIC.transfer as Hex, PM_PADDED, HOOK_PADDED], fromBlock, toBlock }, { parallel: 1, onSplit });
  if (fees.length === 0) return { rows: 0, splits };
  const txs = new Set(fees.map((l) => l.transactionHash));
  const tokens = [...new Set(fees.map((l) => l.address.toLowerCase()))];
  // transfers only of the fee-bearing tokens (address-filtered: half the
  // cost of a sweep). Swaps stay a full sweep: stock-paired launches route
  // through a second pool in the same tx, so a pool-id filter derived
  // from the token alone would drop ~17% of the quotes.
  const [fromPm, swaps] = await Promise.all([
    getLogsAdaptive(client, { address: tokens as Hex[], topics: [TOPIC.transfer as Hex, PM_PADDED], fromBlock, toBlock }, { parallel: 1, onSplit }),
    getLogsAdaptive(client, { address: ADDR.poolManager as Hex, topics: [SWAP_TOPIC as Hex], fromBlock, toBlock }, { parallel: 1, onSplit }),
  ]);
  const transfers = fromPm.filter((l) => txs.has(l.transactionHash));
  const sw = swaps.filter((l) => txs.has(l.transactionHash));
  const rows = decodeV4Rows(transfers, sw);
  if (rows.length) cache.appendChainTrades(rows);
  return { rows: rows.length, splits };
}
