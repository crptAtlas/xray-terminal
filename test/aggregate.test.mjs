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

test("avg pnl is supply-weighted: 5% of supply pulls 5x harder than 1%", () => {
  // +15% holding 1% vs -50% holding 5% -> (15*1 - 50*5) / 6 = -39.17%
  const agg = aggregate([
    row("0xa", 15, { supplyShare: 0.01 }),
    row("0xb", -50, { supplyShare: 0.05 }),
  ]);
  assert.ok(Math.abs(agg.avgPnlPct - (15 * 0.01 - 50 * 0.05) / 0.06) < 1e-9);
  assert.equal(Math.round(agg.avgPnlPct * 100) / 100, -39.17);
  assert.equal(agg.pnlWallets, 2);
});

test("equal shares reduce to the plain mean", () => {
  const agg = aggregate([
    row("0xa", 10, { supplyShare: 0.02 }),
    row("0xb", 30, { supplyShare: 0.02 }),
    row("0xc", -10, { supplyShare: 0.02 }),
  ]);
  assert.ok(Math.abs(agg.avgPnlPct - 10) < 1e-9);
  assert.equal(agg.avgWinrate, null);
  assert.equal(agg.firstTrade, null);
});

test("exited wallets (share 0) do not steer the current average", () => {
  const agg = aggregate([
    row("0xa", 100, { supplyShare: 0.03 }),
    row("0xb", -100, { closed: true, supplyShare: 0 }),
  ]);
  assert.equal(agg.avgPnlPct, 100);
  assert.equal(agg.pnlWallets, 1);
  assert.equal(agg.exited.wallets, 1);
  assert.equal(agg.exited.avgPnlPct, -100);
});

test("dead token where everyone exited has no current average", () => {
  const agg = aggregate([
    row("0xa", -80, { closed: true, supplyShare: 0 }),
    row("0xb", -100, { closed: true, supplyShare: 0 }),
  ]);
  assert.equal(agg.avgPnlPct, null); // nobody holds anything now
  assert.equal(agg.exited.avgPnlPct, -90);
});

test("winrate is supply-weighted over wallets with 2+ trades", () => {
  const profiles = new Map([
    ["0xa", { trades: 5, winrate: 60 }],
    ["0xb", { trades: 5, winrate: 30 }],
    ["0xc", { trades: 1, winrate: null }],
    ["0xd", { trades: 0, winrate: null }],
  ]);
  const agg = aggregate(
    [
      row("0xa", 10, { supplyShare: 0.04 }), // 60% wr, 4x weight
      row("0xb", 10, { supplyShare: 0.01 }), // 30% wr, 1x weight
      row("0xc", 10, { supplyShare: 0.01 }),
      row("0xd", 10, { supplyShare: 0.05 }),
    ],
    profiles,
  );
  assert.ok(Math.abs(agg.avgWinrate - (60 * 4 + 30 * 1) / 5) < 1e-9); // 54
  assert.equal(agg.winrateWallets, 2);
  assert.deepEqual(agg.firstTrade, { wallets: 1, supplyShare: 0.05 });
});

test("notRead profiles are never counted", () => {
  const profiles = new Map([
    ["0xa", { trades: 5, winrate: 60 }],
    ["0xb", { trades: 5, winrate: 0, notRead: true }],
  ]);
  const agg = aggregate([row("0xa", 10), row("0xb", 10)], profiles);
  assert.equal(agg.avgWinrate, 60);
  assert.equal(agg.winrateWallets, 1);
});

test("exited stats stay unweighted with profile winrates", () => {
  const profiles = new Map([
    ["0xa", { trades: 4, winrate: 40 }],
    ["0xb", { trades: 6, winrate: 80 }],
  ]);
  const agg = aggregate(
    [
      row("0xa", 22, { closed: true, supplyShare: 0 }),
      row("0xb", -22, { closed: true, supplyShare: 0 }),
      row("0xc", 5),
    ],
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

test("avgProfilePnl: supply-weighted holders record, clamped, current holders only", async () => {
  const { aggregate } = await import("../lib/pnl/aggregate.ts");
  const row = (wallet, share, pnl) => ({ wallet, supplyShare: share, position: { pnlPct: pnl, closed: false, boughtTokens: 1n } });
  const rows = [row("0xa", 0.05, 10), row("0xb", 0.01, -5), row("0xc", 0, 50)];
  const profiles = new Map([
    ["0xa", { trades: 3, winrate: 60, avgPnlPerTrade: 100 }],
    ["0xb", { trades: 2, winrate: 30, avgPnlPerTrade: -40 }],
    ["0xc", { trades: 9, winrate: 90, avgPnlPerTrade: 999 }], // exited: not counted
  ]);
  const a = aggregate(rows, profiles);
  // (100*5 + -40*1) / 6 = 76.67
  assert.ok(Math.abs(a.avgProfilePnl - 76.666) < 0.01);
  assert.equal(a.profilePnlWallets, 2);
  // a sniper wallet avg of +90000 clamps to +500 before weighting
  const crazy = new Map([["0xa", { trades: 1, winrate: null, avgPnlPerTrade: 90000 }]]);
  const b = aggregate([row("0xa", 0.05, 1)], crazy);
  assert.equal(b.avgProfilePnl, 500);
});

test("grade waits for the holders record and then respects it", async () => {
  const { gradeOf } = await import("../lib/grade.ts");
  const row = (share, pnl) => ({ wallet: "0x" + share, supplyShare: share, position: { pnlPct: pnl, closed: false, boughtTokens: 1n } });
  const holders = [row(0.05, 40), row(0.04, 20), row(0.03, -5)];
  const base = { avgPnlPct: 20, avgWinrate: null, avgProfilePnl: null, medianPnlPct: 20, inProfit: 2, pnlWallets: 3, winrateWallets: 0, profilePnlWallets: 0, firstTrade: null, exited: { wallets: 0, avgPnlPct: null, avgWinrate: null } };
  // before profiles land the token alone decides
  assert.equal(gradeOf(base, holders, false), "healthy");
  // once the record is known it is the grade: below -10 red
  assert.equal(gradeOf({ ...base, avgProfilePnl: -25, avgWinrate: 20 }, holders, false), "shattered");
  // -10 to +15 yellow, around the chain's median
  assert.equal(gradeOf({ ...base, avgProfilePnl: -3 }, holders, false), "cracked");
  assert.equal(gradeOf({ ...base, avgProfilePnl: 9 }, holders, false), "cracked");
  // +15 and up green
  assert.equal(gradeOf({ ...base, avgProfilePnl: 24 }, holders, false), "healthy");
  // a dead token is shattered regardless
  assert.equal(gradeOf({ ...base, avgProfilePnl: 50 }, holders, true), "shattered");
});
