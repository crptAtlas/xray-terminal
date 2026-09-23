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

test("IN () queries survive thousands of keys (SQLite variable cap)", () => {
  const c = new Cache(":memory:");
  c.setTradeIndexSpan(1n, 10n);
  const rows = [];
  for (let i = 0; i < 1500; i++) {
    rows.push({ block: 5n, logIndex: i, tx: "0x" + i, curve: "0xc" + i, wallet: "0xw" + (i % 1200), kind: "buy", tokens: 1n, eth: 1n });
  }
  c.appendChainTrades(rows);
  const wallets = Array.from({ length: 1200 }, (_, i) => "0xw" + i);
  const got = c.chainTradesFor(wallets);
  assert.equal([...got.values()].reduce((s, l) => s + l.length, 0), 1500);
  const curves = Array.from({ length: 1500 }, (_, i) => "0xc" + i);
  assert.equal(c.curveTokens(curves).size, 0); // no mapping saved; must not throw
  c.close();
});

test("folded positions match the trades they came from", () => {
  const c = new Cache(":memory:");
  c.setMeta("positions_built", "1");
  c.appendChainTrades([
    { block: 100n, logIndex: 0, tx: "0x1", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 4n },
    { block: 110n, logIndex: 0, tx: "0x2", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 30n, eth: 18n },
    { block: 120n, logIndex: 0, tx: "0x3", curve: "0xc1", wallet: "0xw1", kind: "sell", tokens: 20n, eth: 14n },
    { block: 130n, logIndex: 0, tx: "0x4", curve: "", wallet: "0xw1", kind: "buy", tokens: 5n, eth: 1n, token: "0xt2" },
    // same primary key twice: folded once, never doubled
    { block: 100n, logIndex: 0, tx: "0x1", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 4n },
  ]);
  const pos = c.walletPositions(["0xw1"]).get("0xw1");
  const curve = pos.get("0xc1");
  assert.equal(curve.buyTokens, 40);
  assert.equal(curve.buyEth, 22);
  assert.equal(curve.sellTokens, 20);
  assert.equal(curve.sellEth, 14);
  assert.equal(curve.trades, 3);
  assert.equal(curve.lastBlock, 120);
  assert.equal(curve.lastPrice, 14 / 20); // the newest trade's price
  assert.equal(pos.get("0xt2").buyTokens, 5);
  c.close();
});

test("positions stay untouched while the bulk fold still owns the history", () => {
  const c = new Cache(":memory:");
  // a database whose history predates the fold: the bulk pass owns it
  c.setMeta("positions_built", "0");
  c.appendChainTrades([
    { block: 100n, logIndex: 0, tx: "0x1", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 4n },
  ]);
  assert.equal(c.positionsReady(), false);
  assert.equal(c.walletPositions(["0xw1"]).size, 0);
  c.close();
});

test("a new database folds from its first trade", () => {
  const c = new Cache(":memory:");
  assert.equal(c.positionsReady(), true);
  c.appendChainTrades([
    { block: 100n, logIndex: 0, tx: "0x1", curve: "0xc1", wallet: "0xw1", kind: "buy", tokens: 10n, eth: 4n },
  ]);
  assert.equal(c.walletPositions(["0xw1"]).get("0xw1").get("0xc1").buyTokens, 10);
  c.close();
});

test("walletsTradedSince finds wallets with rows past a block", () => {
  const c = new Cache(":memory:");
  c.appendChainTrades([
    { block: 100n, logIndex: 0, tx: "0x1", curve: "0xc", wallet: "0xold", kind: "buy", tokens: 1n, eth: 1n },
    { block: 200n, logIndex: 0, tx: "0x2", curve: "0xc", wallet: "0xfresh", kind: "buy", tokens: 1n, eth: 1n },
  ]);
  const got = c.walletsTradedSince(["0xold", "0xfresh", "0xnone"], 150n);
  assert.deepEqual([...got], ["0xfresh"]);
  c.close();
});
