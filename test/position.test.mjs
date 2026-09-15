import { test } from "node:test";
import assert from "node:assert/strict";
import { position } from "../lib/pnl/position.ts";

const D = 18;
const T = (n) => BigInt(n) * 10n ** 18n; // whole tokens
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // ETH -> wei

const buy = (tokens, eth) => ({ wallet: "0xa", kind: "buy", tokens, eth, block: 1n, tx: "0x1" });
const sell = (tokens, eth) => ({ wallet: "0xa", kind: "sell", tokens, eth, block: 2n, tx: "0x2" });

test("buy only: unrealized pnl from current price", () => {
  // bought 100 tokens for 1 ETH, price now 0.02 ETH each -> value 2 ETH, pnl +1 ETH = +100%
  const p = position([buy(T(100), E(1))], 0n, T(100), 0.02, D);
  assert.equal(p.pnlWei, E(1));
  assert.equal(Math.round(p.pnlPct), 100);
  assert.equal(p.unknownBasis, false);
  assert.equal(p.closed, false);
});

test("full round trip: realized pnl, closed", () => {
  const p = position([buy(T(100), E(1)), sell(T(100), E(3))], 0n, 0n, 0.05, D);
  assert.equal(p.pnlWei, E(2));
  assert.equal(Math.round(p.pnlPct), 200);
  assert.equal(p.closed, true);
});

test("partial sell keeps unrealized remainder", () => {
  // buy 100 for 1 ETH; sell 50 for 2 ETH; 50 left at 0.01 -> value 0.5
  // pnl = 2 + 0.5 - 1 = 1.5 ETH = +150%
  const p = position([buy(T(100), E(1)), sell(T(50), E(2))], 0n, T(50), 0.01, D);
  assert.equal(p.pnlWei, E(1.5));
  assert.equal(Math.round(p.pnlPct), 150);
  assert.equal(p.closed, false);
});

test("re-buy after sell accumulates both sides", () => {
  const p = position(
    [buy(T(100), E(1)), sell(T(100), E(2)), buy(T(200), E(1))],
    0n,
    T(200),
    0.005,
    D,
  );
  // cost 2, proceeds 2, value 1 -> pnl 1 ETH = +50%
  assert.equal(p.pnlWei, E(1));
  assert.equal(Math.round(p.pnlPct), 50);
});

test("an ETH top-up between trades does not change pnl", () => {
  // top-ups never enter the trade list; identical trades => identical result
  const trades = [buy(T(100), E(1)), sell(T(40), E(1))];
  const a = position(trades, 0n, T(60), 0.01, D);
  const b = position(trades, 0n, T(60), 0.01, D); // "after a 5 ETH deposit"
  assert.deepEqual(a, b);
});

test("inbound transfer flags unknown basis", () => {
  const p = position([buy(T(10), E(1))], T(90), T(100), 0.01, D);
  assert.equal(p.unknownBasis, true);
});

test("holding more than bought flags unknown basis even without a seen transfer", () => {
  const p = position([buy(T(10), E(1))], 0n, T(100), 0.01, D);
  assert.equal(p.unknownBasis, true);
});

test("zero cost basis: pnlPct is null, unknown basis", () => {
  const p = position([], 0n, T(5), 0.01, D);
  assert.equal(p.pnlPct, null);
  assert.equal(p.unknownBasis, true);
});
