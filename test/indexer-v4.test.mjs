import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeV4Rows } from "../lib/read/indexer.ts";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { ADDR } from "../lib/chain.ts";
import { SWAP_TOPIC } from "../lib/abi/pool.ts";

const PM = `0x000000000000000000000000${ADDR.poolManager.slice(2)}`;
const pad = (a) => `0x000000000000000000000000${a.slice(2)}`;
const W = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const SWAP = SWAP_TOPIC;

const transfer = (from, to, amount, tx = "0xt1") => ({
  address: TOKEN,
  topics: [TRANSFER, pad(from), pad(to)],
  data: `0x${amount.toString(16).padStart(64, "0")}`,
  blockNumber: 10n,
  transactionHash: tx,
  logIndex: 1,
});
const swap = (amount0, amount1, tx = "0xt1") => ({
  address: ADDR.poolManager,
  topics: [SWAP, "0x" + "11".repeat(32), pad("0xcccccccccccccccccccccccccccccccccccccccc")],
  data: encodeAbiParameters(
    parseAbiParameters("int128, int128, uint160, uint128, int24, uint24"),
    [amount0, amount1, 1n, 1n, 0, 3000],
  ),
  blockNumber: 10n,
  transactionHash: tx,
  logIndex: 0,
});

test("v4 sell: token to poolManager, quote from the matching swap", () => {
  const rows = decodeV4Rows([transfer(W, ADDR.poolManager, 1000n)], [swap(-5n, 1000n)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "sell");
  assert.equal(rows[0].wallet, W);
  assert.equal(rows[0].token, TOKEN);
  assert.equal(rows[0].tokens, 1000n);
  assert.equal(rows[0].eth, 5n);
});

test("v4 buy: token from poolManager to the wallet", () => {
  const rows = decodeV4Rows([transfer(ADDR.poolManager, W, 777n)], [swap(777n, -42n)]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "buy");
  assert.equal(rows[0].eth, 42n);
});

test("liquidity moves and unmatched transfers are not trades", () => {
  // infra wallet
  assert.equal(decodeV4Rows([transfer(ADDR.locker, ADDR.poolManager, 5n)], [swap(-1n, 5n)]).length, 0);
  // no swap in tx
  assert.equal(decodeV4Rows([transfer(W, ADDR.poolManager, 5n)], []).length, 0);
  // amounts do not match any swap side
  assert.equal(decodeV4Rows([transfer(W, ADDR.poolManager, 5n)], [swap(-9n, 900n)]).length, 0);
});

test("multi-swap tx: each transfer finds its own swap by amount", () => {
  const rows = decodeV4Rows(
    [transfer(W, ADDR.poolManager, 100n, "0xm"), transfer(ADDR.poolManager, W, 200n, "0xm")],
    [swap(-3n, 100n, "0xm"), swap(200n, -7n, "0xm")],
  );
  assert.equal(rows.length, 2);
  const sell = rows.find((r) => r.kind === "sell");
  const buy = rows.find((r) => r.kind === "buy");
  assert.equal(sell.eth, 3n);
  assert.equal(buy.eth, 7n);
});

test("buy with a hook fee leg: swap total = wallet leg + fee leg, wallet gets its share", () => {
  // swap pays out 1000 tokens: 970 to the wallet, 30 to the hook as fee
  const rows = decodeV4Rows(
    [transfer(ADDR.poolManager, W, 970n, "0xf"), transfer(ADDR.poolManager, ADDR.hook, 30n, "0xf")],
    [swap(-2000n, 1000n, "0xf")],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "buy");
  assert.equal(rows[0].wallet, W);
  assert.equal(rows[0].tokens, 970n);
  assert.equal(rows[0].eth, 1940n); // 2000 * 970 / 1000
});

test("one swap serves both sides of a trade: the sell leg and the buy leg", () => {
  // wallet sells TOKEN_A into the pool and receives TOKEN_B from it
  const A = "0xaaaa000000000000000000000000000000000001";
  const rows = decodeV4Rows(
    [
      { address: A, topics: [TRANSFER, pad(W), pad(ADDR.poolManager)], data: `0x${(500n).toString(16).padStart(64, "0")}`, blockNumber: 7n, transactionHash: "0xboth", logIndex: 1 },
      { address: TOKEN, topics: [TRANSFER, pad(ADDR.poolManager), pad(W)], data: `0x${(900n).toString(16).padStart(64, "0")}`, blockNumber: 7n, transactionHash: "0xboth", logIndex: 2 },
    ],
    [swap(-500n, 900n, "0xboth")],
  );
  assert.equal(rows.length, 2);
  const sell = rows.find((r) => r.kind === "sell");
  const buy = rows.find((r) => r.kind === "buy");
  assert.equal(sell.tokens, 500n);
  assert.equal(sell.eth, 900n);
  assert.equal(buy.tokens, 900n);
  assert.equal(buy.eth, 500n);
});

test("multi-hop: each leg claims its own swap", () => {
  const rows = decodeV4Rows(
    [
      transfer(ADDR.poolManager, W, 100n, "0xhop"),
      transfer(ADDR.poolManager, W, 250n, "0xhop"),
    ],
    [swap(100n, -7n, "0xhop"), swap(250n, -19n, "0xhop")],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.eth).sort((a, b) => Number(a - b)), [7n, 19n]);
});

test("weth legs are the quote side, never a position", () => {
  const rows = decodeV4Rows(
    [{ address: ADDR.weth, topics: [TRANSFER, pad(ADDR.poolManager), pad(W)], data: `0x${(42n).toString(16).padStart(64, "0")}`, blockNumber: 8n, transactionHash: "0xw", logIndex: 0 }],
    [swap(42n, -1n, "0xw")],
  );
  assert.equal(rows.length, 0);
});
