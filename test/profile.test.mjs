import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../lib/profile/profile.ts";

const T = (n) => BigInt(n) * 10n ** 18n;
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const buy = (tokens, eth, block = 1n) => ({ wallet: "0xw", kind: "buy", tokens, eth, block, tx: "0x1" });
const sell = (tokens, eth, block = 2n) => ({ wallet: "0xw", kind: "sell", tokens, eth, block, tx: "0x2" });

test("closed positions count as trades; open ones do not", () => {
  const byToken = new Map([
    // closed winner: +1 ETH, +100%
    ["0xt1", [buy(T(100), E(1)), sell(T(100), E(2))]],
    // closed loser: -0.5 ETH, -50%
    ["0xt2", [buy(T(100), E(1)), sell(T(100), E(0.5))]],
    // open position: not a trade yet
    ["0xt3", [buy(T(100), E(1))]],
  ]);
  const remaining = (t) => (t === "0xt3" ? T(100) : 0n);
  const p = buildProfile("0xW", byToken, remaining, 0n);
  assert.equal(p.trades, 2);
  assert.equal(p.wins, 1);
  assert.equal(p.avgPnlPerTrade, 25); // (100 - 50) / 2
  assert.equal(Math.round(p.winrate * 10) / 10, 33.3); // 1/(2+1)
  assert.ok(Math.abs(p.realizedTotalEth - 0.5) < 1e-9);
});

test("balance = eth + open positions at last trade price", () => {
  const byToken = new Map([["0xt1", [buy(T(100), E(1))]]]); // last price 0.01 ETH
  const p = buildProfile("0xw", byToken, () => T(50), E(2)); // 50 tokens left, 2 ETH native
  assert.ok(Math.abs(p.balanceEth - 2.5) < 1e-9);
});

test("rich badge from balance", () => {
  const byToken = new Map([["0xt1", [buy(T(100), E(1))]]]);
  const p = buildProfile("0xw", byToken, () => 0n, E(12));
  assert.deepEqual(p.badges, ["rich"]);
});

test("empty history", () => {
  const p = buildProfile("0xw", new Map(), () => 0n, 0n);
  assert.equal(p.trades, 0);
  assert.equal(p.winrate, null);
  assert.equal(p.avgPnlPerTrade, null);
});
