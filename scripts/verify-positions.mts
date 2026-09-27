/**
 * Folded positions against the trades they came from, for one token:
 * every wallet's four sums must match what its trades add up to.
 *
 *   npx tsx scripts/verify-positions.mts <token address>
 */
import { Cache } from "../lib/cache.ts";
import { RpcProvider } from "../lib/providers/rpc.ts";

const token = process.argv[2]!;
const cache = new Cache();
const rpc = new RpcProvider();
const meta = await rpc.tokenMeta(token as `0x${string}`);

let t = Date.now();
const folded = cache.marketPositions(meta.address, meta.curve);
const foldedMs = Date.now() - t;

t = Date.now();
const trades = cache.tokenTradesFromIndex(meta.address, meta.curve);
const rawMs = Date.now() - t;

const raw = new Map<string, { bt: number; be: number; st: number; se: number; n: number }>();
for (const tr of trades) {
  const cur = raw.get(tr.wallet) ?? { bt: 0, be: 0, st: 0, se: 0, n: 0 };
  if (tr.kind === "buy") {
    cur.bt += Number(tr.tokens);
    cur.be += Number(tr.eth);
  } else {
    cur.st += Number(tr.tokens);
    cur.se += Number(tr.eth);
  }
  cur.n++;
  raw.set(tr.wallet, cur);
}

console.log(`folded ${folded.size} wallets in ${foldedMs}ms; raw ${trades.length} trades, ${raw.size} wallets in ${rawMs}ms`);

const near = (a: number, b: number) => (a === b ? true : Math.abs(a - b) <= Math.max(1, Math.abs(a) * 1e-9));
let mismatched = 0;
let missing = 0;
for (const [w, r] of raw) {
  const f = folded.get(w);
  if (!f) {
    missing++;
    continue;
  }
  if (!near(f.buyTokens, r.bt) || !near(f.buyEth, r.be) || !near(f.sellTokens, r.st) || !near(f.sellEth, r.se) || f.trades !== r.n) {
    if (mismatched < 5) {
      console.log(`  ${w}: folded ${f.buyTokens}/${f.buyEth}/${f.sellTokens}/${f.sellEth} n=${f.trades}`);
      console.log(`  ${" ".repeat(w.length)}  raw    ${r.bt}/${r.be}/${r.st}/${r.se} n=${r.n}`);
    }
    mismatched++;
  }
}
const extra = [...folded.keys()].filter((w) => !raw.has(w)).length;
console.log(`missing from folded: ${missing}, mismatched: ${mismatched}, only in folded: ${extra}`);
console.log(mismatched === 0 && missing === 0 && extra === 0 ? "MATCH" : "DIFFERS");
cache.close();

