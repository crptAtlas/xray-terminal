import type { Aggregates } from "./pnl/aggregate.ts";
import type { HolderRow } from "./read/token.ts";

/**
 * Token grade: the state of the holder base, drawn as one of three
 * skeletons (assets/brand/h-*.png).
 *
 *   healthy    avg pnl above zero and most holders in profit
 *   cracked    mixed picture
 *   shattered  most holders underwater, or the token is dead
 *
 * Thresholds live here next to the group thresholds, not hardcoded at the
 * call sites.
 */

export type Grade = "healthy" | "cracked" | "shattered";

export const GRADE_CONFIG = {
  // share of current holders that must be in profit for "most"
  majority: 0.5,
} as const;

/**
 * What a number means on this chain, measured over every wallet with two
 * or more realized positions rather than guessed
 * (scripts/measure-benchmarks, twenty thousand wallets sampled
 * 2026-09-24). Winrate is penalized by design (wins / (positions + 1)),
 * so a median trader sits near 31%, not 50.
 *
 *   winrate      p25  0   median  31   p75 44
 *   avg pnl      p25 -30  median  -7   p75  9
 *
 * weak = bottom quartile, strong = top quartile.
 */
export const HOLDER_BENCHMARKS = {
  winrate: { weak: 0, typical: 31, strong: 44 },
  avgPnl: { weak: -30, typical: -7, strong: 9 },
} as const;

/**
 * The grade itself: the holders' own average PnL per trade across Pons,
 * this token excluded. Green is meant to be rare - a room of wallets
 * that averages +50% a trade is a different room from one that averages
 * nothing, and the card should say so.
 */
export const GRADE_THRESHOLDS = {
  // The owner's numbers: green has to mean a room that is clearly ahead,
  // not merely above water. On this chain that is the top tenth.
  healthy: 25, // holders averaging +25% a position or better
  cracked: 0, // 0% to +25%: in profit, but not by much
} as const;

/** The three colours, in one place: a number on the card and the same
 * number in the terminal have to agree, and they only do if they read
 * the same thresholds. */
export const GRADE_COLORS = { healthy: "#60F080", cracked: "#FFD640", shattered: "#FF605C" } as const;

/** Where a holders' record sits: the same bands the grade uses. */
export function recordLevel(pnlPct: number | null): Grade {
  if (pnlPct === null) return "shattered";
  if (pnlPct >= GRADE_THRESHOLDS.healthy) return "healthy";
  if (pnlPct >= GRADE_THRESHOLDS.cracked) return "cracked";
  return "shattered";
}

/** Where a winrate sits against what this chain actually does. */
export function winrateLevel(wr: number | null): Grade {
  if (wr === null) return "shattered";
  if (wr >= HOLDER_BENCHMARKS.winrate.strong) return "healthy";
  if (wr >= HOLDER_BENCHMARKS.winrate.typical) return "cracked";
  return "shattered";
}

export function gradeOf(
  aggregates: Aggregates,
  holders: HolderRow[],
  dead: boolean,
  config = GRADE_CONFIG,
): Grade {
  if (dead) return "shattered";
  const holding = holders.filter((h) => !h.excluded && h.supplyShare > 0 && h.position.pnlPct !== null);
  if (holding.length === 0) return "shattered";
  const inProfit = holding.filter((h) => (h.position.pnlPct as number) > 0).length / holding.length;
  // The holders' record is the grade. Until the profile phase lands it
  // is unknown, and the token's own book stands in for it.
  const record = aggregates.avgProfilePnl;
  if (record !== null && record !== undefined) {
    if (record >= GRADE_THRESHOLDS.healthy) return "healthy";
    if (record >= GRADE_THRESHOLDS.cracked) return "cracked";
    return "shattered";
  }
  const avg = aggregates.avgPnlPct ?? 0;
  if (avg > 0 && inProfit > config.majority) return "healthy";
  if (inProfit < 1 - config.majority) return "shattered";
  return "cracked";
}

