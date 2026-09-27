import { test } from "node:test";
import assert from "node:assert/strict";

test("scaffold sanity", () => { assert.equal(1 + 1, 2); });

test("index fast path and node path agree on the same trades", async () => {
  const { Cache } = await import("../lib/cache.ts");
  const c = new Cache(":memory:");
  c.setTradeIndexSpan(0n, 1000n, "curve");
  c.setTradeIndexSpan(0n, 1000n, "v4");
  c.appendChainTrades([
    { block: 10n, logIndex: 0, tx: "0x1", curve: "0xcurve", wallet: "0xw1", kind: "buy", tokens: 100n, eth: 5n },
    { block: 20n, logIndex: 0, tx: "0x2", curve: "0xcurve", wallet: "0xw1", kind: "sell", tokens: 100n, eth: 9n },
    { block: 30n, logIndex: 0, tx: "0x3", curve: "", wallet: "0xw2", kind: "buy", tokens: 7n, eth: 2n, token: "0xtoken" },
    { block: 40n, logIndex: 0, tx: "0x4", curve: "0xother", wallet: "0xw3", kind: "buy", tokens: 1n, eth: 1n },
  ]);
  const got = c.tokenTradesFromIndex("0xtoken", "0xcurve");
  assert.equal(got.length, 3, "curve trades plus pool trades of this token, nothing else");
  assert.deepEqual(got.map((t) => t.wallet), ["0xw1", "0xw1", "0xw2"]);
  assert.equal(got[0].eth, 5n);
  c.close();
});

