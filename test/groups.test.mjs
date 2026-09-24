import { test } from "node:test";
import assert from "node:assert/strict";
import { findGroups } from "../lib/pnl/groups.ts";

const row = (pnlPct, supplyShare = 0.01) => ({ pnlPct, supplyShare });

test("never more than three groups and width never above 5", () => {
  // five dense clusters; only the densest three must survive
  const rows = [];
  for (const center of [0, 20, 40, 60, 80]) {
    for (let k = 0; k < 5; k++) rows.push(row(center + k, 0.01 * (center / 20 + 1)));
  }
  const groups = findGroups(rows);
  assert.ok(groups.length <= 3);
  for (const g of groups) {
    assert.ok(g.maxPct - g.minPct <= 5, `width ${g.maxPct - g.minPct}`);
  }
  // densest clusters carry the most supply: 80s, 60s, 40s
  assert.ok(groups[0].minPct >= 80);
});

test("fewer than three clusters when the data has fewer", () => {
  const rows = [row(10), row(11), row(12), row(300), row(301)];
  const groups = findGroups(rows);
  assert.equal(groups.length, 2);
});

test("a dominant dense cluster beats a wide sparse one", () => {
  const rows = [
    // dense: 3 wallets at ~50 holding lots of supply
    row(50, 0.1), row(51, 0.1), row(52, 0.1),
    // sparse: wallets spread 0..4 with dust supply
    row(0, 0.001), row(1, 0.001), row(2, 0.001), row(3, 0.001), row(4, 0.001),
  ];
  const groups = findGroups(rows);
  assert.ok(Math.abs(groups[0].supplyShare - 0.3) < 1e-9);
  assert.equal(groups[0].wallets, 3);
});

test("a single wallet is not a cluster", () => {
  const groups = findGroups([row(10), row(100)]);
  assert.equal(groups.length, 0);
});

test("empty and single input give no groups", () => {
  assert.deepEqual(findGroups([]), []);
  assert.deepEqual(findGroups([row(5)]), []);
});

test("group stats add up", () => {
  const rows = [row(10, 0.05), row(12, 0.07), row(14, 0.03), row(90, 0.5)];
  const groups = findGroups(rows);
  const g = groups[0];
  assert.equal(g.wallets, 3);
  assert.ok(Math.abs(g.supplyShare - 0.15) < 1e-9);
  assert.ok(Math.abs(g.holderShare - 0.75) < 1e-9);
  assert.equal(g.minPct, 10);
  assert.equal(g.maxPct, 14);
});

