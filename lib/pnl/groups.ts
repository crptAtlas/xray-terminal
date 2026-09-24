/**
 * Holder groups (spec 3.4): at most three groups, each no wider than 5
 * percentage points of pnl_pct, chosen to maximize the share of supply
 * inside the group. Sliding window over pnl-sorted holders; up to three
 * non-overlapping windows picked greedily by supply share. A single wallet
 * is not a cluster.
 */

export interface GroupInput {
  pnlPct: number;
  supplyShare: number; // 0..1
}

export interface Group {
  minPct: number;
  maxPct: number;
  supplyShare: number;
  holderShare: number;
  wallets: number;
}

export function findGroups(rows: GroupInput[], maxGroups = 3, widthPct = 5): Group[] {
  const sorted = rows
    .filter((r) => Number.isFinite(r.pnlPct))
    .slice()
    .sort((a, b) => a.pnlPct - b.pnlPct);
  const n = sorted.length;
  if (n < 2) return [];

  // all candidate windows [i..j] with pnl span <= widthPct
  interface Win {
    i: number;
    j: number;
    supply: number;
  }
  const wins: Win[] = [];
  let j = 0;
  let supply = 0;
  for (let i = 0; i < n; i++) {
    if (j < i) {
      j = i;
      supply = 0;
    }
    while (j < n && (sorted[j]!.pnlPct - sorted[i]!.pnlPct) <= widthPct) {
      supply += sorted[j]!.supplyShare;
      j++;
    }
    // window is [i, j-1]
    if (j - i >= 2) wins.push({ i, j: j - 1, supply });
    supply -= sorted[i]!.supplyShare;
  }

  wins.sort((a, b) => b.supply - a.supply);

  const chosen: Win[] = [];
  for (const w of wins) {
    if (chosen.length >= maxGroups) break;
    if (chosen.some((c) => !(w.j < c.i || w.i > c.j))) continue; // overlaps
    chosen.push(w);
  }

  chosen.sort((a, b) => b.supply - a.supply);
  const total = rows.length;
  return chosen.map((w) => {
    const slice = sorted.slice(w.i, w.j + 1);
    return {
      minPct: slice[0]!.pnlPct,
      maxPct: slice[slice.length - 1]!.pnlPct,
      supplyShare: slice.reduce((s, r) => s + r.supplyShare, 0),
      holderShare: slice.length / total,
      wallets: slice.length,
    };
  });
}

