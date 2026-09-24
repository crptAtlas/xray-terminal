/**
 * The record the database folds against the record folded row by row,
 * for a sample of wallets: closed trades, wins, average pnl and winrate
 * must agree. The row by row path is the one that was measured against
 * the chain, so it is the reference.
 *
 *   npx tsx scripts/verify-profiles.mts [wallets] [excludeToken]
 */
import { Cache } from "../lib/cache.ts";
import { applyAggregates, emptyLedger, ledgerPositions } from "../lib/profile/ledger.ts";
import { profileFromPositions, profileFromStats } from "../lib/profile/profile.ts";

const sampleSize = Number(process.argv[2] ?? 200);
const exclude = process.argv[3];
const cache = new Cache();
const db = (cache as unknown as { db: { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } } }).db;

const wallets = (
  db.prepare(`SELECT wallet FROM wallet_positions GROUP BY wallet ORDER BY RANDOM() LIMIT ${sampleSize}`).all() as {
    wallet: string;
  }[]
).map((r) => r.wallet);
console.log(`sampled ${wallets.length} wallets`);

let t = Date.now();
const stats = cache.profileStats(wallets, exclude);
const sqlMs = Date.now() - t;

t = Date.now();
const positions = cache.walletPositions(wallets);
const launched = new Set<string>();
const curves = new Map<string, string>();
const keys = new Set<string>();
for (const byMarket of positions.values()) for (const k of byMarket.keys()) keys.add(k);
for (const k of cache.launchTokens([...keys])) launched.add(k);
for (const [c, tok] of cache.curveTokens([...keys])) curves.set(c, tok);
// a position is marked at the price its market last traded at, and the
// merged position takes the price of whichever market traded last
const priceByMarket = cache.marketPrices([...keys]);
const marketPrice = new Map<string, number>();
const rowMs = Date.now() - t;

const near = (a: number | null, b: number | null) => {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-6);
};

let differ = 0;
let compared = 0;
for (const w of wallets) {
  const byMarket = positions.get(w) ?? new Map();
  const byToken = new Map<string, ReturnType<typeof Object>>();
  for (const [key, a] of byMarket) {
    const token = launched.has(key) ? key : curves.get(key);
    if (!token) continue;
    const cur = byToken.get(token) as typeof a | undefined;
    if (cur) {
      cur.buyTokens += a.buyTokens;
      cur.buyEth += a.buyEth;
      cur.sellTokens += a.sellTokens;
      cur.sellEth += a.sellEth;
      cur.trades += a.trades;
      if (a.lastBlock > cur.lastBlock) {
        cur.lastBlock = a.lastBlock;
        cur.lastPrice = a.lastPrice;
      }
    } else byToken.set(token, { ...a });
    const at = marketPrice.get(token);
    const known = priceByMarket.get(key);
    if (known !== undefined && (at === undefined || a.lastBlock >= (byToken.get(token) as { lastBlock: number }).lastBlock)) {
      marketPrice.set(token, known);
    }
  }
  const reference = profileFromPositions(
    w,
    // the same market prices the database folds against
    ledgerPositions(applyAggregates(emptyLedger(), byToken as never, 0n), (t) => marketPrice.get(t)),
    0n,
    exclude,
    0,
  );
  const empty = { taken: 0, closed: 0, wins: 0, winsClosed: 0, pnlPctSum: 0, realizedWei: 0, openValueWei: 0 };
  // no row means no Pons position at all, which is a record of zero trades
  const folded = profileFromStats(w, stats.get(w) ?? { shown: empty, full: empty }, 0n, 0);
  compared++;
  const same =
    folded.trades === reference.trades &&
    folded.wins === reference.wins &&
    near(folded.avgPnlPerTrade, reference.avgPnlPerTrade) &&
    near(folded.winrate, reference.winrate);
  if (!same) {
    if (differ < 6) {
      console.log(`  ${w}`);
      console.log(`    rows: trades ${reference.trades} wins ${reference.wins} avg ${reference.avgPnlPerTrade} wr ${reference.winrate}`);
      console.log(`    sql : trades ${folded.trades} wins ${folded.wins} avg ${folded.avgPnlPerTrade} wr ${folded.winrate}`);
    }
    differ++;
  }
}

console.log(`sql fold ${sqlMs}ms, row fold ${rowMs}ms (read only)`);
console.log(`compared ${compared}, differ ${differ}`);
console.log(differ === 0 ? "MATCH" : "DIFFERS");
cache.close();
