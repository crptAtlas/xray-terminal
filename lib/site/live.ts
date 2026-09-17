import { Cache } from "../cache.ts";
import { check, type PhaseOne } from "../check.ts";
import type { Profile } from "../profile/profile.ts";
import type { Aggregates } from "../pnl/aggregate.ts";
import { fmtAge, fmtUsd, isDead, DEAD_HOLDERS_MIN } from "../format.ts";
import { gradeOf, type Grade } from "../grade.ts";
import { RpcProvider, makeClient, pickProvider } from "../providers/rpc.ts";
import { resolveTicker, looksLikeAddress } from "../read/launches.ts";
import type { StageEvent } from "../stages.ts";
import type { CardData } from "./types";

// Server-side bridge between the engine and the site. Mode A works with no
// keys at all: holder pnl, bands, header, grade, card. Mode B (Bitquery)
// adds winrate, badges and wallet profiles when BITQUERY_TOKEN is set.

const HINTS: Record<Grade, string> = {
  healthy: "holders in profit and they know how to trade",
  cracked: "flat book, average traders - could go either way",
  shattered: "most holders underwater, or everyone already left",
};

export interface LiveBand {
  supply: number;
  range: string;
  mid: number;
  wallets: number;
  avg: string;
}

export interface LiveHolderRow {
  addr: string;
  addrFull: string;
  supply: string;
  pnlHere: string;
  pnlNum: number | null;
  avgPnl: string | null;
  winrate: string | null;
  badges: { text: string; color: string }[];
}

export interface LiveScan {
  live: true;
  dead: boolean;
  grade: Grade;
  token: { ticker: string; address: string; age: string; stage: string; mcap: string; liquidity: string; vol24h: string; holders: string };
  verdict: { pnl: string; pnlNum: number | null; median: string | null; inProfit: number; winrate: string | null; counted: number; traced: number | null; hint: string };
  bands: LiveBand[];
  bandCoverage: string;
  holders: LiveHolderRow[];
  exited: { wallets: number; avgPnl: string | null };
  flags: { dust: number; unknownBasis: number; unknownSupplyPct: string; infra: number };
  totalHolders: number;
  source: { label: string; requests: number; seconds: number };
  card: CardData;
}

const pct = (n: number | null, digits = 1): string => (n === null ? "—" : `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`);

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function cachePath(): string | undefined {
  // Vercel functions may only write /tmp; locally the default (~/.xray) is fine.
  return process.env.VERCEL ? "/tmp/xray-cache.db" : undefined;
}

export function toLiveScan(phase: PhaseOne, seconds: number, requests: number): LiveScan {
  const { snapshot: s, header: h, groups, aggregates: a } = phase;
  const holding = s.holders.filter((r) => r.supplyShare > 0);
  const dead = holding.length < DEAD_HOLDERS_MIN;
  const grade = gradeOf(a, s.holders, dead);

  const bands: LiveBand[] = groups.map((g) => {
    const inBand = s.holders.filter((r) => r.position.pnlPct !== null && r.position.pnlPct >= g.minPct && r.position.pnlPct <= g.maxPct);
    const avg = inBand.length ? inBand.reduce((sum, r) => sum + (r.position.pnlPct as number), 0) / inBand.length : null;
    const f = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`;
    return {
      supply: Math.round(g.supplyShare * 1000) / 10,
      range: `${f(g.minPct)}..${f(g.maxPct)}%`,
      mid: (g.minPct + g.maxPct) / 2,
      wallets: g.wallets,
      avg: pct(avg),
    };
  });

  const rows: LiveHolderRow[] = s.holders.slice(0, 40).map((r) => ({
    addr: short(r.wallet),
    addrFull: r.wallet,
    supply: (r.supplyShare * 100).toFixed(2) + "%",
    pnlHere: pct(r.position.pnlPct),
    pnlNum: r.position.pnlPct,
    avgPnl: null,
    winrate: null,
    badges: r.supplyShare >= 0.01 ? [{ text: "WHALE", color: "#FFD640" }] : [],
  }));

  const exitedAvg = a.exited.avgPnlPct;

  return {
    live: true,
    dead,
    grade,
    token: {
      ticker: `$${s.meta.symbol}`,
      address: s.meta.address,
      age: fmtAge(h.ageMs),
      stage: h.phase.kind === "curve" ? `curve · ${h.phase.fillPct.toFixed(0)}%` : "graduated",
      mcap: fmtUsd(h.mcapUsd),
      liquidity: fmtUsd(h.liquidityUsd),
      vol24h: fmtUsd(h.volume24hUsd),
      holders: h.holders.toLocaleString("fr-FR").replace(/ /g, " "),
    },
    verdict: {
      pnl: pct(a.avgPnlPct),
      pnlNum: a.avgPnlPct,
      median: a.medianPnlPct === null ? null : pct(a.medianPnlPct),
      inProfit: a.inProfit,
      winrate: null,
      counted: a.pnlWallets,
      traced: null,
      hint: HINTS[grade],
    },
    bands,
    bandCoverage: (groups.reduce((sum, g) => sum + g.supplyShare, 0) * 100).toFixed(1) + "%",
    holders: rows,
    exited: { wallets: a.exited.wallets, avgPnl: exitedAvg === null ? null : pct(exitedAvg) },
    flags: {
      dust: s.excluded.dust,
      unknownBasis: s.excluded.unknownBasis.wallets,
      unknownSupplyPct: (s.excluded.unknownBasis.supplyShare * 100).toFixed(1) + "%",
      infra: s.excluded.infra,
    },
    totalHolders: holding.length,
    source: { label: "rpc · mode A", requests, seconds },
    card: {
      ticker: `$${s.meta.symbol}`,
      addr: s.meta.address,
      pnl: pct(a.avgPnlPct, 1),
      winrate: "—",
      grade,
      gradeColor: grade === "healthy" ? "#60F080" : grade === "cracked" ? "#FFD640" : "#FF605C",
      gradeLabel: grade.toUpperCase(),
      hint: dead ? "token is dead. you're too early or too late" : HINTS[grade],
      time: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
      groups: bands.map((b) => ({ supply: b.supply, range: b.range, mid: b.mid, wallets: b.wallets })),
    },
  };
}

export interface ResolveOutcome {
  address?: string;
  picks?: { addr: string; addrFull: string; age: string; stage: string; mcap: string; holders: string }[];
  error?: { kind: "notpons" | "nodata"; message: string };
}

export async function resolveQuery(q: string, cache: Cache): Promise<ResolveOutcome> {
  if (looksLikeAddress(q)) return { address: q.toLowerCase() };
  if (/^0x/i.test(q)) return { error: { kind: "notpons", message: "that is not a full 42-character contract address" } };
  const client = makeClient();
  const symbol = q.replace(/^\$/, "");
  const matches = await resolveTicker(client, cache, symbol);
  if (matches.length === 0) return { error: { kind: "notpons", message: `no Pons launch found for ticker "${q}"` } };
  if (matches.length === 1) return { address: matches[0]!.token };
  return {
    picks: matches.slice(0, 8).map((m) => ({
      addr: short(m.token),
      addrFull: m.token,
      age: `block ${m.block}`,
      stage: "—",
      mcap: "—",
      holders: "—",
    })),
  };
}

/** Fold the profile phase (mode B) into a finished phase-1 scan. */
function withProfiles(
  scan: LiveScan,
  profiles: Map<string, Profile>,
  aggregates: Aggregates,
  seconds: number,
  requests: number,
): LiveScan {
  const holders = scan.holders.map((r) => {
    const p = profiles.get(r.addrFull);
    if (!p || p.notRead) return r;
    const badges = [...r.badges];
    for (const b of p.badges) {
      badges.unshift({ text: b.toUpperCase(), color: b === "smart" ? "#78DCFF" : "#FFD640" });
    }
    return {
      ...r,
      avgPnl: p.avgPnlPerTrade === null ? null : pct(p.avgPnlPerTrade),
      winrate: p.winrate === null ? null : p.winrate.toFixed(0) + "%",
      badges,
    };
  });
  const wr = aggregates.avgWinrate;
  return {
    ...scan,
    holders,
    verdict: {
      ...scan.verdict,
      winrate: wr === null ? null : wr.toFixed(0) + "%",
      traced: aggregates.winrateWallets,
    },
    card: { ...scan.card, winrate: wr === null ? "—" : wr.toFixed(0) + "%" },
    source: { ...scan.source, label: "rpc + bitquery", requests, seconds },
  };
}

// One in-flight scan per token per process: concurrent viewers (the SSE
// terminal, the OG card route, a second tab) subscribe to the same run
// instead of racing each other for RPC slots and the SQLite writer.
const inflight = new Map<string, { promise: Promise<LiveScan>; listeners: Set<(e: StageEvent) => void> }>();

export function runScan(
  address: string,
  onStage: (e: StageEvent) => void,
  onPhase?: (partial: LiveScan) => void,
): Promise<LiveScan> {
  const key = address.toLowerCase();
  const existing = inflight.get(key);
  if (existing) {
    existing.listeners.add(onStage);
    return existing.promise;
  }
  const listeners = new Set<(e: StageEvent) => void>([onStage]);
  const promise = (async () => {
    const provider = await pickProvider();
    const cache = new Cache(cachePath());
    const t0 = Date.now();
    try {
      let scan: LiveScan | null = null;
      for await (const phase of check(provider, cache, key as `0x${string}`, {
        profiles: true,
        profileLimit: 20,
        profileDeadlineMs: 30_000,
        onStage: (e) => listeners.forEach((fn) => fn(e)),
      })) {
        if (phase.phase === 1) {
          scan = toLiveScan(phase, (Date.now() - t0) / 1000, provider.stats().requests);
          onPhase?.(scan);
        } else if (scan) {
          scan = withProfiles(scan, phase.profiles, phase.aggregates, (Date.now() - t0) / 1000, provider.stats().requests);
        }
      }
      if (!scan) throw new Error("scan produced no result");
      return scan;
    } finally {
      cache.close();
      inflight.delete(key);
    }
  })();
  inflight.set(key, { promise, listeners });
  return promise;
}
