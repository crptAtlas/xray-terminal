import { test } from "node:test";
import assert from "node:assert/strict";
import { cardMood, renderCard } from "../lib/card.ts";

const pos = (pnlPct) => ({
  boughtTokens: 100n,
  boughtCostWei: 10n ** 18n,
  soldTokens: 0n,
  soldProceedsWei: 0n,
  remaining: 100n,
  pnlWei: 0n,
  pnlPct,
  unknownBasis: false,
  closed: false,
});

function result({ holders = 12, avgPnlPct = 40 } = {}) {
  const rows = Array.from({ length: holders }, (_, i) => ({
    wallet: `0x${String(i).padStart(40, "0")}`,
    position: pos(avgPnlPct),
    supplyShare: 0.01,
  }));
  return {
    snapshot: {
      meta: {
        address: "0x1234567890123456789012345678901234cdef00",
        symbol: "TST",
        name: "Test",
        decimals: 18,
        totalSupply: 10n ** 27n,
        curve: "0xc".padEnd(42, "0"),
        deployer: "0xd".padEnd(42, "0"),
        creatorFeeRecipient: "0xf".padEnd(42, "0"),
        createdBlock: 1n,
        createdAt: 1700000000,
        phase: { kind: "curve", fillPct: 74 },
      },
      holders: rows,
      holdersTotal: holders,
      excluded: { dust: 0, unknownBasis: { wallets: 0, supplyShare: 0 }, infra: 0 },
      trades: [],
      syncedBlock: 1000n,
      priceEth: 1e-9,
      usdRate: 2400,
    },
    header: {
      mcapUsd: 1_200_000,
      liquidityUsd: 340_000,
      volume24hUsd: 890_000,
      holders,
      ageMs: 3 * 3_600_000,
      phase: { kind: "curve", fillPct: 74 },
    },
    groups: [{ minPct: 12, maxPct: 17, supplyShare: 0.15, holderShare: 0.058, wallets: 58 }],
    aggregates: {
      avgPnlPct,
      pnlWallets: holders,
      avgWinrate: 65,
      winrateWallets: 8,
      firstTrade: null,
      exited: { wallets: 0, avgPnlPct: null, avgWinrate: null },
    },
    top: rows.slice(0, 3),
    source: { label: "rpc", requests: 10, seconds: 2 },
  };
}

test("mood: green in profit, yellow underwater, red when dead", () => {
  assert.equal(cardMood(result({ avgPnlPct: 40 })), "green");
  assert.equal(cardMood(result({ avgPnlPct: 0 })), "green");
  assert.equal(cardMood(result({ avgPnlPct: -1 })), "yellow");
  assert.equal(cardMood(result({ holders: 9, avgPnlPct: 40 })), "red");
  assert.equal(cardMood(result({ holders: 10, avgPnlPct: 40 })), "green");
});

test("all three moods render a real PNG", () => {
  for (const r of [result(), result({ avgPnlPct: -30 }), result({ holders: 2 })]) {
    const buf = renderCard(r);
    // PNG magic bytes
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.ok(buf.length > 5000, `png too small: ${buf.length}`);
  }
});
