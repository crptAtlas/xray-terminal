import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCheck, writeOutput, fmtUsd, fmtAge, DEAD_LINE, isDead } from "../lib/format.ts";

function sampleResult() {
  const pos = (pnlPct, closed = false) => ({
    boughtTokens: 100n,
    boughtCostWei: 10n ** 18n,
    soldTokens: 0n,
    soldProceedsWei: 0n,
    remaining: closed ? 0n : 100n,
    pnlWei: 5n * 10n ** 17n,
    pnlPct,
    unknownBasis: false,
    closed,
  });
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
      holders: [
        { wallet: "0x1234567890123456789012345678901234abcdef", position: pos(180), supplyShare: 0.042 },
        { wallet: "0x2".padEnd(42, "0"), position: pos(10), supplyShare: 0.02 },
        { wallet: "0x3".padEnd(42, "0"), position: pos(15), supplyShare: 0.02 },
        { wallet: "0x4".padEnd(42, "0"), position: pos(-5), supplyShare: 0.01 },
        { wallet: "0x5".padEnd(42, "0"), position: pos(40), supplyShare: 0.01 },
        ...Array.from({ length: 7 }, (_, i) => ({
          wallet: `0x${String(i + 6).padStart(40, "0")}`,
          position: pos(20),
          supplyShare: 0.005,
        })),
      ],
      holdersTotal: 1043,
      excluded: { dust: 412, unknownBasis: { wallets: 14, supplyShare: 0.031 }, infra: 6 },
      trades: [],
      syncedBlock: 1000n,
      priceEth: 1e-9,
      usdRate: 2400,
    },
    header: {
      mcapUsd: 1_200_000,
      liquidityUsd: 340_000,
      volume24hUsd: 890_000,
      holders: 1043,
      ageMs: (3 * 60 + 12) * 60 * 1000,
      phase: { kind: "curve", fillPct: 74 },
    },
    groups: [
      { minPct: 12, maxPct: 17, supplyShare: 0.15, holderShare: 0.058, wallets: 58 },
      { minPct: -65, maxPct: -60, supplyShare: 0.11, holderShare: 0.034, wallets: 34 },
    ],
    aggregates: {
      avgPnlPct: 40,
      pnlWallets: 1002,
      avgWinrate: null,
      winrateWallets: 0,
      firstTrade: null,
      exited: { wallets: 340, avgPnlPct: 22, avgWinrate: null },
    },
    top: [
      { wallet: "0x1234567890123456789012345678901234abcdef", position: pos(180), supplyShare: 0.042 },
    ],
    source: { label: "rpc", requests: 34, seconds: 18.2 },
  };
}

test("text format follows the spec layout", () => {
  const out = formatCheck(sampleResult(), "text");
  assert.match(out, /^\$TST {2}0x1234/m);
  assert.match(out, /age 3h 12m {2}phase curve 74%/);
  assert.match(out, /mcap \$1\.2M {3}liquidity \$340k {3}volume 24h \$890k {3}holders 1 043/);
  assert.match(out, /avg pnl {2}\+40% {8}across 1002 wallets/);
  assert.match(out, /group 1 {3}\+12\.\.17% {3}15% of supply {3}58 wallets/);
  assert.match(out, /#1 {2}0x1234\.\.cdef {3}4\.2% supply {3}pnl \+180%/);
  assert.match(out, /exited {6}340 wallets, avg pnl \+22%/);
  assert.match(out, /excluded {4}dust 412 wallets, unknown basis 14 wallets \(3\.1% supply\), infra 6 addresses/);
  assert.match(out, /source rpc {3}34 requests {3}18\.2s/);
  assert.doesNotMatch(out, /winrate/, "no winrate line in rpc mode");
});

test("json format roundtrips and has no bigints", () => {
  const out = formatCheck(sampleResult(), "json");
  const parsed = JSON.parse(out);
  assert.equal(parsed.token.symbol, "TST");
  assert.equal(parsed.holders[0].pnlWei, "500000000000000000");
});

test("markdown format has tables", () => {
  const out = formatCheck(sampleResult(), "markdown");
  assert.match(out, /\| mcap \| liquidity \|/);
});

test("demo flag marks the output", () => {
  const r = sampleResult();
  r.demo = true;
  assert.match(formatCheck(r, "text"), /^DEMO/);
});

test("dead token: under 10 current holders replaces the stats block", () => {
  const r = sampleResult();
  r.snapshot.holders = r.snapshot.holders.slice(0, 2);
  r.top = r.snapshot.holders;
  assert.equal(isDead(r), true);
  const out = formatCheck(r, "text");
  assert.match(out, /Token is dead\. You're too early or too late/);
  assert.doesNotMatch(out, /^avg pnl/m);
  assert.doesNotMatch(out, /group 1/);
  const parsed = JSON.parse(formatCheck(r, "json"));
  assert.equal(parsed.dead, true);
  assert.match(formatCheck(r, "markdown"), new RegExp(DEAD_LINE.replace(".", "\\.")));
});

test("exited-only holders count as dead too", () => {
  const r = sampleResult();
  r.snapshot.holders = r.snapshot.holders.map((h) => ({ ...h, supplyShare: 0 }));
  assert.equal(isDead(r), true);
});

test("writeOutput refuses to overwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "xray-"));
  const f = join(dir, "out.txt");
  writeOutput("hello", f);
  assert.equal(readFileSync(f, "utf8"), "hello\n");
  assert.throws(() => writeOutput("again", f), /refusing to overwrite/);
});

test("fmt helpers", () => {
  assert.equal(fmtUsd(1_234_567), "$1.2M");
  assert.equal(fmtUsd(43_210), "$43k");
  assert.equal(fmtAge(3 * 86_400_000 + 5 * 3_600_000), "3d 5h");
});
