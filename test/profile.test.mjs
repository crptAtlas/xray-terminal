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
  assert.ok(withIt.avgPnlPerTrade > 1000, "insider pump inflates the naive profile");
  assert.equal(withoutIt.avgPnlPerTrade, 0); // (+20 - 20) / 2
  assert.equal(Math.round(withoutIt.winrate * 10) / 10, 33.3); // 1 / (2 + 1)
});

test("badges still judge the full record including the scanned token", async () => {
  const { buildPositions, profileFromPositions } = await import("../lib/profile/profile.ts");
  // 6 ETH realized on the scanned token alone -> RICH holds even when the
  // shown stats exclude it
  const byToken = new Map([["0xscanned", [buy(T(100), E(1)), sell(T(100), E(7))]]]);
  const positions = buildPositions(byToken, () => 0n);
  const p = profileFromPositions("0xw", positions, 0n, "0xscanned");
  assert.equal(p.trades, 0); // shown stats exclude the token
  assert.deepEqual(p.badges, ["rich"]); // the badge does not
});
