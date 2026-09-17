import { test } from "node:test";
import assert from "node:assert/strict";
import { Cache, PROFILE_TTL_MS } from "../lib/cache.ts";

const meta = {
  address: "0xt".padEnd(42, "1"),
  symbol: "TST",
  name: "Test",
  decimals: 18,
  totalSupply: 10n ** 27n,
  curve: "0xc".padEnd(42, "2"),
  deployer: "0xd".padEnd(42, "3"),
  creatorFeeRecipient: "0xf".padEnd(42, "4"),
  createdBlock: 100n,
  createdAt: 1700000000,
  phase: { kind: "curve", fillPct: 10 },
};

test("token trades roundtrip and incremental synced block", () => {
  const c = new Cache(":memory:");
  assert.equal(c.tokenState(meta.address), null);
  c.saveToken(meta, 500n);
  c.appendTrades(meta.address, [
    { wallet: "0xa", kind: "buy", tokens: 10n, eth: 5n, block: 200n, tx: "0x9" },
  ]);
  assert.deepEqual(c.tokenState(meta.address), { syncedBlock: 500n, createdBlock: 100n });
  c.saveToken(meta, 900n);
  assert.deepEqual(c.tokenState(meta.address), { syncedBlock: 900n, createdBlock: 100n });
  const trades = c.loadTrades(meta.address);
  assert.equal(trades.length, 1);
  assert.deepEqual(trades[0], { wallet: "0xa", kind: "buy", tokens: 10n, eth: 5n, block: 200n, tx: "0x9" });
  c.close();
});

test("transfers in roundtrip", () => {
  const c = new Cache(":memory:");
  c.appendTransfersIn(meta.address, [{ wallet: "0xb", tokens: 7n }]);
  assert.deepEqual(c.loadTransfersIn(meta.address), [{ wallet: "0xb", tokens: 7n }]);
  c.close();
});

test("profile ttl: fresh within 24h, stale after", () => {
  const c = new Cache(":memory:");
  const t0 = 1_000_000;
  c.saveProfile("0xA", '{"trades":3}', t0);
  assert.equal(c.freshProfile("0xa", t0 + 1000), '{"trades":3}');
  assert.equal(c.freshProfile("0xa", t0 + PROFILE_TTL_MS + 1), null);
  c.close();
});

test("ticker index is case-insensitive and keeps the tip", () => {
  const c = new Cache(":memory:");
  assert.equal(c.launchesTip(), 0n);
  c.appendLaunches(
    [
      { block: 10n, token: "0x1".padEnd(42, "0"), symbol: "PEPE", curve: "0x2".padEnd(42, "0") },
      { block: 20n, token: "0x3".padEnd(42, "0"), symbol: "pepe", curve: "0x4".padEnd(42, "0") },
    ],
    25n,
  );
  assert.equal(c.launchesTip(), 25n);
  assert.equal(c.findTicker("Pepe").length, 2);
  c.close();
});

test("chain trade index: span, rows, per-wallet select", () => {
  const c = new Cache(":memory:");
  assert.equal(c.tradeIndexSpan(), null);
  c.setTradeIndexSpan(100n, 200n);
  assert.deepEqual(c.tradeIndexSpan(), { floor: 100n, tip: 200n });
  c.appendChainTrades([
    { block: 150n, logIndex: 3, tx: "0xa", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 5n },
    { block: 160n, logIndex: 1, tx: "0xb", curve: "0xc1", wallet: "0xw1", kind: "sell", tokens: 10n, eth: 7n },
    { block: 155n, logIndex: 0, tx: "0xc", curve: "0xc2", wallet: "0xw2", kind: "buy", tokens: 1n, eth: 1n },
    // duplicate primary key: ignored, not doubled
    { block: 150n, logIndex: 3, tx: "0xa", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 5n },
  ]);
  const got = c.chainTradesFor(["0xw1", "0xmissing"]);
  assert.equal(got.get("0xw1").length, 2);
  assert.equal(got.get("0xw1")[0].kind, "buy"); // block order
  assert.equal(got.get("0xw1")[1].eth, 7n);
  assert.equal(got.has("0xmissing"), false);
  c.close();
});
