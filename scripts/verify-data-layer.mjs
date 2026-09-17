#!/usr/bin/env node
// Trial checks 3 and 4 from the data-layer plan: trader attribution and
// mode A / mode B convergence. Run: tsx scripts/verify-data-layer.mjs <token>
import { RpcProvider } from "../lib/providers/rpc.ts";
import { BitqueryProvider } from "../lib/providers/bitquery.ts";
import { Cache } from "../lib/cache.ts";
import { classify } from "../lib/pnl/classify.ts";
import { marketSet } from "../lib/read/token.ts";

const token = (process.argv[2] ?? "0xdb90169c179def9111ad7ae8e23f45cc36a0da7b").toLowerCase();
const rpc = new RpcProvider();
const bq = new BitqueryProvider({ rpc });
const cache = new Cache(":memory:");

// --- convergence: the same token through both providers ---
const meta = await rpc.tokenMeta(token);
const [a, b] = [await rpc.activity(meta, meta.createdBlock), await bq.activity(meta, meta.createdBlock)];
const market = marketSet(meta);
const ca = classify(a.transfers, a.quotes, market);
const cb = classify(b.transfers, b.quotes, market);
const book = (trades) => {
  const m = new Map();
  for (const t of trades) {
    const e = m.get(t.wallet) ?? { buys: 0n, cost: 0n, sells: 0n, proceeds: 0n };
    if (t.kind === "buy") { e.buys += t.tokens; e.cost += t.eth; } else { e.sells += t.tokens; e.proceeds += t.eth; }
    m.set(t.wallet, e);
  }
  return m;
};
const ba = book(ca.trades);
const bb = book(cb.trades);
console.log(`trades: rpc ${ca.trades.length} vs bitquery ${cb.trades.length}; wallets: ${ba.size} vs ${bb.size}`);
let checked = 0, matched = 0, mismatches = [];
for (const [w, ea] of ba) {
  const eb = bb.get(w);
  if (!eb) { mismatches.push([w, "missing in bitquery"]); continue; }
  checked++;
  const close = (x, y) => x === y || (x > 0n && y > 0n && (x > y ? x - y : y - x) * 1000n < (x > y ? x : y));
  if (close(ea.cost, eb.cost) && close(ea.proceeds, eb.proceeds) && close(ea.buys, eb.buys)) matched++;
  else mismatches.push([w, `cost ${ea.cost}/${eb.cost} proceeds ${ea.proceeds}/${eb.proceeds}`]);
}
console.log(`wallet books matched: ${matched}/${checked} (0.1% tolerance)`);
for (const [w, why] of mismatches.slice(0, 5)) console.log("  mismatch", w.slice(0, 12), why);

// --- attribution: pick 3 relayed buys from the RPC truth and confirm the
// bitquery-side transfer names the same trader wallet ---
const sample = ca.trades.filter((t) => t.kind === "buy").slice(0, 3);
for (const t of sample) {
  const inB = cb.trades.find((x) => x.tx === t.tx && x.wallet === t.wallet && x.kind === "buy");
  console.log(`attribution ${t.tx.slice(0, 14)} buyer ${t.wallet.slice(0, 12)}: ${inB ? "MATCH" : "MISSING"}`);
}
cache.close();
console.log("bitquery requests spent:", bq.stats());
