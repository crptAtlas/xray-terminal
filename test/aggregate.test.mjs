import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregate } from "../lib/pnl/aggregate.ts";

const row = (wallet, pnlPct, { closed = false, bought = 100n, supplyShare = 0.01 } = {}) => ({
  wallet,
  supplyShare,
  position: {
    boughtTokens: bought,
    boughtCostWei: 1n,
    soldTokens: 0n,
    soldProceedsWei: 0n,
    remaining: closed ? 0n : 1n,
    pnlWei: 0n,
    pnlPct,
    unknownBasis: false,
    closed,
  },
});

test("avg pnl over all surviving holders", () => {
  const agg = aggregate([row("0xa", 10), row("0xb", 30), row("0xc", -10)]);
  assert.equal(agg.avgPnlPct, 10);
  assert.equal(agg.pnlWallets, 3);
  assert.equal(agg.avgWinrate, null);
  assert.equal(agg.firstTrade, null);
});

test("winrate only over wallets with 2+ trades in their history", () => {
  const profiles = new Map([
    ["0xa", { trades: 5, winrate: 60 }],
    ["0xb", { trades: 1, winrate: null }],
    ["0xc", { trades: 0, winrate: null }],
  ]);
  const agg = aggregate([row("0xa", 10), row("0xb", 30), row("0xc", -10, { supplyShare: 0.05 })], profiles);
  assert.equal(agg.avgWinrate, 60);
  assert.equal(agg.winrateWallets, 1);
  assert.deepEqual(agg.firstTrade, { wallets: 1, supplyShare: 0.05 });
});

test("exited wallets: closed positions with real buys", () => {
  const profiles = new Map([
    ["0xa", { trades: 4, winrate: 40 }],
    ["0xb", { trades: 6, winrate: 80 }],
  ]);
  const agg = aggregate(
    [row("0xa", 22, { closed: true }), row("0xb", -22, { closed: true }), row("0xc", 5)],
    profiles,
  );
  assert.equal(agg.exited.wallets, 2);
  assert.equal(agg.exited.avgPnlPct, 0);
  assert.equal(agg.exited.avgWinrate, 60);
});

test("empty input", () => {
  const agg = aggregate([]);
  assert.equal(agg.avgPnlPct, null);
  assert.equal(agg.exited.wallets, 0);
});
