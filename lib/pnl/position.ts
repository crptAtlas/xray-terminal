import type { Trade } from "./classify.ts";

/**
 * Per-token position PnL (spec 3.1). Computed from the token's own trades,
 * never from the wallet balance, so ETH top-ups between trades cannot leak
 * into the result. Realized and unrealized in one number. Opening tax and
 * fees are not part of cost basis (the CurveBuy quoteIn already includes
 * them on the way in; we take the event amounts as-is).
 *
 * A wallet whose tokens did not all come from tracked buys (inbound
 * transfers, or sells+balance exceeding buys) has no known cost basis:
 * flagged unknownBasis, excluded from groups and averages by the caller.
 * A cost basis below MIN_COST_WEI is equally unreliable - dividing by a
 * few wei turns pnl_pct into astronomy - so it is flagged the same way.
 */

export const MIN_COST_WEI = 10n ** 13n; // 0.00001 ETH

export interface Position {
  boughtTokens: bigint;
  boughtCostWei: bigint;
  soldTokens: bigint;
  soldProceedsWei: bigint;
  remaining: bigint;
  pnlWei: bigint;
  pnlPct: number | null;
  unknownBasis: boolean;
  closed: boolean;
}

export function position(
  trades: Trade[],
  transfersInTokens: bigint,
  remaining: bigint,
  priceNowEthPerToken: number,
  decimals: number,
  minCostWei = MIN_COST_WEI,
): Position {
  let boughtTokens = 0n;
  let boughtCostWei = 0n;
  let soldTokens = 0n;
  let soldProceedsWei = 0n;
  for (const t of trades) {
    if (t.kind === "buy") {
      boughtTokens += t.tokens;
      boughtCostWei += t.eth;
    } else {
      soldTokens += t.tokens;
      soldProceedsWei += t.eth;
    }
  }

  // value_now = remaining * price_now, in wei. price is ETH per whole token.
  const one = 10n ** BigInt(decimals);
  const priceWad = BigInt(Math.round(priceNowEthPerToken * 1e18));
  const valueNowWei = (remaining * priceWad) / one;

  const pnlWei = soldProceedsWei + valueNowWei - boughtCostWei;
  // The amounts are summed as doubles in the index, so a wallet that sold
  // exactly what it bought lands a few wei either side of it. Compared
  // exactly, half of those read as tokens that arrived some other way.
  const out = soldTokens + remaining;
  const overBought = out * 1_000_000_000n > boughtTokens * 1_000_000_001n;
  // A cost basis of a few units is unreliable whatever the currency, but
  // the floor has to be read in that currency: two launches in five are
  // quoted in a stock or a stablecoin, and one of those carries eight
  // decimals where ETH carries eighteen. A fixed floor in wei condemned
  // every holder such a token had.
  const tooSmall = boughtCostWei < minCostWei;
  const unknownBasis = transfersInTokens > 0n || overBought || tooSmall;
  const pnlPct = tooSmall ? null : (Number(pnlWei) / Number(boughtCostWei)) * 100;

  return {
    boughtTokens,
    boughtCostWei,
    soldTokens,
    soldProceedsWei,
    remaining,
    pnlWei,
    pnlPct,
    unknownBasis,
    closed: remaining === 0n,
  };
}

