import { test } from "node:test";
import assert from "node:assert/strict";
import { mapWalletHistory, toWei } from "../lib/providers/bitquery.ts";

const W = "0xa11c000000000000000000000000000000000003";
const TOKEN = "0x9cfb000000000000000000000000000000000001";
const OTHER = "0x7fee000000000000000000000000000000000002";
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

const transfer = (hash, token, amount, inbound) => ({
  Block: { Number: "1000" },
  Transaction: { Hash: hash },
  Transfer: {
    Amount: amount,
    Sender: inbound ? "0xc0" : W,
    Receiver: inbound ? W : "0xc0",
    Currency: { SmartContract: token },
  },
});

const quote = (hash, token, ethAmount) => ({
  Transaction: { Hash: hash },
  Trade: { Currency: { SmartContract: token }, Amount: "1", Side: { Amount: ethAmount } },
});

test("decimal amounts convert to wei", () => {
  assert.equal(toWei("1000000.5", 18), 10000005n * 10n ** 17n);
  assert.equal(toWei("0.25", 18), 25n * 10n ** 16n);
  assert.equal(toWei("0", 18), 0n);
});

test("wallet history: transfers joined with same-tx quotes become trades", () => {
  const map = mapWalletHistory(
    W,
    [transfer("0xh1", TOKEN, "1000000.5", true), transfer("0xh2", TOKEN, "400000", false)],
    [quote("0xh1", TOKEN, "0.25"), quote("0xh2", TOKEN, "0.1")],
  );
  const trades = map.get(TOKEN);
  assert.equal(trades.length, 2);
  assert.equal(trades[0].kind, "buy");
  assert.equal(trades[0].tokens, 10000005n * 10n ** 17n);
  assert.equal(trades[0].eth, 25n * 10n ** 16n);
  assert.equal(trades[1].kind, "sell");
  assert.equal(trades[1].eth, 1n * 10n ** 17n);
});

test("plain transfers without a trade in the tx are skipped: no cost basis", () => {
  const map = mapWalletHistory(W, [transfer("0xh3", TOKEN, "50", true)], []);
  assert.equal(map.get(TOKEN), undefined);
});

test("weth and native legs never become positions", () => {
  const map = mapWalletHistory(
    W,
    [transfer("0xh1", WETH, "0.25", false), transfer("0xh1", TOKEN, "10", true)],
    [quote("0xh1", TOKEN, "0.25"), quote("0xh1", WETH, "0.25")],
  );
  assert.equal(map.size, 1);
  assert.ok(map.get(TOKEN));
});

test("tokens are grouped separately and quotes match per token", () => {
  const map = mapWalletHistory(
    W,
    [transfer("0xh1", TOKEN, "10", true), transfer("0xh1", OTHER, "20", true)],
    [quote("0xh1", TOKEN, "0.5"), quote("0xh1", OTHER, "0.7")],
  );
  assert.equal(map.get(TOKEN)[0].eth, 5n * 10n ** 17n);
  assert.equal(map.get(OTHER)[0].eth, 7n * 10n ** 17n);
});
