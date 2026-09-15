import { test } from "node:test";
import assert from "node:assert/strict";
import { mapTokenTrades, mapWalletTrades, mapBalances } from "../lib/providers/bitquery.ts";
import { classify } from "../lib/pnl/classify.ts";

const TOKEN = "0x9cfb000000000000000000000000000000000001";
const CURVE = "0xc000000000000000000000000000000000000002";
const ALICE = "0xA11c000000000000000000000000000000000003";

const buyRow = {
  Block: { Number: "1000" },
  Transaction: { Hash: "0xh1" },
  Trade: {
    Buy: { Amount: "1000000.5", Buyer: ALICE, Currency: { SmartContract: TOKEN } },
    Sell: { Amount: "0.25", Seller: CURVE, Currency: { SmartContract: "0x0" } },
  },
};

const sellRow = {
  Block: { Number: "1010" },
  Transaction: { Hash: "0xh2" },
  Trade: {
    Buy: { Amount: "0.1", Buyer: CURVE, Currency: { SmartContract: "0x0" } },
    Sell: { Amount: "400000", Seller: ALICE, Currency: { SmartContract: TOKEN } },
  },
};

test("token trade rows rebuild transfer+quote pairs the classifier accepts", () => {
  const { transfers, quotes } = mapTokenTrades([buyRow, sellRow], TOKEN, CURVE, 18);
  assert.equal(transfers.length, 2);
  assert.equal(quotes.length, 2);
  // and the shared classifier produces the same trades mode A would
  const { trades } = classify(transfers, quotes, new Set([CURVE]));
  assert.equal(trades.length, 2);
  assert.equal(trades[0].kind, "buy");
  assert.equal(trades[0].wallet, ALICE.toLowerCase());
  assert.equal(trades[0].tokens, 10000005n * 10n ** 17n); // 1,000,000.5 tokens
  assert.equal(trades[0].eth, 25n * 10n ** 16n); // 0.25 ETH
  assert.equal(trades[1].kind, "sell");
  assert.equal(trades[1].eth, 1n * 10n ** 17n);
});

test("wallet trade rows group per token", () => {
  const map = mapWalletTrades([buyRow, sellRow], ALICE, () => 18);
  const trades = map.get(TOKEN.toLowerCase());
  assert.equal(trades.length, 2);
  assert.equal(trades[0].kind, "buy");
  assert.equal(trades[1].kind, "sell");
});

test("balances map with decimal amounts", () => {
  const rows = [
    { BalanceUpdate: { Address: ALICE }, balance: "600000.5" },
    { BalanceUpdate: { Address: CURVE }, balance: "0" },
  ];
  const m = mapBalances(rows, 18);
  assert.equal(m.get(ALICE.toLowerCase()), 6000005n * 10n ** 17n);
  assert.equal(m.get(CURVE.toLowerCase()), 0n);
});
