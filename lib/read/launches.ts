import { decodeEventLog, toEventSelector } from "viem";
import { ADDR, type Hex } from "../chain.ts";
import { factoryAbi } from "../abi/pons.ts";
import type { Cache } from "../cache.ts";
import { erc20Abi } from "../abi/erc20.ts";
import { getLogsAdaptive } from "../providers/logs.ts";
import type { PublicClient } from "viem";

/**
 * Ticker lookup (mode A): an incremental SQLite index of factory launches.
 * The first ticker query scans TokenLaunched logs from the last indexed
 * block to the tip; later queries only extend it. Address queries never
 * touch this. Tickers are not unique - the caller gets every match.
 */

const tokenLaunchedTopic = toEventSelector(
  "TokenLaunched(address,address,address,address,uint256,uint256)",
);

export interface TickerMatch {
  token: string;
  symbol: string;
  curve: string;
  block: bigint;
}

/** Bring the launch index up to the chain head. Also fills the
 * curve -> token map every profile build leans on, so a synced launch
 * index means zero RPC round-trips to resolve curves. */
export async function syncLaunches(client: PublicClient, cache: Cache): Promise<void> {
  const latest = await client.getBlockNumber();
  const tip = cache.launchesTip();
  if (tip < latest) {
    const logs = await getLogsAdaptive(client, {
      address: ADDR.factory as Hex,
      topics: [tokenLaunchedTopic as Hex],
      fromBlock: tip === 0n ? 0n : tip + 1n,
      toBlock: latest,
    });
    const rows: { block: bigint; token: string; symbol: string; curve: string }[] = [];
    // symbols are not in the event; read them in one multicall batch
    const decoded = logs.map((l) => {
      const d = decodeEventLog({ abi: factoryAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      const args = d.args as unknown as { token: Hex; curve: Hex };
      return { block: l.blockNumber, token: args.token.toLowerCase(), curve: args.curve.toLowerCase() };
    });
    const chunk = 500;
    for (let i = 0; i < decoded.length; i += chunk) {
      const slice = decoded.slice(i, i + chunk);
      const res = await client.multicall({
        contracts: slice.map((d) => ({
          address: d.token as Hex,
          abi: erc20Abi,
          functionName: "symbol" as const,
        })),
        allowFailure: true,
        batchSize: 200_000,
      });
      res.forEach((r, j) => {
        const d = slice[j]!;
        rows.push({
          block: d.block,
          token: d.token,
          symbol: r.status === "success" ? (r.result as string) : "?",
          curve: d.curve,
        });
      });
    }
    cache.appendLaunches(rows, latest);
  }
}

export async function resolveTicker(
  client: PublicClient,
  cache: Cache,
  symbol: string,
): Promise<TickerMatch[]> {
  await syncLaunches(client, cache);
  return cache.findTicker(symbol);
}

export function looksLikeAddress(q: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(q);
}
