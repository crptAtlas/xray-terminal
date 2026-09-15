import { test } from "node:test";
import assert from "node:assert/strict";
import { badges } from "../lib/profile/badges.ts";

const base = { trades: 30, avgPnlPerTrade: 25, winrate: 55, realizedTotalEth: 0, balanceEth: 0 };

test("smart exactly at every threshold", () => {
  assert.deepEqual(badges(base), ["smart"]);
});

test("smart denied one notch below each threshold", () => {
  assert.deepEqual(badges({ ...base, trades: 29 }), []);
  assert.deepEqual(badges({ ...base, avgPnlPerTrade: 24.9 }), []);
  assert.deepEqual(badges({ ...base, winrate: 54.9 }), []);
  assert.deepEqual(badges({ ...base, avgPnlPerTrade: null }), []);
});

test("rich via realized OR balance", () => {
  assert.deepEqual(badges({ ...base, trades: 0, avgPnlPerTrade: null, winrate: null, realizedTotalEth: 5 }), ["rich"]);
  assert.deepEqual(badges({ ...base, trades: 0, avgPnlPerTrade: null, winrate: null, balanceEth: 10 }), ["rich"]);
  assert.deepEqual(badges({ ...base, trades: 0, avgPnlPerTrade: null, winrate: null, realizedTotalEth: 4.99, balanceEth: 9.99 }), []);
});

test("both badges together", () => {
  assert.deepEqual(badges({ ...base, realizedTotalEth: 6 }), ["smart", "rich"]);
});
