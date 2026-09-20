import type { Trade } from "../pnl/classify.ts";
import { MIN_COST_WEI } from "../pnl/position.ts";
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

/** Position summaries from the ledger, the shape the profile math expects. */
export function ledgerPositions(ledger: WalletLedger): PositionSummary[] {
  const out: PositionSummary[] = [];
  for (const p of Object.values(ledger.positions)) {
    const bt = BigInt(p.boughtTokens);
    const bc = BigInt(p.boughtCostWei);
    const st = BigInt(p.soldTokens);
    const sp = BigInt(p.soldProceedsWei);
    const remaining = bt > st ? bt - st : 0n;
    // no honest basis: sold more than bought (tokens arrived some other
    // way) or the cost is dust - skip from the stats, same rule as position()
    if (st > bt || bc < MIN_COST_WEI) continue;
    const valueWei = (remaining * BigInt(p.lastPriceWad)) / 10n ** 18n;
    const pnlWei = sp + valueWei - bc;
    const closed = remaining === 0n;
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
