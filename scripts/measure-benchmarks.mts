/**
 * What a number means on this chain. Samples wallets from the folded
 * positions and reports the quartiles of their record, for both winrate
 * definitions: over every position and over the ones they exited. The
 * benchmarks in lib/grade.ts come from this, not from a guess.
 *
 *   npx tsx scripts/measure-benchmarks.mts [wallets]
 */
import { Cache } from "../lib/cache.ts";

const sampleSize = Number(process.argv[2] ?? 20_000);
const cache = new Cache();
const db = (cache as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;

const wallets = (
  db
    .prepare(
      `SELECT wallet FROM wallet_positions GROUP BY wallet HAVING COUNT(*) >= 2 ORDER BY RANDOM() LIMIT ${sampleSize}`,
    )
    .all() as { wallet: string }[]
).map((r) => r.wallet);
console.log(`sampled ${wallets.length} wallets with two or more positions`);

const avg: number[] = [];
const wrAll: number[] = [];
const wrClosed: number[] = [];
const CHUNK = 500;
for (let i = 0; i < wallets.length; i += CHUNK) {
  const stats = cache.profileStats(wallets.slice(i, i + CHUNK));
  for (const s of stats.values()) {
    const f = s.full;
    if (f.taken < 2) continue;
    avg.push(f.pnlPctSum / f.taken);
    wrAll.push((f.wins / (f.taken + 1)) * 100);
    if (f.closed >= 2) wrClosed.push((f.winsClosed / (f.closed + 1)) * 100);
  }
}

const q = (xs: number[], p: number): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
};
const line = (name: string, xs: number[]) =>
  console.log(
    `${name.padEnd(22)} n=${String(xs.length).padStart(6)}  p25 ${q(xs, 0.25).toFixed(1)}  median ${q(xs, 0.5).toFixed(1)}  p75 ${q(xs, 0.75).toFixed(1)}  p90 ${q(xs, 0.9).toFixed(1)}`,
  );

line("avg pnl per position", avg);
line("winrate all positions", wrAll);
line("winrate closed only", wrClosed);
cache.close();
