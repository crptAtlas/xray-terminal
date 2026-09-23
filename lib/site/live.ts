import { Cache } from "../cache.ts";
import { check, type PhaseOne } from "../check.ts";
import type { Profile } from "../profile/profile.ts";
import type { Aggregates } from "../pnl/aggregate.ts";
import { fmtAge, fmtUsd, isDead, DEAD_HOLDERS_MIN } from "../format.ts";
import { gradeOf, type Grade } from "../grade.ts";
import type { HolderRow } from "../read/token.ts";
import { RpcProvider, makeClient, pickProvider } from "../providers/rpc.ts";
import { touchScan } from "../scanflag.ts";
import { resolveTicker, looksLikeAddress } from "../read/launches.ts";
import type { StageEvent } from "../stages.ts";
import type { CardData } from "./types";

// Server-side bridge between the engine and the site. Mode A works with no
// keys at all: holder pnl, bands, header, grade, card. Mode B (Bitquery)
// adds winrate, badges and wallet profiles from the local trade index.

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

/** Every holder the scan knows of reaches the table; the cap is a guard
 * against a payload nobody can render, not a view of the top. */
const MAX_ROWS = 2000;

export interface LiveHolderRow {
  addr: string;
  addrFull: string;
  supply: string;
  pnlHere: string;
  pnlNum: number | null;
  avgPnl: string | null;
  avgPnlNum: number | null;
  winrate: string | null;
  /** positions the wallet has taken across Pons, this token excluded;
   * -1 when the wallet's history was not read in this scan */
  positions: number;
  /** why the holder sits out of the averages, when it does */
  note: "dust" | "no basis" | null;
  badges: { text: string; color: string }[];
}

export interface LiveScan {
  live: true;
  dead: boolean;
  grade: Grade;
  token: { ticker: string; address: string; age: string; stage: string; mcap: string; liquidity: string; vol24h: string; holders: string };
  verdict: {
    // primary: the holders' own avg pnl per closed trade across Pons
    // (scanned token excluded); null until the profile phase lands
    holdersPnl: string | null;
    holdersPnlNum: number | null;
    holdersPnlWallets: number;
    winrate: string | null;
    traced: number | null;
    // this token's current avg pnl - the third metric
    pnl: string;
    pnlNum: number | null;
    median: string | null;
    inProfit: number;
    counted: number;
    hint: string;
  };
  bands: LiveBand[];
  bandCoverage: string;
  holders: LiveHolderRow[];
  exited: { wallets: number; avgPnl: string | null };
  flags: { dust: number; unknownBasis: number; unknownSupplyPct: string; infra: number; firstTrades?: string };
  totalHolders: number;
  profilesRead?: number; // set by the profile phase; 0 means wallet histories were unreachable
  source: { label: string; requests: number; seconds: number };
  card: CardData;
}

const pct = (n: number | null, digits = 1): string => {
  if (n === null) return "—";
  const sign = n >= 0 ? "+" : "−";
  const a = Math.abs(n);
  // sniper pnl can run to millions of percent; keep it short on screen
  if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M%`;
  if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}k%`;
  return `${sign}${a.toFixed(digits)}%`;
};

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function cachePath(): string | undefined {
  // Vercel functions may only write /tmp; locally the default (~/.xray) is fine.
  return process.env.VERCEL ? "/tmp/xray-cache.db" : undefined;
}

export function toLiveScan(phase: PhaseOne, seconds: number, requests: number): LiveScan {
  const { snapshot: s, header: h, groups, aggregates: a } = phase;
  const holding = s.holders.filter((r) => !r.excluded && r.supplyShare > 0);
  const dead = holding.length < DEAD_HOLDERS_MIN;
  const grade = gradeOf(a, s.holders, dead);

  const bands: LiveBand[] = [...groups].sort((x, y) => x.minPct - y.minPct).map((g) => {
    const inBand = s.holders.filter((r) => !r.excluded && r.position.pnlPct !== null && r.position.pnlPct >= g.minPct && r.position.pnlPct <= g.maxPct);
    const avg = inBand.length ? inBand.reduce((sum, r) => sum + (r.position.pnlPct as number), 0) / inBand.length : null;
    const f = (v: number) => {
      const sign = v >= 0 ? "+" : "−";
      const a = Math.abs(v);
      if (a >= 1e6) return `${sign}${(a / 1e6).toFixed(1)}M`;
      if (a >= 1e4) return `${sign}${(a / 1e3).toFixed(1)}k`;
      return `${sign}${a.toFixed(0)}`;
    };
    return {
      supply: Math.round(g.supplyShare * 1000) / 10,
      range: `${f(g.minPct)}..${f(g.maxPct)}%`,
      mid: (g.minPct + g.maxPct) / 2,
      wallets: g.wallets,
      avg: pct(avg),
    };
  });

  const rows: LiveHolderRow[] = s.holders.slice(0, MAX_ROWS).map((r) => ({
    addr: short(r.wallet),
    addrFull: r.wallet,
    // a wallet that sold out holds nothing, and printing that as 0.00%
    // reads as a holder of nothing rather than someone who left; a live
    // holder below a hundredth of a percent gets a floor, not a zero
    supply: r.supplyShare <= 0 ? "exited" : r.supplyShare * 100 < 0.01 ? "<0.01%" : (r.supplyShare * 100).toFixed(2) + "%",
    pnlHere: pct(r.position.pnlPct),
    pnlNum: r.position.pnlPct,
    avgPnl: null,
    avgPnlNum: null,
    winrate: null,
    positions: 0,
    note: r.excluded ?? null,
    badges: [], // SMART / WHALE arrive with the profile phase
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
      stage:
        (h.phase.kind === "curve" ? `curve · ${h.phase.fillPct.toFixed(0)}%` : "graduated") +
        (s.meta.pairSymbol ? ` · ${s.meta.pairSymbol} pair` : ""),
      // stock-paired launches trade in pair-token units; pretending they
      // are dollars would lie, so the usd figures step aside
      mcap: s.meta.pairSymbol ? "n/a" : fmtUsd(h.mcapUsd),
      liquidity: s.meta.pairSymbol ? "n/a" : fmtUsd(h.liquidityUsd),
      vol24h: s.meta.pairSymbol ? "n/a" : fmtUsd(h.volume24hUsd),
      holders: h.holders.toLocaleString("fr-FR").replace(/ /g, " "),
    },
    verdict: {
      holdersPnl: null,
      holdersPnlNum: null,
      holdersPnlWallets: 0,
      winrate: null,
      traced: null,
      pnl: pct(a.avgPnlPct),
      pnlNum: a.avgPnlPct,
      median: a.medianPnlPct === null ? null : pct(a.medianPnlPct),
      inProfit: a.inProfit,
      counted: a.pnlWallets,
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
    // every wallet that still holds, marked ones included: the table
    // counts them, so the caption under it must agree
    totalHolders: s.holdersTotal,
    source: { label: "rpc", requests, seconds },
    card: {
      ticker: `$${s.meta.symbol}`,
      addr: s.meta.address,
      pnl: "—",
      pnlHere: pct(a.avgPnlPct, 1),
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

/** Fold the profile phase into a finished phase-1 scan. */
function withProfiles(
  scan: LiveScan,
  profiles: Map<string, Profile>,
  aggregates: Aggregates,
  seconds: number,
  requests: number,
  scanHolders: HolderRow[],
): LiveScan {
  const holders = scan.holders.map((r) => {
    const p = profiles.get(r.addrFull);
    // the profile phase reads the top wallets by supply; the rest are
    // unread, which the table must not print as "no trades"
    if (!p || p.notRead) return { ...r, positions: -1 };
    const badges = p.badges.map((b) => ({ text: b.toUpperCase(), color: b === "smart" ? "#78DCFF" : "#FFD640" }));
    return {
      ...r,
      avgPnl: p.avgPnlPerTrade === null ? null : pct(p.avgPnlPerTrade),
      avgPnlNum: p.avgPnlPerTrade ?? null,
      positions: p.trades ?? 0,
      winrate: p.winrate === null ? null : p.winrate.toFixed(0) + "%",
      badges,
    };
  });
  // the table is the terminal's argument: sort by the holders' own track
  // record, best traders first; wallets without a record sink to the end
  holders.sort((x, y) => (y.avgPnlNum ?? -Infinity) - (x.avgPnlNum ?? -Infinity));
  const wr = aggregates.avgWinrate;
  const hp = aggregates.avgProfilePnl;
  // the grade waited for the holders' record; recompute it now
  const grade = gradeOf(aggregates, scanHolders, scan.dead);
  const gradeColor = grade === "healthy" ? "#60F080" : grade === "cracked" ? "#FFD640" : "#FF605C";
  const profilesRead = [...profiles.values()].filter((p) => !p.notRead).length;
  const ft = aggregates.firstTrade;
  return {
    ...scan,
    grade,
    holders,
    profilesRead,
    flags: {
      ...scan.flags,
      firstTrades: ft ? `${ft.wallets} (${(ft.supplyShare * 100).toFixed(1)}% supply)` : "—",
    },
    verdict: {
      ...scan.verdict,
      hint: HINTS[grade],
      holdersPnl: hp === null ? null : pct(hp),
      holdersPnlNum: hp,
      holdersPnlWallets: aggregates.profilePnlWallets,
      winrate: wr === null ? null : wr.toFixed(0) + "%",
      traced: aggregates.winrateWallets,
    },
    card: {
      ...scan.card,
      pnl: pct(hp),
      pnlHere: scan.verdict.pnl,
      winrate: wr === null ? "—" : wr.toFixed(0) + "%",
      grade,
      gradeColor,
      gradeLabel: grade.toUpperCase(),
      hint: scan.dead ? "token is dead. you're too early or too late" : HINTS[grade],
    },
    source: { ...scan.source, label: "rpc + index", requests, seconds },
  };
}

// One in-flight scan per token per process: concurrent viewers (the SSE
// terminal, the OG card route, a second tab) subscribe to the same run
// instead of racing each other for RPC slots and the SQLite writer.
const inflight = new Map<string, {
  promise: Promise<LiveScan>;
  listeners: Set<(e: StageEvent) => void>;
  phaseListeners: Set<(p: LiveScan) => void>;
  last: LiveScan | null;
}>();

export function runScan(
  address: string,
  onStage: (e: StageEvent) => void,
  onPhase?: (partial: LiveScan) => void,
): Promise<LiveScan> {
  const key = address.toLowerCase();
  const existing = inflight.get(key);
  if (existing) {
    // a second viewer joins a running scan: it gets the stages from here
    // on, the partial result already computed and every later partial
    existing.listeners.add(onStage);
    if (onPhase) {
      existing.phaseListeners.add(onPhase);
      if (existing.last) onPhase(existing.last);
    }
    return existing.promise;
  }
  const listeners = new Set<(e: StageEvent) => void>([onStage]);
  const phaseListeners = new Set<(p: LiveScan) => void>();
  if (onPhase) phaseListeners.add(onPhase);
  const entry = { listeners, phaseListeners, last: null as LiveScan | null };
  const emit = (p: LiveScan) => {
    entry.last = p;
    phaseListeners.forEach((fn) => fn(p));
  };
  touchScan();
  const promise = (async () => {
    const provider = await pickProvider();
    const cache = new Cache(cachePath());
    const t0 = Date.now();
    try {
      let scan: LiveScan | null = null;
      let snapHolders: HolderRow[] = [];
      for await (const phase of check(provider, cache, key as `0x${string}`, {
        profiles: true,
        profileLimit: MAX_ROWS, // every row the table shows carries a record
        profileDeadlineMs: Number(process.env.XRAY_PROFILE_DEADLINE_MS ?? 90_000),
        onStage: (e) => {
          touchScan(); // hold back any background digger while we read
          listeners.forEach((fn) => fn(e));
        },
      })) {
        if (phase.phase === 1) {
          snapHolders = phase.snapshot.holders;
          scan = toLiveScan(phase, (Date.now() - t0) / 1000, provider.stats().requests);
          emit(scan);
        } else if (scan) {
          // the profile phase arrives in chunks; every chunk is a result
          scan = withProfiles(scan, phase.profiles, phase.aggregates, (Date.now() - t0) / 1000, provider.stats().requests, snapHolders);
          emit(scan);
        }
      }
      if (!scan) throw new Error("scan produced no result");
      return scan;
    } finally {
      cache.close();
      inflight.delete(key);
    }
  })();
  inflight.set(key, { promise, ...entry });
  return promise;
}
