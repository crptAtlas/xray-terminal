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
 * What a number means on this chain, measured over every wallet holding
 * two or more positions rather than guessed (scripts/measure-benchmarks,
 * twenty thousand wallets sampled 2026-09-23). Open positions count,
 * marked at the price their market last traded at, which is why the
 * typical record is a loss: most of what a launchpad launches goes down.
 * Winrate is penalized by design (wins / (positions + 1)), so a median
 * trader sits near 20%, not 50.
 *
 *   winrate      p25  0   median  20   p75 33
 *   avg pnl      p25 -56  median -24   p75 -1
 *
 * weak = bottom quartile, strong = top quartile.
 */
export const HOLDER_BENCHMARKS = {
  winrate: { weak: 0, typical: 20, strong: 33 },
  avgPnl: { weak: -56, typical: -23, strong: -1 },
} as const;

/**
 * The grade itself: the holders' own average PnL per trade across Pons,
 * this token excluded. Green is meant to be rare - a room of wallets
 * that averages +50% a trade is a different room from one that averages
 * nothing, and the card should say so.
 */
export const GRADE_THRESHOLDS = {
  // Measured on this chain, open positions included: the median wallet
  // averages -23% a position and only the top quarter is above -1%, so
  // a room that is net up is genuinely rare. Green says exactly that.
  healthy: 0, // holders net ahead across Pons
  cracked: -25, // -25% to 0%: around what the chain itself averages
} as const;

export function gradeOf(
  aggregates: Aggregates,
  holders: HolderRow[],
  dead: boolean,
  config = GRADE_CONFIG,
): Grade {
  if (dead) return "shattered";
  const holding = holders.filter((h) => h.supplyShare > 0 && h.position.pnlPct !== null);
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
