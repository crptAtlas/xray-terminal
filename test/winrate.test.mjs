import { test } from "node:test";
import assert from "node:assert/strict";
import { winrate } from "../lib/profile/winrate.ts";

test("all six spec examples match to one decimal", () => {
  const cases = [
    [2, 1, 33.3],
    [3, 1, 25.0],
    [3, 2, 50.0],
    [4, 1, 20.0],
    [4, 2, 40.0],
    [100, 60, 59.4],
  ];
  for (const [trades, wins, expected] of cases) {
    const wr = winrate(trades, wins);
    assert.equal(Math.round(wr * 10) / 10, expected, `trades=${trades} wins=${wins}`);
  }
});

test("hidden below two trades", () => {
  assert.equal(winrate(0, 0), null);
  assert.equal(winrate(1, 1), null);
});

