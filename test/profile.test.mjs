import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfile } from "../lib/profile/profile.ts";

const T = (n) => BigInt(n) * 10n ** 18n;
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const buy = (tokens, eth, block = 1n) => ({ wallet: "0xw", kind: "buy", tokens, eth, block, tx: "0x1" });
const sell = (tokens, eth, block = 2n) => ({ wallet: "0xw", kind: "sell", tokens, eth, block, tx: "0x2" });

test("every position counts, open ones marked at the price they last traded at", () => {
  const byToken = new Map([
    // closed winner: +1 ETH, +100%
    ["0xt1", [buy(T(100), E(1)), sell(T(100), E(2))]],
    // closed loser: -0.5 ETH, -50%
    ["0xt2", [buy(T(100), E(1)), sell(T(100), E(0.5))]],
    // still held: marked at the last price it traded at, so flat
    ["0xt3", [buy(T(100), E(1))]],
  ]);
  const remaining = (t) => (t === "0xt3" ? T(100) : 0n);
  const p = buildProfile("0xW", byToken, remaining, 0n);
  assert.equal(p.trades, 3); // positions taken, the open one included
  assert.equal(p.wins, 1); // the held one is flat, not a win
  assert.ok(Math.abs(p.avgPnlPerTrade - 50 / 3) < 1e-9); // (100 - 50 + 0) / 3
  assert.equal(p.winrate, 25); // 1 win of 3 positions, +1
  assert.ok(Math.abs(p.realizedTotalEth - 0.5) < 1e-9); // realized stays realized
});

test("balance = eth + open positions at last trade price", () => {
  const byToken = new Map([["0xt1", [buy(T(100), E(1))]]]); // last price 0.01 ETH
  const p = buildProfile("0xw", byToken, () => T(50), E(2)); // 50 tokens left, 2 ETH native
  assert.ok(Math.abs(p.balanceEth - 2.5) < 1e-9);
});

test("whale badge from a 10k usd balance", () => {
  const byToken = new Map([["0xt1", [buy(T(100), E(1))]]]);
  // 5 ETH at $2400 = $12k -> whale; rate 0 -> never a whale
  const p = buildProfile("0xw", byToken, () => 0n, E(5), () => 18, undefined, 2400);
  assert.deepEqual(p.badges, ["whale"]);
  const noRate = buildProfile("0xw", byToken, () => 0n, E(5));
  assert.deepEqual(noRate.badges, []);
});

test("empty history", () => {
  const p = buildProfile("0xw", new Map(), () => 0n, 0n);
  assert.equal(p.trades, 0);
  assert.equal(p.winrate, null);
  assert.equal(p.avgPnlPerTrade, null);
});

test("the scanned token is excluded from the profile: insiders get no credit from their own launch", async () => {
  const { buildPositions, profileFromPositions } = await import("../lib/profile/profile.ts");
  const byToken = new Map([
    // huge win on the scanned token itself
    ["0xscanned", [buy(T(100), E(0.01)), sell(T(100), E(2))]],
    // modest record elsewhere
    ["0xother1", [buy(T(100), E(1)), sell(T(100), E(1.2))]],
    ["0xother2", [buy(T(100), E(1)), sell(T(100), E(0.8))]],
  ]);
  const positions = buildPositions(byToken, () => 0n);
  const withIt = profileFromPositions("0xw", positions, 0n);
  const withoutIt = profileFromPositions("0xw", positions, 0n, "0xscanned");
  assert.equal(withIt.trades, 3);
  assert.equal(withoutIt.trades, 2);
  // the pump reads as +500%, the band every position joins an average in
  assert.ok(Math.abs(withIt.avgPnlPerTrade - 500 / 3) < 1e-9, "insider pump inflates the naive profile");
  assert.equal(withoutIt.avgPnlPerTrade, 0); // (+20 - 20) / 2
  assert.equal(Math.round(withoutIt.winrate * 10) / 10, 33.3); // 1 / (2 + 1)
});

test("badges still judge the full record including the scanned token", async () => {
  const { buildPositions, profileFromPositions } = await import("../lib/profile/profile.ts");
  // a fat open position on the scanned token alone -> WHALE holds even
  // when the shown stats exclude it
  const byToken = new Map([["0xscanned", [buy(T(100), E(5))]]]);
  const positions = buildPositions(byToken, () => T(100));
  const p = profileFromPositions("0xw", positions, 0n, "0xscanned", 2400);
  assert.equal(p.trades, 0); // shown stats exclude the token
  assert.deepEqual(p.badges, ["whale"]); // the badge does not
});
