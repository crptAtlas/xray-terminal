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
  if (avg > 0 && inProfit > config.majority) return "healthy";
  if (inProfit < 1 - config.majority) return "shattered";
  return "cracked";
}
