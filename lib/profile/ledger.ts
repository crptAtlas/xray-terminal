import type { Trade } from "../pnl/classify.ts";
import type { PositionSummary } from "./profile.ts";

/**
 * Incremental wallet ledger. A position is four running sums (tokens and
 * cost bought, tokens and proceeds sold) plus the last trade price; all
 * of it is additive, so a wallet's record is folded once and only new
 * trades are applied on top afterwards - never recomputed from the
 * first block. The ledger is what gets cached; profile stats derive
 * from it in microseconds.
 */

export interface LedgerPosition {
  token: string;
  trades: number;
  boughtTokens: string; // bigint as string
  boughtCostWei: string;
  soldTokens: string;
  soldProceedsWei: string;
  lastPriceWad: string; // ETH per whole token, 1e18-scaled
}

export interface WalletLedger {
  positions: Record<string, LedgerPosition>;
  syncedBlock: string; // trades up to and including this block are folded
}

export function emptyLedger(): WalletLedger {
  return { positions: {}, syncedBlock: "0" };
}

/** Fold database aggregates (per token sums) into the ledger. The sums
 * arrive as doubles; a position's pnl is a ratio, so the last digits of
 * a wei amount never matter to it. */
export function applyAggregates(
  ledger: WalletLedger,
  byToken: Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>,
  upToBlock: bigint,
): WalletLedger {
  const positions = { ...ledger.positions };
  const big = (v: number): bigint => (Number.isFinite(v) && v > 0 ? BigInt(Math.round(v)) : 0n);
  for (const [token, a] of byToken) {
    const cur = positions[token];
    const bt = (cur ? BigInt(cur.boughtTokens) : 0n) + big(a.buyTokens);
    const bc = (cur ? BigInt(cur.boughtCostWei) : 0n) + big(a.buyEth);
    const st = (cur ? BigInt(cur.soldTokens) : 0n) + big(a.sellTokens);
    const sp = (cur ? BigInt(cur.soldProceedsWei) : 0n) + big(a.sellEth);
    const n = (cur ? cur.trades : 0) + a.trades;
    const last = a.lastPrice > 0 ? BigInt(Math.round(a.lastPrice * 1e18)) : cur ? BigInt(cur.lastPriceWad) : 0n;
    positions[token] = {
      token,
      trades: n,
      boughtTokens: bt.toString(),
      boughtCostWei: bc.toString(),
      soldTokens: st.toString(),
      soldProceedsWei: sp.toString(),
      lastPriceWad: last.toString(),
    };
  }
  return { positions, syncedBlock: upToBlock.toString() };
}

/** Fold new trades (any tokens, ascending block order) into the ledger. */
export function applyTrades(ledger: WalletLedger, byToken: Map<string, Trade[]>, upToBlock: bigint): WalletLedger {
  const positions = { ...ledger.positions };
  for (const [token, trades] of byToken) {
    const cur = positions[token];
    let bt = cur ? BigInt(cur.boughtTokens) : 0n;
    let bc = cur ? BigInt(cur.boughtCostWei) : 0n;
    let st = cur ? BigInt(cur.soldTokens) : 0n;
    let sp = cur ? BigInt(cur.soldProceedsWei) : 0n;
    let n = cur ? cur.trades : 0;
    let last = cur ? BigInt(cur.lastPriceWad) : 0n;
    for (const t of trades) {
      if (t.kind === "buy") {
        bt += t.tokens;
        bc += t.eth;
      } else {
        st += t.tokens;
        sp += t.eth;
      }
      n++;
      if (t.tokens > 0n) last = (t.eth * 10n ** 18n) / t.tokens; // wei per token unit, 18-dec tokens
    }
    positions[token] = {
      token,
      trades: n,
      boughtTokens: bt.toString(),
      boughtCostWei: bc.toString(),
      soldTokens: st.toString(),
      soldProceedsWei: sp.toString(),
      lastPriceWad: last.toString(),
    };
  }
  return { positions, syncedBlock: upToBlock.toString() };
}

/**
 * Position summaries from the ledger, the shape the profile math expects.
 * priceOf gives the price a market last traded at, whoever traded it:
 * what a wallet still holds is worth what the market says, not what its
 * own last trade said weeks ago. Without it the wallet's own last price
 * stands in.
 */
export function ledgerPositions(
  ledger: WalletLedger,
  priceOf?: (token: string) => number | undefined,
): PositionSummary[] {
  const out: PositionSummary[] = [];
  for (const p of Object.values(ledger.positions)) {
    const bt = BigInt(p.boughtTokens);
    const bc = BigInt(p.boughtCostWei);
    const st = BigInt(p.soldTokens);
    const sp = BigInt(p.soldProceedsWei);
    const remaining = bt > st ? bt - st : 0n;
    const market = priceOf?.(p.token);
    const priceWad = market !== undefined && market > 0 ? BigInt(Math.round(market * 1e18)) : BigInt(p.lastPriceWad);
    // no honest basis: sold more than bought, tokens that arrived some
    // other way. A cost of nothing is no basis either; above that the
    // clamped band keeps a rounding-error buy from running away with an
    // average.
    if (st * 1_000_000_000n > bt * 1_000_000_001n || bc <= 0n) continue;
    const valueWei = (remaining * priceWad) / 10n ** 18n;
    const pnlWei = sp + valueWei - bc;
    // sums of doubles never land exactly on zero; a position is closed
    // when what is left is a billionth of what was bought
    const closed = remaining * 1_000_000_000n <= bt;
    out.push({
      token: p.token,
      trades: p.trades,
      closed,
      pnlPct: bc > 0n ? (Number(pnlWei) / Number(bc)) * 100 : null,
      pnlWei: pnlWei.toString(),
      valueWei: valueWei.toString(),
    });
  }
  return out;
}
