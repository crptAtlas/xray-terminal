import type { Trade } from "../pnl/classify.ts";
import { position } from "../pnl/position.ts";
import { winrate } from "./winrate.ts";
import { badges } from "./badges.ts";

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
  badges: ("smart" | "rich")[];
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
    const remaining = remainingOf(token);
    const decimals = decimalsOf(token);
    // last trade price in ETH per whole token, for open position value
    const last = trades[trades.length - 1];
    const one = 10n ** BigInt(decimals);
    const lastPrice = last && last.tokens > 0n ? Number(last.eth) / 1e18 / (Number(last.tokens) / Number(one)) : 0;
    const pos = position(trades, 0n, remaining, lastPrice, decimals);
    if (pos.unknownBasis) continue; // no honest basis, skip from the stats
    const priceWad = BigInt(Math.round(lastPrice * 1e18));
    const valueWei = pos.closed ? 0n : (remaining * priceWad) / one;
    out.push({
      token,
      trades: trades.length,
      closed: pos.closed,
      pnlPct: pos.pnlPct,
      pnlWei: pos.pnlWei.toString(),
      valueWei: valueWei.toString(),
    });
  }
  return out;
}

/** Fold position summaries into a profile, optionally excluding one token. */
function foldStats(positions: PositionSummary[], exclude?: string) {
  let closed = 0;
  let wins = 0;
  let pnlPctSum = 0;
  let realizedWei = 0n;
  let openValueWei = 0n;
  for (const p of positions) {
    if (exclude && p.token === exclude) continue;
    if (p.closed) {
      closed++;
      const pnlWei = BigInt(p.pnlWei);
      if (pnlWei > 0n) wins++;
      if (p.pnlPct !== null) pnlPctSum += p.pnlPct;
      realizedWei += pnlWei;
    } else {
      openValueWei += BigInt(p.valueWei);
    }
  }
  return { closed, wins, avg: closed > 0 ? pnlPctSum / closed : null, wr: winrate(closed, wins), realizedWei, openValueWei };
}

export function profileFromPositions(
  wallet: string,
  positions: PositionSummary[],
  ethWei: bigint,
  excludeToken?: string,
): Profile {
  const shown = foldStats(positions, excludeToken?.toLowerCase());
  // badges judge the full record, the scanned token included
  const full = excludeToken ? foldStats(positions) : shown;
  const realizedTotalEth = Number(shown.realizedWei) / 1e18;
  const balanceEth = Number(ethWei + shown.openValueWei) / 1e18;
  return {
    wallet: wallet.toLowerCase(),
    trades: shown.closed,
    wins: shown.wins,
    avgPnlPerTrade: shown.avg,
    winrate: shown.wr,
    realizedTotalEth,
    balanceEth,
    badges: badges({
      trades: full.closed,
      avgPnlPerTrade: full.avg,
      winrate: full.wr,
      realizedTotalEth: Number(full.realizedWei) / 1e18,
      balanceEth: Number(ethWei + full.openValueWei) / 1e18,
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
): Profile {
  return profileFromPositions(wallet, buildPositions(byToken, remainingOf, decimalsOf), ethWei, excludeToken);
}
