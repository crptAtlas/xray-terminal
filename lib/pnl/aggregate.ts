import type { HolderRow } from "../read/token.ts";

/**
 * Token aggregates (spec 3.6). avg_pnl over every holder that survived the
 * filters (dust, infra and unknown_basis never reach HolderRow). avg_winrate
 * only over wallets whose chain-wide history has 2+ trades — that needs
 * wallet profiles, so in rpc mode the winrate side stays null.
 */

// The slice of a wallet profile the aggregates need. Full profiles live in
// lib/profile/profile.ts (mode B); rpc mode has none.
export interface ProfileLite {
  trades: number;
  winrate: number | null;
}

export interface Aggregates {
  avgPnlPct: number | null;
  pnlWallets: number;
  avgWinrate: number | null;
  winrateWallets: number;
  firstTrade: { wallets: number; supplyShare: number } | null; // needs profiles
  exited: { wallets: number; avgPnlPct: number | null; avgWinrate: number | null };
}

const mean = (xs: number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;

export function aggregate(rows: HolderRow[], profiles?: Map<string, ProfileLite>): Aggregates {
  const pnls = rows.map((r) => r.position.pnlPct).filter((p): p is number => p !== null);

  let avgWinrate: number | null = null;
  let winrateWallets = 0;
  let firstTrade: Aggregates["firstTrade"] = null;
  if (profiles) {
    const wrs: number[] = [];
    let ftWallets = 0;
    let ftSupply = 0;
    for (const r of rows) {
      const p = profiles.get(r.wallet);
      if (!p) continue;
      if (p.trades >= 2 && p.winrate !== null) wrs.push(p.winrate);
      if (p.trades === 0) {
        ftWallets++;
        ftSupply += r.supplyShare;
      }
    }
    avgWinrate = mean(wrs);
    winrateWallets = wrs.length;
    firstTrade = { wallets: ftWallets, supplyShare: ftSupply };
  }

  const exitedRows = rows.filter((r) => r.position.closed && r.position.boughtTokens > 0n);
  const exitedPnls = exitedRows.map((r) => r.position.pnlPct).filter((p): p is number => p !== null);
  let exitedWr: number | null = null;
  if (profiles) {
    const wrs = exitedRows
      .map((r) => profiles.get(r.wallet))
      .filter((p): p is ProfileLite => !!p && p.trades >= 2 && p.winrate !== null)
      .map((p) => p.winrate as number);
    exitedWr = mean(wrs);
  }

  return {
    avgPnlPct: mean(pnls),
    pnlWallets: pnls.length,
    avgWinrate,
    winrateWallets,
    firstTrade,
    exited: { wallets: exitedRows.length, avgPnlPct: mean(exitedPnls), avgWinrate: exitedWr },
  };
}
