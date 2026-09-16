import type { PublicClient } from "viem";
import { GETLOGS_MAX } from "../chain.ts";

/**
 * eth_getLogs with adaptive windowing. The public RPC truncates responses at
 * 10,000 logs without an error and rejects some wide ranges outright. So:
 * split the range in half recursively when the node complains OR when a
 * window comes back suspiciously full (>= GETLOGS_MAX means truncation).
 */

export interface LogQuery {
  address?: `0x${string}` | `0x${string}`[];
  topics?: (`0x${string}` | `0x${string}`[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

type RawLog = {
  address: `0x${string}`;
  topics: `0x${string}`[];
  data: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
};

function isRangeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes("too many") ||
    msg.includes("limit") ||
    msg.includes("range") ||
    msg.includes("timeout") ||
    msg.includes("deadline exceeded") ||
    msg.includes("response size")
  );
}

async function fetchWindow(client: PublicClient, q: LogQuery): Promise<RawLog[]> {
  const logs = await client.request({
    method: "eth_getLogs",
    params: [
      {
        address: q.address,
        topics: q.topics,
        fromBlock: `0x${q.fromBlock.toString(16)}`,
        toBlock: `0x${q.toBlock.toString(16)}`,
      },
    ],
  }) as unknown as {
    address: `0x${string}`;
    topics: `0x${string}`[];
    data: `0x${string}`;
    blockNumber: `0x${string}`;
    transactionHash: `0x${string}`;
    logIndex: `0x${string}`;
  }[];
  return logs.map((l) => ({
    address: l.address.toLowerCase() as `0x${string}`,
    topics: l.topics,
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    transactionHash: l.transactionHash,
    logIndex: Number(l.logIndex),
  }));
}

export async function getLogsAdaptive(
  client: PublicClient,
  q: LogQuery,
  opts: { parallel?: number } = {},
): Promise<RawLog[]> {
  const parallel = opts.parallel ?? 6;

  async function walk(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    try {
      const logs = await fetchWindow(client, { ...q, fromBlock, toBlock });
      if (logs.length >= GETLOGS_MAX && toBlock > fromBlock) {
        return split(fromBlock, toBlock);
      }
      return logs;
    } catch (err) {
      if (isRangeError(err) && toBlock > fromBlock) return split(fromBlock, toBlock);
      throw err;
    }
  }

  async function split(fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    const mid = fromBlock + (toBlock - fromBlock) / 2n;
    const [a, b] = await Promise.all([walk(fromBlock, mid), walk(mid + 1n, toBlock)]);
    return a.concat(b);
  }

  // Pre-split the full range into `parallel` slices so windows read
  // concurrently; each slice still adapts on its own.
  const total = q.toBlock - q.fromBlock + 1n;
  const n = total > BigInt(parallel) ? BigInt(parallel) : 1n;
  const step = total / n;
  const slices: Promise<RawLog[]>[] = [];
  for (let i = 0n; i < n; i++) {
    const from = q.fromBlock + i * step;
    const to = i === n - 1n ? q.toBlock : from + step - 1n;
    slices.push(walk(from, to));
  }
  const parts = await Promise.all(slices);
  const all = parts.flat();
  all.sort((x, y) =>
    x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1,
  );
  return all;
}

export type { RawLog };
