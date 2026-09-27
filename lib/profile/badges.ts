/**
 * Wallet badges. Thresholds live here as config; >= semantics on every
 * boundary. smart is impossible below 30 closed trades. whale is wealth:
 * the wallet's total balance (ETH plus open token positions) worth
 * $50,000 or more - not a share of any one token's supply.
 */

export const BADGE_CONFIG = {
  smart: { avgPnlPct: 25, winrate: 55, trades: 30 },
  whale: { balanceUsd: 50_000 },
} as const;

export interface BadgeInput {
  trades: number;
  avgPnlPerTrade: number | null;
  winrate: number | null;
  balanceUsd: number;
}

export function badges(p: BadgeInput, config = BADGE_CONFIG): ("smart" | "whale")[] {
  const out: ("smart" | "whale")[] = [];
  if (
    p.trades >= config.smart.trades &&
    p.avgPnlPerTrade !== null &&
    p.avgPnlPerTrade >= config.smart.avgPnlPct &&
    p.winrate !== null &&
    p.winrate >= config.smart.winrate
  ) {
    out.push("smart");
  }
  if (p.balanceUsd >= config.whale.balanceUsd) {
    out.push("whale");
  }
  return out;
}

