import { test } from "node:test";
import assert from "node:assert/strict";
import { getLogsAdaptive } from "../lib/providers/logs.ts";

// Mock viem client: `blocks` maps blockNumber -> log count; a request wider
// than `maxSpan` blocks throws a range error.
function mockClient(blocks, maxSpan = Infinity) {
  const calls = [];
  return {
    calls,
    request: async ({ params }) => {
      const [{ fromBlock, toBlock }] = params;
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      calls.push([from, to]);
      if (Number(to - from + 1n) > maxSpan) throw new Error("query range too large");
      const out = [];
      for (const [block, count] of Object.entries(blocks)) {
        const b = BigInt(block);
        if (b >= from && b <= to) {
          for (let i = 0; i < count; i++) {
            out.push({
              address: "0xabc0000000000000000000000000000000000abc",
              topics: [],
              data: "0x",
              blockNumber: `0x${b.toString(16)}`,
              transactionHash: `0x${b.toString(16).padStart(64, "0")}`,
              logIndex: `0x${i.toString(16)}`,
            });
          }
        }
      }
      return out;
    },
  };
}

test("splits on range errors and merges ordered", async () => {
  const client = mockClient({ 10: 1, 50: 1, 90: 1 }, 30);
  const logs = await getLogsAdaptive(client, { fromBlock: 1n, toBlock: 100n }, { parallel: 1 });
  assert.equal(logs.length, 3);
  assert.deepEqual(
    logs.map((l) => l.blockNumber),
    [10n, 50n, 90n],
  );
  assert.ok(client.calls.length > 1, "must have split");
});

test("single window when the node is happy", async () => {
  const client = mockClient({ 5: 2 });
  const logs = await getLogsAdaptive(client, { fromBlock: 1n, toBlock: 100n }, { parallel: 1 });
  assert.equal(logs.length, 2);
  assert.equal(client.calls.length, 1);
});

test("parallel slices cover the range exactly once", async () => {
  const client = mockClient({ 1: 1, 25: 1, 50: 1, 75: 1, 100: 1 });
  const logs = await getLogsAdaptive(client, { fromBlock: 1n, toBlock: 100n }, { parallel: 4 });
  assert.equal(logs.length, 5);
  const covered = client.calls
    .map(([f, t]) => [Number(f), Number(t)])
    .sort((a, b) => a[0] - b[0]);
  let expect = 1;
  for (const [f, t] of covered) {
    assert.equal(f, expect, "no gap or overlap");
    expect = t + 1;
  }
  assert.equal(expect, 101);
});
