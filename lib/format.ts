import { existsSync, writeFileSync } from "node:fs";
import type { Aggregates } from "./pnl/aggregate.ts";
import type { Group } from "./pnl/groups.ts";
import type { Header } from "./read/header.ts";
import type { HolderRow, TokenSnapshot } from "./read/token.ts";

/**
 * Output: text (the spec 6 layout), json, markdown. Monospace text, no
 * emoji. writeOutput refuses to overwrite an existing file.
 */

export interface TopHolderExtra {
  avgPnlPerTrade: number | null;
  winrate: number | null;
  trades: number | null;
  badges: string[];
  notRead?: boolean;
}

export interface CheckResult {
  snapshot: TokenSnapshot;
  header: Header;
  groups: Group[];
  aggregates: Aggregates;
  top: HolderRow[];
  topExtras?: Map<string, TopHolderExtra>;
  source: { label: string; requests: number; seconds: number };
  demo?: boolean;
}

const short = (a: string) => `${a.slice(0, 6)}..${a.slice(-4)}`;

// Below this many current holders the token is not worth averaging.
export const DEAD_HOLDERS_MIN = 5;
export const DEAD_LINE = "Token is dead. You're too early or too late";

export function isDead(r: CheckResult): boolean {
  return r.snapshot.holders.filter((h) => h.supplyShare > 0).length < DEAD_HOLDERS_MIN;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return "-";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

export function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const pct = (n: number | null, digits = 0): string =>
  n === null ? "-" : `${n >= 0 ? "+" : ""}${n.toFixed(digits)}%`;

function phaseStr(phase: Header["phase"]): string {
  return phase.kind === "curve" ? `curve ${phase.fillPct.toFixed(0)}%` : "graduated";
}

function textCheck(r: CheckResult): string {
  const { snapshot: s, header: h, aggregates: a } = r;
  const lines: string[] = [];
  if (r.demo) lines.push("DEMO  fixture data, not the live chain");
  lines.push(
    `$${s.meta.symbol}  ${s.meta.address}  age ${fmtAge(h.ageMs)}  phase ${phaseStr(h.phase)}`,
  );
  lines.push(
    `mcap ${fmtUsd(h.mcapUsd)}   liquidity ${fmtUsd(h.liquidityUsd)}   volume 24h ${fmtUsd(h.volume24hUsd)}   holders ${h.holders.toLocaleString("en-US").replace(/,/g, " ")}`,
  );
  lines.push("");
  if (isDead(r)) {
    lines.push(DEAD_LINE);
    lines.push("");
  } else {
    lines.push(`avg pnl  ${pct(a.avgPnlPct)}        across ${a.pnlWallets} wallets`);
    if (a.avgWinrate !== null) {
      lines.push(`winrate   ${a.avgWinrate.toFixed(0)}%        across ${a.winrateWallets} wallets with 2+ trades`);
    }
    lines.push("");
    r.groups.forEach((g, i) => {
      lines.push(
        `group ${i + 1}   ${g.minPct >= 0 ? "+" : ""}${g.minPct.toFixed(0)}..${g.maxPct.toFixed(0)}%   ${(g.supplyShare * 100).toFixed(0)}% of supply   ${g.wallets} wallets`,
      );
    });
    if (r.groups.length === 0) lines.push("no dense pnl groups");
    lines.push("");
  }
  if (r.top.length > 0) lines.push("top holders");
  r.top.forEach((t, i) => {
    const ex = r.topExtras?.get(t.wallet);
    let profilePart = "";
    if (ex) {
      if (ex.notRead) profilePart = "   not read";
      else {
        const parts: string[] = [];
        if (ex.avgPnlPerTrade !== null) parts.push(`avg ${pct(ex.avgPnlPerTrade)}/trade`);
        if (ex.winrate !== null) parts.push(`${ex.winrate.toFixed(0)}% wr`);
        if (ex.trades !== null) parts.push(`${ex.trades} trades`);
        if (ex.badges.length) parts.push(ex.badges.map((b) => `[${b}]`).join(""));
        profilePart = parts.length ? "   " + parts.join("   ") : "";
      }
    }
    lines.push(
      `  #${i + 1}  ${short(t.wallet)}   ${(t.supplyShare * 100).toFixed(1)}% supply   pnl ${pct(t.position.pnlPct)}${profilePart}`,
    );
  });
  lines.push("");
  const ex = a.exited;
  lines.push(
    `exited      ${ex.wallets} wallets` +
      (ex.avgPnlPct !== null ? `, avg pnl ${pct(ex.avgPnlPct)}` : "") +
      (ex.avgWinrate !== null ? `, avg winrate ${ex.avgWinrate.toFixed(0)}%` : ""),
  );
  if (a.firstTrade) {
    lines.push(
      `first trade  ${a.firstTrade.wallets} wallets hold ${(a.firstTrade.supplyShare * 100).toFixed(1)}% of supply`,
    );
  }
  const e = s.excluded;
  lines.push(
    `excluded    dust ${e.dust} wallets, unknown basis ${e.unknownBasis.wallets} wallets (${(e.unknownBasis.supplyShare * 100).toFixed(1)}% supply), infra ${e.infra} addresses`,
  );
  lines.push("");
  lines.push(`source ${r.source.label}   ${r.source.requests} requests   ${r.source.seconds.toFixed(1)}s`);
  return lines.join("\n");
}

function jsonCheck(r: CheckResult): string {
  const { snapshot: s } = r;
  return JSON.stringify(
    {
      demo: r.demo ?? false,
      dead: isDead(r),
      token: {
        address: s.meta.address,
        symbol: s.meta.symbol,
        phase: s.meta.phase,
      },
      header: r.header,
      aggregates: r.aggregates,
      groups: r.groups,
      holders: s.holders.map((h) => ({
        wallet: h.wallet,
        supplyShare: h.supplyShare,
        pnlPct: h.position.pnlPct,
        pnlWei: h.position.pnlWei.toString(),
        closed: h.position.closed,
      })),
      excluded: s.excluded,
      source: r.source,
    },
    (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    2,
  );
}

function markdownCheck(r: CheckResult): string {
  const { snapshot: s, header: h, aggregates: a } = r;
  const lines: string[] = [];
  if (r.demo) lines.push("> DEMO: fixture data, not the live chain", "");
  lines.push(`# $${s.meta.symbol}`);
  lines.push("");
  lines.push(`\`${s.meta.address}\`  age ${fmtAge(h.ageMs)}  phase ${phaseStr(h.phase)}`);
  lines.push("");
  if (isDead(r)) {
    lines.push(`**${DEAD_LINE}**`);
    lines.push("");
  }
  lines.push("| mcap | liquidity | volume 24h | holders |");
  lines.push("|---|---|---|---|");
  lines.push(`| ${fmtUsd(h.mcapUsd)} | ${fmtUsd(h.liquidityUsd)} | ${fmtUsd(h.volume24hUsd)} | ${h.holders} |`);
  lines.push("");
  lines.push(`avg pnl ${pct(a.avgPnlPct)} across ${a.pnlWallets} wallets` +
    (a.avgWinrate !== null ? `; winrate ${a.avgWinrate.toFixed(0)}% across ${a.winrateWallets} wallets` : ""));
  lines.push("");
  if (r.groups.length) {
    lines.push("| group | pnl | supply | wallets |");
    lines.push("|---|---|---|---|");
    r.groups.forEach((g, i) =>
      lines.push(`| ${i + 1} | ${g.minPct >= 0 ? "+" : ""}${g.minPct.toFixed(0)}..${g.maxPct.toFixed(0)}% | ${(g.supplyShare * 100).toFixed(0)}% | ${g.wallets} |`),
    );
    lines.push("");
  }
  lines.push("| # | wallet | supply | pnl |");
  lines.push("|---|---|---|---|");
  r.top.forEach((t, i) =>
    lines.push(`| ${i + 1} | \`${short(t.wallet)}\` | ${(t.supplyShare * 100).toFixed(1)}% | ${pct(t.position.pnlPct)} |`),
  );
  return lines.join("\n");
}

export function formatCheck(r: CheckResult, fmt: "text" | "json" | "markdown"): string {
  if (fmt === "json") return jsonCheck(r);
  if (fmt === "markdown") return markdownCheck(r);
  return textCheck(r);
}

export function writeOutput(text: string, file?: string): void {
  if (!file) {
    console.log(text);
    return;
  }
  if (existsSync(file)) {
    throw new Error(`refusing to overwrite existing file: ${file}`);
  }
  writeFileSync(file, text + "\n");
  console.error(`written to ${file}`);
}
