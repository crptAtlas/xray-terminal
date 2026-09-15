import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGateForTest } from "../lib/providers/gate.ts";

function jsonRes(result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status: 200 });
}

test("routes eth_getLogs only to logs-capable endpoints", async () => {
  const hits = [];
  const gate = makeGateForTest(
    async (url) => {
      hits.push(url);
      return jsonRes([]);
    },
    [
      { url: "https://state.example", logs: false, badUntil: 0, label: "state" },
      { url: "https://logs.example", logs: true, badUntil: 0, label: "logs" },
    ],
  );
  await gate.request("eth_getLogs", [{}]);
  assert.deepEqual(hits, ["https://logs.example"]);
  await gate.request("eth_chainId", []);
  assert.equal(hits[1], "https://state.example");
});

test("moves to the next endpoint after 429 and counts requests", async () => {
  const hits = [];
  const gate = makeGateForTest(
    async (url) => {
      hits.push(url);
      if (url === "https://a.example") return new Response("", { status: 429 });
      return jsonRes("0x1237");
    },
    [
      { url: "https://a.example", logs: true, badUntil: 0, label: "a" },
      { url: "https://b.example", logs: true, badUntil: 0, label: "b" },
    ],
  );
  const out = await gate.request("eth_chainId", []);
  assert.equal(out, "0x1237");
  assert.deepEqual(hits, ["https://a.example", "https://b.example"]);
  assert.equal(gate.stats().requests, 2);
});

test("json-rpc level errors are thrown to the caller, not retried", async () => {
  let calls = 0;
  const gate = makeGateForTest(
    async () => {
      calls++;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32005, message: "query returned more than 10000 results" } }),
        { status: 200 },
      );
    },
    [{ url: "https://a.example", logs: true, badUntil: 0, label: "a" }],
  );
  await assert.rejects(() => gate.request("eth_getLogs", [{}]), /more than 10000/);
  assert.equal(calls, 1);
});
