import type { Trade } from "../pnl/classify.ts";
import { position } from "../pnl/position.ts";
import { winrate } from "./winrate.ts";
import { badges } from "./badges.ts";

/**
 * Wallet profile (spec 3.5): every trade of the wallet across every token,
 * positions per token by the 3.1 formula, closed when the remaining balance
 * is zero. Pure — the caller supplies trades and balances.
 *
 * A win is a closed position with pnl > 0. balance is the wallet's worth:
 * native ETH plus open token positions valued at the token's last trade
 * price seen in the wallet's own history (the cube gives no better price
 * without one query per token).
 */

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

export function buildProfile(
  wallet: string,
  byToken: Map<string, Trade[]>,
  remainingOf: (token: string) => bigint,
  ethWei: bigint,
  decimalsOf: (token: string) => number = () => 18,
): Profile {
  let closed = 0;
  let wins = 0;
  let pnlPctSum = 0;
  let realizedWei = 0n;
  let openValueWei = 0n;

  for (const [token, trades] of byToken) {
    const remaining = remainingOf(token);
    const decimals = decimalsOf(token);
    // last trade price in ETH per whole token, for open position value
    const last = trades[trades.length - 1];
    const one = 10n ** BigInt(decimals);
    const lastPrice = last && last.tokens > 0n ? Number(last.eth) / 1e18 / (Number(last.tokens) / Number(one)) : 0;
    const pos = position(trades, 0n, remaining, lastPrice, decimals);
    if (pos.unknownBasis) continue; // no honest basis, skip from the stats
    if (pos.closed) {
      closed++;
      if (pos.pnlWei > 0n) wins++;
      if (pos.pnlPct !== null) pnlPctSum += pos.pnlPct;
      realizedWei += pos.pnlWei;
    } else {
      const priceWad = BigInt(Math.round(lastPrice * 1e18));
      openValueWei += (remaining * priceWad) / one;
    }
  }

  const wr = winrate(closed, wins);
  const avg = closed > 0 ? pnlPctSum / closed : null;
  const realizedTotalEth = Number(realizedWei) / 1e18;
  const balanceEth = Number(ethWei + openValueWei) / 1e18;
  const profile: Profile = {
    wallet: wallet.toLowerCase(),
    trades: closed,
    wins,
    avgPnlPerTrade: avg,
    winrate: wr,
    realizedTotalEth,
    balanceEth,
    badges: [],
  };
  profile.badges = badges({
    trades: closed,
    avgPnlPerTrade: avg,
    winrate: wr,
    realizedTotalEth,
    balanceEth,
  });
  return profile;
}
