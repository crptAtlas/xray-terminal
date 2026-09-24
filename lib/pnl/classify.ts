import type { QuoteEvent, RawTransfer } from "../providers/provider.ts";

/**
 * Buy/sell detection (spec 3.3). The transaction signer is almost always a
 * relayer, so the trader is identified by token movement, never by tx.from.
 *
 * market = the token's curve + pool + routers. Token out of market -> buy
 * (buyer = recipient); token into market -> sell (seller = sender); both
 * sides outside market -> plain transfer, not a trade.
 *
 * The ETH quote comes from CurveBuy/CurveSell for curve trades, from the v4
 * swap for pool trades and as a fallback from the largest WETH transfer in
 * the same transaction. Quotes are matched per transaction; when one tx
 * carries several trades, quotes are consumed in order by kind and token
 * amount proximity.
 */

export interface Trade {
  wallet: string;
  kind: "buy" | "sell";
  tokens: bigint;
  eth: bigint;
  block: bigint;
  tx: string;
}

export interface TransferIn {
  wallet: string;
  tokens: bigint;
}

export interface Classified {
  trades: Trade[];
  transfersIn: TransferIn[];
}

const QUOTE_PRIORITY: Record<QuoteEvent["kind"], number> = {
  curveBuy: 0,
  curveSell: 0,
  swap: 1,
  weth: 2,
};

function pickQuote(
  pool: QuoteEvent[],
  used: Set<QuoteEvent>,
  side: "buy" | "sell",
  tokens: bigint,
): QuoteEvent | undefined {
  const wantCurve = side === "buy" ? "curveBuy" : "curveSell";
  const candidates = pool
    .filter((q) => !used.has(q))
    .filter((q) => q.kind === wantCurve || q.kind === "swap" || q.kind === "weth")
    .sort((a, b) => {
      const p = QUOTE_PRIORITY[a.kind] - QUOTE_PRIORITY[b.kind];
      if (p !== 0) return p;
      // Prefer the quote whose claimed token amount matches the transfer.
      const da = a.tokens !== undefined ? abs(a.tokens - tokens) : tokens;
      const db = b.tokens !== undefined ? abs(b.tokens - tokens) : tokens;
      return da < db ? -1 : da > db ? 1 : 0;
    });
  return candidates[0];
}

const abs = (x: bigint) => (x < 0n ? -x : x);

export function classify(
  transfers: RawTransfer[],
  quotes: QuoteEvent[],
  market: ReadonlySet<string>,
): Classified {
  const quotesByTx = new Map<string, QuoteEvent[]>();
  for (const q of quotes) {
    const list = quotesByTx.get(q.tx) ?? [];
    list.push(q);
    quotesByTx.set(q.tx, list);
  }

  const trades: Trade[] = [];
  const transfersInByWallet = new Map<string, bigint>();
  const used = new Set<QuoteEvent>();

  for (const t of transfers) {
    const from = t.from.toLowerCase();
    const to = t.to.toLowerCase();
    const fromMarket = market.has(from);
    const toMarket = market.has(to);
    if (t.tokens === 0n) continue;

    if (fromMarket && !toMarket) {
      const q = pickQuote(quotesByTx.get(t.tx) ?? [], used, "buy", t.tokens);
      if (q) used.add(q);
      trades.push({ wallet: to, kind: "buy", tokens: t.tokens, eth: q?.eth ?? 0n, block: t.block, tx: t.tx });
    } else if (!fromMarket && toMarket) {
      const q = pickQuote(quotesByTx.get(t.tx) ?? [], used, "sell", t.tokens);
      if (q) used.add(q);
      trades.push({ wallet: from, kind: "sell", tokens: t.tokens, eth: q?.eth ?? 0n, block: t.block, tx: t.tx });
    } else if (!fromMarket && !toMarket) {
      // wallet-to-wallet: the recipient's cost basis is unknown
      transfersInByWallet.set(to, (transfersInByWallet.get(to) ?? 0n) + t.tokens);
    }
    // market-to-market movements (curve -> pool at graduation) are ignored
  }

  const transfersIn = [...transfersInByWallet.entries()].map(([wallet, tokens]) => ({ wallet, tokens }));
  return { trades, transfersIn };
}
