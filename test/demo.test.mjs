import { test } from "node:test";
import assert from "node:assert/strict";
import { FixtureProvider } from "../lib/demo.ts";
import { Cache } from "../lib/cache.ts";
import { check } from "../lib/check.ts";
import { formatCheck } from "../lib/format.ts";

process.env.ETH_USD = "2400"; // keep the pipeline offline

async function runFixture(dir) {
  const provider = new FixtureProvider(dir);
  const cache = new Cache(":memory:");
  const meta = await provider.tokenMeta("0x0");
  const phases = [];
  for await (const p of check(provider, cache, meta.address)) phases.push(p);
  cache.close();
  return phases;
}

test("full pipeline on the graduated fixture is deterministic and offline", async () => {
  const phases = await runFixture("graduated-token");
  assert.equal(phases.length, 1); // fixtures are rpc-shaped: no profile phase
  const p1 = phases[0];
  assert.equal(p1.phase, 1);
  assert.equal(p1.snapshot.meta.symbol, "CAPITOL");
  assert.equal(p1.snapshot.meta.phase.kind, "graduated");
  assert.ok(p1.snapshot.holders.length > 100, `holders ${p1.snapshot.holders.length}`);
  assert.ok(p1.groups.length >= 1 && p1.groups.length <= 3);
  for (const g of p1.groups) assert.ok(g.maxPct - g.minPct <= 5);
  assert.ok(p1.aggregates.pnlWallets > 0);
  // deterministic: run twice, same aggregate
  const again = await runFixture("graduated-token");
  assert.equal(again[0].aggregates.avgPnlPct, p1.aggregates.avgPnlPct);
});

test("curve fixture keeps its phase and flags unknown basis wallets", async () => {
  const phases = await runFixture("curve-token");
  const p1 = phases[0];
  assert.equal(p1.snapshot.meta.phase.kind, "curve");
  assert.ok(p1.snapshot.excluded.unknownBasis.wallets > 0, "this token has transfer wallets");
});

test("demo output is marked DEMO", async () => {
  const phases = await runFixture("older-token");
  const p1 = phases[0];
  const out = formatCheck(
    {
      snapshot: p1.snapshot,
      header: p1.header,
      groups: p1.groups,
      aggregates: p1.aggregates,
      top: p1.snapshot.holders.slice(0, 5),
      source: { label: "demo fixtures", requests: 3, seconds: 0.1 },
      demo: true,
    },
    "text",
  );
  assert.match(out, /^DEMO/);
  assert.match(out, /source demo fixtures/);
});
