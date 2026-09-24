import type { Trade } from "../pnl/classify.ts";
import { position } from "../pnl/position.ts";
import { winrate } from "./winrate.ts";
import { badges } from "./badges.ts";
import type { ProfileStats } from "../cache.ts";

/**
 * Wallet profile (spec 3.5): every trade of the wallet across every token,
 * positions per token by the 3.1 formula, closed when the remaining balance
 * is zero. Pure - the caller supplies trades and balances.
 *
 * A win is a closed position with pnl > 0. balance is the wallet's worth:
 * native ETH plus open token positions valued at the token's last trade
 * price seen in the wallet's own history.
 *
 * The profile can exclude one token: when a token is being scanned, the
 * position its holders have in it must not feed the avg pnl and winrate
 * shown for them there (insiders would decorate the token's stats with
 * their own launch). Badges still look at the full record - a whale or a
 * rich wallet is what it is. Positions are cached per token so the
 * exclusion works against the cache too.
 */

export interface PositionSummary {
  token: string;
  trades: number;
  closed: boolean;
  pnlPct: number | null;
  pnlWei: string; // bigint as string, JSON-safe
  valueWei: string; // open position value at last trade price
}

export interface Profile {
  wallet: string;
  trades: number; // closed positions
  wins: number;
  avgPnlPerTrade: number | null;
  winrate: number | null;
  realizedTotalEth: number;
  balanceEth: number;
  badges: ("smart" | "whale")[];
  notRead?: boolean;
}

/** Per-token position summaries: the cacheable raw material of a profile. */
export function buildPositions(
  byToken: Map<string, Trade[]>,
  remainingOf: (token: string) => bigint,
  decimalsOf: (token: string) => number = () => 18,
): PositionSummary[] {
  const out: PositionSummary[] = [];
  for (const [token, trades] of byToken) {
    let bought = 0n;
    let cost = 0n;
    let sold = 0n;
    let proceeds = 0n;
    for (const t of trades) {
      if (t.kind === "buy") {
        bought += t.tokens;
        cost += t.eth;
      } else {
        sold += t.tokens;
        proceeds += t.eth;
      }
    }
    // realized only, the same rule the folded path uses: what a wallet
    // still holds cannot be checked from its trades
    if (bought <= 0n || sold <= 0n || cost <= 0n) continue;
    if (sold * 1_000_000_000n > bought * 1_000_000_001n) continue; // no honest basis
    const soldCost = (cost * sold) / bought;
    if (soldCost <= 0n) continue;
    const pnlWei = proceeds - soldCost;
    const remaining = remainingOf(token);
    out.push({
      token,
      trades: trades.length,
      closed: remaining * 1_000_000_000n <= bought,
      pnlPct: (Number(pnlWei) / Number(soldCost)) * 100,
      pnlWei: pnlWei.toString(),
      valueWei: "0",
    });
  }
  return out;
}

/** Fold position summaries into a profile, optionally excluding one token. */
function foldStats(positions: PositionSummary[], exclude?: string) {
  let taken = 0;
  let closed = 0;
  let wins = 0;
  let winsClosed = 0;
  let pnlPctSum = 0;
  let realizedWei = 0n;
  let openValueWei = 0n;
  for (const p of positions) {
    if (exclude && p.token === exclude) continue;
    // every position counts toward the average; only a closed one counts
    // toward winrate, where a win has to have been taken
    taken++;
    // one position bought for a rounding error can read as a million
    // percent; every position joins the average inside the same band
    if (p.pnlPct !== null) pnlPctSum += Math.max(-100, Math.min(500, p.pnlPct));
    // every counted position is realized, so its profit is realized too
    const pnlWei = BigInt(p.pnlWei);
    if (pnlWei > 0n) wins++;
    realizedWei += pnlWei;
    if (p.closed) {
      closed++;
      if (pnlWei > 0n) winsClosed++;
    } else {
      openValueWei += BigInt(p.valueWei);
    }
  }
  return { taken, closed, wins, winsClosed, avg: taken > 0 ? pnlPctSum / taken : null, wr: winrate(taken, wins), realizedWei, openValueWei };
}

export function profileFromPositions(
  wallet: string,
  positions: PositionSummary[],
  ethWei: bigint,
  excludeToken?: string,
  ethUsdRate = 0, // 0 = whale badge cannot trigger (rate unknown)
): Profile {
  const shown = foldStats(positions, excludeToken?.toLowerCase());
  // badges judge the full record, the scanned token included
  const full = excludeToken ? foldStats(positions) : shown;
  const realizedTotalEth = Number(shown.realizedWei) / 1e18;
  const balanceEth = Number(ethWei + shown.openValueWei) / 1e18;
  return {
    wallet: wallet.toLowerCase(),
    trades: shown.taken,
    wins: shown.wins,
    avgPnlPerTrade: shown.avg,
    winrate: shown.wr,
    realizedTotalEth,
    balanceEth,
    badges: badges({
      trades: full.closed,
      avgPnlPerTrade: full.avg,
      winrate: full.wr,
      balanceUsd: (Number(ethWei + full.openValueWei) / 1e18) * ethUsdRate,
    }),
  };
}

/**
 * A profile from a record the database folded, rather than from the
 * positions themselves. Same arithmetic as profileFromPositions - the
 * sums simply arrive already added.
 */
export function profileFromStats(
  wallet: string,
  stats: ProfileStats,
  ethWei: bigint,
  ethUsdRate = 0,
): Profile {
  const shown = stats.shown;
  const full = stats.full;
  const ethFloat = Number(ethWei) / 1e18;
  // Every position counts toward the average, open ones marked at the
  // price their market last traded at. Counting only the closed ones
  // left nine holders in ninety with a record: most of a launchpad's
  // holders are still holding.
  return {
    wallet: wallet.toLowerCase(),
    trades: shown.taken,
    wins: shown.wins,
    avgPnlPerTrade: shown.taken > 0 ? shown.pnlPctSum / shown.taken : null,
    winrate: winrate(shown.taken, shown.wins),
    realizedTotalEth: shown.realizedWei / 1e18,
    balanceEth: ethFloat + shown.openValueWei / 1e18,
    badges: badges({
      trades: full.closed,
      avgPnlPerTrade: full.taken > 0 ? full.pnlPctSum / full.taken : null,
      winrate: winrate(full.taken, full.wins),
      balanceUsd: (ethFloat + full.openValueWei / 1e18) * ethUsdRate,
    }),
  };
}

export function buildProfile(
  wallet: string,
  byToken: Map<string, Trade[]>,
  remainingOf: (token: string) => bigint,
  ethWei: bigint,
  decimalsOf: (token: string) => number = () => 18,
  excludeToken?: string,
  ethUsdRate = 0,
): Profile {
  return profileFromPositions(wallet, buildPositions(byToken, remainingOf, decimalsOf), ethWei, excludeToken, ethUsdRate);
}
