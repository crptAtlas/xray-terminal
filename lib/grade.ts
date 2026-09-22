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
 * or more closed trades rather than guessed. Winrate is penalized by
 * design (wins / (trades + 1)), so a median trader sits near 36%, not 50.
 *
 *   winrate      p25 27   median 36   p75 49
 *   avg pnl      p25 -13  median  0   p75 11
 *
 * weak = bottom quartile, strong = top quartile.
 */
export const HOLDER_BENCHMARKS = {
  winrate: { weak: 27, typical: 36, strong: 49 },
  avgPnl: { weak: -13, typical: 0, strong: 11 },
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
  const avg = aggregates.avgPnlPct ?? 0;
  const tokenHealthy = avg > 0 && inProfit > config.majority;
  const tokenBroken = inProfit < 1 - config.majority;

  // The holders' own record decides too: a token whose holders lose
  // everywhere is not healthy, however green its own chart looks. The
  // record is only known after the profile phase, so before it the grade
  // rests on the token alone.
  const record = aggregates.avgProfilePnl;
  const wr = aggregates.avgWinrate;
  const knowsHow =
    record === null || record === undefined
      ? null
      : record >= HOLDER_BENCHMARKS.avgPnl.typical && (wr === null || wr >= HOLDER_BENCHMARKS.winrate.weak);

  if (tokenHealthy && knowsHow !== false) return "healthy";
  if (tokenBroken) return "shattered";
  return "cracked";
}
