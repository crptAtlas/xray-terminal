/**
 * Wallet badges (spec 3.5). Thresholds live here as config; >= semantics
 * on every boundary. smart is impossible below 30 closed trades.
 */

export const BADGE_CONFIG = {
  smart: { avgPnlPct: 25, winrate: 55, trades: 30 },
  rich: { realizedEth: 5, balanceEth: 10 },
} as const;

export interface BadgeInput {
  trades: number;
  avgPnlPerTrade: number | null;
  winrate: number | null;
  realizedTotalEth: number;
  balanceEth: number;
}

export function badges(p: BadgeInput, config = BADGE_CONFIG): ("smart" | "rich")[] {
  const out: ("smart" | "rich")[] = [];
  if (
    p.trades >= config.smart.trades &&
    p.avgPnlPerTrade !== null &&
    p.avgPnlPerTrade >= config.smart.avgPnlPct &&
    p.winrate !== null &&
    p.winrate >= config.smart.winrate
  ) {
    out.push("smart");
  }
  if (p.realizedTotalEth >= config.rich.realizedEth || p.balanceEth >= config.rich.balanceEth) {
    out.push("rich");
  }
  return out;
}
