import { test } from "node:test";
import assert from "node:assert/strict";
import { badges } from "../lib/profile/badges.ts";

const base = { trades: 30, avgPnlPerTrade: 25, winrate: 55, balanceUsd: 0 };

test("smart exactly at every threshold", () => {
  assert.deepEqual(badges(base), ["smart"]);
});

test("smart denied one notch below each threshold", () => {
  assert.deepEqual(badges({ ...base, trades: 29 }), []);
  assert.deepEqual(badges({ ...base, avgPnlPerTrade: 24.9 }), []);
  assert.deepEqual(badges({ ...base, winrate: 54.9 }), []);
  assert.deepEqual(badges({ ...base, avgPnlPerTrade: null }), []);
});

test("whale is wealth: 10k usd total balance, any tokens", () => {
  assert.deepEqual(badges({ trades: 0, avgPnlPerTrade: null, winrate: null, balanceUsd: 10_000 }), ["whale"]);
  assert.deepEqual(badges({ trades: 0, avgPnlPerTrade: null, winrate: null, balanceUsd: 9_999 }), []);
});

test("both badges together", () => {
  assert.deepEqual(badges({ ...base, balanceUsd: 25_000 }), ["smart", "whale"]);
});
