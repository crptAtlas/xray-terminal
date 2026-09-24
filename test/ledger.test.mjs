import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTrades, emptyLedger, ledgerPositions } from "../lib/profile/ledger.ts";
import { buildPositions } from "../lib/profile/profile.ts";

const T = (n) => BigInt(n) * 10n ** 18n;
const E = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const buy = (tokens, eth, block) => ({ wallet: "0xw", kind: "buy", tokens, eth, block, tx: "0x" + block });
const sell = (tokens, eth, block) => ({ wallet: "0xw", kind: "sell", tokens, eth, block, tx: "0x" + block });

test("incremental fold equals one-shot fold", () => {
  const all = new Map([
    ["0xa", [buy(T(100), E(1), 10n), sell(T(50), E(1), 20n), sell(T(50), E(1.5), 30n)]],
    ["0xb", [buy(T(10), E(2), 15n)]],
  ]);
  // one shot
  const one = ledgerPositions(applyTrades(emptyLedger(), all, 30n));
  // two steps: up to block 20, then the rest
  const first = new Map([["0xa", [buy(T(100), E(1), 10n), sell(T(50), E(1), 20n)]], ["0xb", [buy(T(10), E(2), 15n)]]]);
  const rest = new Map([["0xa", [sell(T(50), E(1.5), 30n)]]]);
  const l1 = applyTrades(emptyLedger(), first, 20n);
  assert.equal(l1.syncedBlock, "20");
  const l2 = applyTrades(l1, rest, 30n);
  const two = ledgerPositions(l2);
  assert.deepEqual(two, one);
  const a = one.find((p) => p.token === "0xa");
  assert.equal(a.closed, true);
  assert.equal(a.trades, 3);
  assert.ok(Math.abs(a.pnlPct - 150) < 1e-9); // 2.5 out on 1 in
});

test("ledger positions match buildPositions on the same trades", () => {
  const byToken = new Map([
    ["0xa", [buy(T(100), E(1), 1n), sell(T(100), E(2), 2n)]],
    ["0xb", [buy(T(100), E(1), 3n)]],
  ]);
  const remaining = (t) => (t === "0xb" ? T(100) : 0n);
  const classic = buildPositions(byToken, remaining);
  const viaLedger = ledgerPositions(applyTrades(emptyLedger(), byToken, 3n));
  for (const c of classic) {
    const l = viaLedger.find((p) => p.token === c.token);
    assert.equal(l.closed, c.closed);
    assert.equal(l.trades, c.trades);
    assert.ok(Math.abs(l.pnlPct - c.pnlPct) < 1e-6, `${c.token}: ${l.pnlPct} vs ${c.pnlPct}`);
  }
});

test("sold more than bought drops the position, same as the unknown-basis rule", () => {
  const byToken = new Map([["0xa", [buy(T(10), E(1), 1n), sell(T(20), E(3), 2n)]]]);
  assert.equal(ledgerPositions(applyTrades(emptyLedger(), byToken, 2n)).length, 0);
});

test("aggregates fold into the same position as trade-by-trade", async () => {
  const { applyAggregates } = await import("../lib/profile/ledger.ts");
  const byToken = new Map([["0xa", [buy(T(100), E(1), 1n), sell(T(60), E(1.5), 2n), buy(T(20), E(0.3), 3n)]]]);
  const viaTrades = ledgerPositions(applyTrades(emptyLedger(), byToken, 3n));
  const agg = new Map([["0xa", {
    buyTokens: Number(T(120)), buyEth: Number(E(1.3)),
    sellTokens: Number(T(60)), sellEth: Number(E(1.5)),
    trades: 3, lastPrice: Number(E(0.3)) / Number(T(20)), lastBlock: 3,
  }]]);
  const viaAgg = ledgerPositions(applyAggregates(emptyLedger(), agg, 3n));
  assert.equal(viaAgg.length, viaTrades.length);
  assert.equal(viaAgg[0].trades, viaTrades[0].trades);
  assert.equal(viaAgg[0].closed, viaTrades[0].closed);
  assert.ok(Math.abs(viaAgg[0].pnlPct - viaTrades[0].pnlPct) < 0.01, `${viaAgg[0].pnlPct} vs ${viaTrades[0].pnlPct}`);
});

