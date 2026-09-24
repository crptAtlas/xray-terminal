import { test } from "node:test";
import assert from "node:assert/strict";
import { ADDR, TOPIC, INFRA, ZERO, DEAD, CHAIN } from "../lib/chain.ts";
import { toEventSelector } from "viem";
import { curveAbi, factoryAbi } from "../lib/abi/pons.ts";

test("addresses are lowercase 20-byte hex", () => {
  for (const a of Object.values(ADDR)) {
    assert.match(a, /^0x[0-9a-f]{40}$/);
  }
});

test("topics are 32-byte hex", () => {
  for (const t of Object.values(TOPIC)) {
    assert.match(t, /^0x[0-9a-f]{64}$/);
  }
});

test("infra set contains zero, dead and all fixed addresses", () => {
  assert.ok(INFRA.has(ZERO));
  assert.ok(INFRA.has(DEAD));
  for (const a of [ADDR.factory, ADDR.router, ADDR.hook, ADDR.locker, ADDR.poolManager]) {
    assert.ok(INFRA.has(a), a);
  }
  assert.ok(!INFRA.has(ADDR.weth), "weth is a token, not an excluded holder");
});

test("curve event abi matches the spec topics", () => {
  const buy = curveAbi.find((e) => e.type === "event" && e.name === "CurveBuy");
  const sell = curveAbi.find((e) => e.type === "event" && e.name === "CurveSell");
  assert.equal(toEventSelector(buy), TOPIC.curveBuy);
  assert.equal(toEventSelector(sell), TOPIC.curveSell);
});

test("chain id", () => {
  assert.equal(CHAIN.id, 4663);
});
