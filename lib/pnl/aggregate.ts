import type { HolderRow } from "../read/token.ts";

/**
 * Token aggregates (spec 3.6), supply-weighted: a holder's contribution to
 * avg_pnl and avg_winrate is proportional to the share of supply they hold.
 * For the average, each wallet's pnl is clamped to [-100%, +500%]: one
 * first-block sniper at +12000% with dust supply must not steer the token
 * metric (their honest pnl still shows in the holder table). The median is
 * reported next to the average as the outlier-proof view of the crowd.
 * A wallet with 5% of supply moves the average five times harder than one
 * with 1%. Wallets that exited (share 0) do not pull the current averages;
 * they get their own `exited` line, unweighted. A dead token where everyone
 * exited shows no current average - the exited line carries the story.
 *
 * avg_winrate needs wallet profiles (2+ chain-wide trades); it fills in
 * during the profile phase and stays null before it.
 */

// The slice of a wallet profile the aggregates need. Full profiles live
// in lib/profile/profile.ts.
export interface ProfileLite {
  trades: number;
  winrate: number | null;
  avgPnlPerTrade?: number | null;
  notRead?: boolean; // missed the profile deadline; never counted anywhere
}

export const AVG_CLAMP = { min: -100, max: 500 } as const;

export interface Aggregates {
  avgPnlPct: number | null;
  medianPnlPct: number | null;
  inProfit: number; // current holders with pnl above zero
  pnlWallets: number;
  avgWinrate: number | null;
  winrateWallets: number;
  // the terminal's primary metric: supply-weighted avg of the holders'
  // own avg pnl per closed trade across Pons, the scanned token excluded
  avgProfilePnl: number | null;
  profilePnlWallets: number;
  firstTrade: { wallets: number; supplyShare: number } | null; // needs profiles
  exited: { wallets: number; avgPnlPct: number | null; avgWinrate: number | null };
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

function weightedMean(pairs: { value: number; weight: number }[]): number | null {
  if (pairs.length === 0) return null;
  const totalWeight = pairs.reduce((s, p) => s + p.weight, 0);
  // callers only pass weights > 0; the guard is numerical safety
  if (totalWeight <= 0) return mean(pairs.map((p) => p.value));
  return pairs.reduce((s, p) => s + p.value * p.weight, 0) / totalWeight;
}

export function aggregate(rows: HolderRow[], profiles?: Map<string, ProfileLite>): Aggregates {
  // current holders only: an exited wallet (share 0) must not steer the
  // averages of what is being held right now
  const holding = rows.filter((r) => r.supplyShare > 0);
  const pnls = holding
    .filter((r) => r.position.pnlPct !== null)
    .map((r) => ({ value: r.position.pnlPct as number, weight: r.supplyShare }));
  const pnlPairs = pnls.map((p) => ({
    value: Math.max(AVG_CLAMP.min, Math.min(AVG_CLAMP.max, p.value)),
    weight: p.weight,
  }));
  const sorted = pnls.map((p) => p.value).sort((a, b) => a - b);
  const medianPnlPct =
    sorted.length === 0
      ? null
      : sorted.length % 2
        ? sorted[(sorted.length - 1) / 2]!
        : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const inProfit = pnls.filter((p) => p.value > 0).length;

  let avgWinrate: number | null = null;
  let winrateWallets = 0;
  let avgProfilePnl: number | null = null;
  let profilePnlWallets = 0;
  let firstTrade: Aggregates["firstTrade"] = null;
  if (profiles) {
    const wrPairs: { value: number; weight: number }[] = [];
    const ppPairs: { value: number; weight: number }[] = [];
    let ftWallets = 0;
    let ftSupply = 0;
    for (const r of holding) {
      const p = profiles.get(r.wallet);
      if (!p || p.notRead) continue;
      if (p.trades >= 2 && p.winrate !== null) {
        wrPairs.push({ value: p.winrate, weight: r.supplyShare });
      }
      const app = p.avgPnlPerTrade;
      if (p.trades >= 1 && app !== null && app !== undefined) {
        ppPairs.push({
          value: Math.max(AVG_CLAMP.min, Math.min(AVG_CLAMP.max, app)),
          weight: r.supplyShare,
        });
      }
      if (p.trades === 0) {
        ftWallets++;
        ftSupply += r.supplyShare;
      }
    }
    avgWinrate = weightedMean(wrPairs);
    winrateWallets = wrPairs.length;
    avgProfilePnl = weightedMean(ppPairs);
    profilePnlWallets = ppPairs.length;
    firstTrade = { wallets: ftWallets, supplyShare: ftSupply };
  }

  const exitedRows = rows.filter((r) => r.position.closed && r.position.boughtTokens > 0n);
  const exitedPnls = exitedRows.map((r) => r.position.pnlPct).filter((p): p is number => p !== null);
  let exitedWr: number | null = null;
  if (profiles) {
    const wrs = exitedRows
      .map((r) => profiles.get(r.wallet))
      .filter((p): p is ProfileLite => !!p && !p.notRead && p.trades >= 2 && p.winrate !== null)
      .map((p) => p.winrate as number);
    exitedWr = mean(wrs);
  }

  return {
    avgPnlPct: weightedMean(pnlPairs),
    medianPnlPct,
    inProfit,
    pnlWallets: pnlPairs.length,
    avgWinrate,
    winrateWallets,
    avgProfilePnl,
    profilePnlWallets,
    firstTrade,
    exited: { wallets: exitedRows.length, avgPnlPct: mean(exitedPnls), avgWinrate: exitedWr },
  };
}
