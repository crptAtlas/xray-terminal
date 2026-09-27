#!/usr/bin/env node
// Snapshot a live token into an offline fixture for tests and `demo`:
// meta + raw transfers + quotes + balances, JSON with bigints as strings.
// Usage: tsx scripts/snapshot-fixture.mjs <token> <outdir>

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RpcProvider } from "../lib/providers/rpc.ts";
import { classify } from "../lib/pnl/classify.ts";
import { marketSet, infraSet } from "../lib/read/token.ts";

const [token, outdir] = process.argv.slice(2);
if (!token || !outdir) {
  console.error("usage: tsx scripts/snapshot-fixture.mjs <token> <outdir>");
  process.exit(1);
}

const provider = new RpcProvider();
const meta = await provider.tokenMeta(token.toLowerCase());
const activity = await provider.activity(meta, meta.createdBlock);
const { trades, transfersIn } = classify(activity.transfers, activity.quotes, marketSet(meta));

const wallets = new Set();
for (const t of trades) wallets.add(t.wallet);
for (const t of transfersIn) wallets.add(t.wallet);
const infra = infraSet(meta);
const candidates = [...wallets].filter((w) => !infra.has(w));
const balances = await provider.balances(meta, candidates);
const priceEth = await provider.priceNowEth(meta);
const liquidityWei = await provider.liquidityEth(meta);

const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
mkdirSync(outdir, { recursive: true });
writeFileSync(join(outdir, "meta.json"), json({ ...meta, snappedAt: Date.now(), priceEth, liquidityWei }));
writeFileSync(join(outdir, "transfers.json"), json(activity.transfers));
writeFileSync(join(outdir, "quotes.json"), json(activity.quotes));
writeFileSync(join(outdir, "balances.json"), json([...balances.entries()]));
console.log(
  `${meta.symbol}: ${activity.transfers.length} transfers, ${activity.quotes.length} quotes, ${candidates.length} wallets -> ${outdir}`,
);

