import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../lib/pnl/classify.ts";

const CURVE = "0xcccccccccccccccccccccccccccccccccccccccc";
const ROUTER = "0xrrrr".padEnd(42, "0");
const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const MARKET = new Set([CURVE, ROUTER]);

const tx1 = "0x01";

function transfer(from, to, tokens, tx = tx1, logIndex = 0) {
  return { from, to, tokens, block: 100n, tx, logIndex };
}

test("curve buy: token out of market, buyer is the recipient", () => {
  const { trades, transfersIn } = classify(
    [transfer(CURVE, ALICE, 1000n)],
    [{ tx: tx1, kind: "curveBuy", eth: 5n, tokens: 1000n }],
    MARKET,
  );
  assert.equal(trades.length, 1);
  assert.deepEqual(trades[0], { wallet: ALICE, kind: "buy", tokens: 1000n, eth: 5n, block: 100n, tx: tx1 });
  assert.equal(transfersIn.length, 0);
});

test("curve sell: token into market, seller is the sender", () => {
  const { trades } = classify(
    [transfer(ALICE, CURVE, 400n)],
    [{ tx: tx1, kind: "curveSell", eth: 3n, tokens: 400n }],
    MARKET,
  );
  assert.deepEqual(trades[0], { wallet: ALICE, kind: "sell", tokens: 400n, eth: 3n, block: 100n, tx: tx1 });
});

test("relayed transaction: trader is the token recipient, tx.from is irrelevant", () => {
  // classify never even sees tx.from - the transfer says curve -> BOB,
  // so the buyer is BOB no matter who signed.
  const { trades } = classify(
    [transfer(CURVE, BOB, 777n)],
    [{ tx: tx1, kind: "curveBuy", eth: 9n, tokens: 777n }],
    MARKET,
  );
  assert.equal(trades[0].wallet, BOB);
});

test("wallet-to-wallet transfer is not a trade", () => {
  const { trades, transfersIn } = classify([transfer(ALICE, BOB, 50n)], [], MARKET);
  assert.equal(trades.length, 0);
  assert.deepEqual(transfersIn, [{ wallet: BOB, tokens: 50n }]);
});

test("pool swap quote is used for graduated trades", () => {
  const { trades } = classify(
    [transfer(ROUTER, ALICE, 100n)],
    [{ tx: tx1, kind: "swap", eth: 42n, tokens: 100n }],
    MARKET,
  );
  assert.equal(trades[0].eth, 42n);
});

test("weth fallback when the swap does not decode", () => {
  const { trades } = classify(
    [transfer(ALICE, ROUTER, 100n)],
    [{ tx: tx1, kind: "weth", eth: 33n }],
    MARKET,
  );
  assert.equal(trades[0].eth, 33n);
});

test("two trades in one tx consume separate quotes by token amount", () => {
  const { trades } = classify(
    [transfer(CURVE, ALICE, 100n, tx1, 0), transfer(CURVE, BOB, 900n, tx1, 1)],
    [
      { tx: tx1, kind: "curveBuy", eth: 1n, tokens: 100n },
      { tx: tx1, kind: "curveBuy", eth: 9n, tokens: 900n },
    ],
    MARKET,
  );
  assert.equal(trades.find((t) => t.wallet === ALICE).eth, 1n);
  assert.equal(trades.find((t) => t.wallet === BOB).eth, 9n);
});

test("market-to-market movement (graduation sweep) is ignored", () => {
  const { trades, transfersIn } = classify([transfer(CURVE, ROUTER, 10n)], [], MARKET);
  assert.equal(trades.length, 0);
  assert.equal(transfersIn.length, 0);
});

