import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ADDR, ZERO } from "./chain.ts";
import type { TokenMeta } from "./providers/provider.ts";
import type { Trade, TransferIn } from "./pnl/classify.ts";

/**
 * Incremental store. Two zones:
 *  - per token: raw classified trades plus the block the token is synced to,
 *    so a repeat run only fetches new blocks;
 *  - global wallet profiles with a 24h TTL shared across tokens (the same
 *    whale sits in dozens of tokens, so this pays for itself quickly);
 * plus the factory launch index that backs ticker lookup.
 * Bigints are stored as TEXT.
 */

export const PROFILE_TTL_MS = 24 * 60 * 60 * 1000;

// SQLite caps bound variables (999 on older builds); IN () lists go in
// slices of this size everywhere.
const IN_CHUNK = 500;

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY, symbol TEXT, curve TEXT, created_block TEXT,
  synced_block TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
  token TEXT NOT NULL, wallet TEXT NOT NULL, block TEXT NOT NULL,
  kind TEXT NOT NULL, tokens TEXT NOT NULL, eth TEXT NOT NULL, tx TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_token ON trades(token);
CREATE TABLE IF NOT EXISTS transfers_in (
  token TEXT NOT NULL, wallet TEXT NOT NULL, tokens TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tin_token ON transfers_in(token);
CREATE TABLE IF NOT EXISTS launches (
  block TEXT NOT NULL, token TEXT PRIMARY KEY, symbol TEXT NOT NULL, curve TEXT NOT NULL,
  -- what the token is quoted in: two launches in five are priced in a
  -- stock or a stablecoin, and their amounts are in that currency
  pair_token TEXT
);
CREATE INDEX IF NOT EXISTS idx_launch_symbol ON launches(symbol);
-- a thousand wallets name tens of thousands of curves to resolve, and
-- without this every chunk of them scans the launch table
CREATE INDEX IF NOT EXISTS idx_launch_curve ON launches(curve, token);
CREATE TABLE IF NOT EXISTS profiles (
  wallet TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS curve_tokens (
  curve TEXT PRIMARY KEY, token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_trades (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  wallet TEXT NOT NULL, curve TEXT, token TEXT,
  kind INTEGER NOT NULL, tokens REAL NOT NULL, eth REAL NOT NULL,
  PRIMARY KEY (block, log_index)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pool_ids (token TEXT PRIMARY KEY, pool_id TEXT NOT NULL);
-- One row per wallet and market, folded from the trades as they arrive.
-- A profile needs four sums and a last price, never the trades that made
-- them, so this is the shape a scan actually reads: a thousand wallets
-- cost thirty thousand rows here against a million raw trades. "market"
-- is the token address for pool trades and the curve address for
-- pre-graduation ones, the same key the raw rows carry.
CREATE TABLE IF NOT EXISTS wallet_positions (
  wallet TEXT NOT NULL, market TEXT NOT NULL,
  buy_tokens REAL NOT NULL, buy_eth REAL NOT NULL,
  sell_tokens REAL NOT NULL, sell_eth REAL NOT NULL,
  trades INTEGER NOT NULL, last_price REAL NOT NULL, last_block INTEGER NOT NULL,
  PRIMARY KEY (wallet, market)
) WITHOUT ROWID;
-- The price of each market's newest trade, whoever made it. A wallet
-- that still holds what it bought is marked against this, not against
-- the price of its own last trade, which may be weeks stale.
CREATE TABLE IF NOT EXISTS market_price (
  market TEXT PRIMARY KEY, last_price REAL NOT NULL, last_block INTEGER NOT NULL
) WITHOUT ROWID;
`;

/** Fold one trade into a wallet's record of a market. The last price is
 * the price of the newest trade seen, whatever order they arrive in. */
const FOLD_POSITION = `
INSERT INTO wallet_positions (wallet, market, buy_tokens, buy_eth, sell_tokens, sell_eth, trades, last_price, last_block)
VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
ON CONFLICT(wallet, market) DO UPDATE SET
  buy_tokens = buy_tokens + excluded.buy_tokens,
  buy_eth = buy_eth + excluded.buy_eth,
  sell_tokens = sell_tokens + excluded.sell_tokens,
  sell_eth = sell_eth + excluded.sell_eth,
  trades = trades + 1,
  last_price = CASE WHEN excluded.last_price > 0 AND excluded.last_block >= last_block THEN excluded.last_price ELSE last_price END,
  last_block = MAX(last_block, excluded.last_block)`;

const FOLD_MARKET_PRICE = `
INSERT INTO market_price (market, last_price, last_block) VALUES (?, ?, ?)
ON CONFLICT(market) DO UPDATE SET
  last_price = CASE WHEN excluded.last_block >= last_block THEN excluded.last_price ELSE last_price END,
  last_block = MAX(last_block, excluded.last_block)`;

export interface RecordFold {
  /** positions the wallet has taken, open ones included */
  taken: number;
  /** positions it has fully exited */
  closed: number;
  /** positions in profit, open ones included */
  wins: number;
  /** positions in profit among those it exited */
  winsClosed: number;
  pnlPctSum: number;
  realizedWei: number;
  openValueWei: number;
}

/** A wallet's record twice over: as the terminal shows it (the scanned
 * token left out) and in full, which is what badges judge. */
export interface ProfileStats {
  shown: RecordFold;
  full: RecordFold;
}

export interface MarketAggregate {
  buyTokens: number;
  buyEth: number;
  sellTokens: number;
  sellEth: number;
  trades: number;
  lastPrice: number;
  lastBlock: number;
}

// Indexes over the trade table, by the columns they cover rather than by
// their name. A migration leaves its indexes behind under the names it
// used, and CREATE INDEX IF NOT EXISTS only matches names: asking for a
// name that is not there rebuilds an index that already exists, which on
// a hundred and eighty million rows means hours of stalled startup and
// tens of gigabytes of disk. Matching on columns makes the check honest.
// Both carry every column a token scan reads: a narrow index costs one
// random read into a table of tens of gigabytes per trade found, which
// is half a minute for a busy token and nothing for a quiet one.
const TRADE_INDEXES: { table: string; name: string; columns: string[] }[] = [
  { table: "chain_trades", name: "idx_ct_curve", columns: ["curve", "block"] },
  { table: "chain_trades", name: "idx_ct_token", columns: ["token", "block"] },
  // Covering on purpose: a token scan reads every wallet's record of one
  // market, and without the trailing columns each row costs a random
  // read into a table of tens of gigabytes.
  {
    table: "wallet_positions",
    name: "idx_wp_market",
    columns: ["market", "wallet", "buy_tokens", "buy_eth", "sell_tokens", "sell_eth", "trades", "last_price", "last_block"],
  },
];

/** The column list of a CREATE INDEX statement, lowercased and unquoted. */
function columnsOf(sql: string): string[] {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close < open) return [];
  return sql
    .slice(open + 1, close)
    .split(",")
    .map((c) => c.trim().replace(/^["'`[]|["'`\]]$/g, "").toLowerCase());
}

function sameColumns(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((c, i) => c === b[i]);
}

export function defaultCachePath(): string {
  const dir = join(homedir(), ".xray");
  mkdirSync(dir, { recursive: true });
  return join(dir, "cache.db");
}

export class Cache {
  private db: Database.Database;

  constructor(path?: string) {
    this.db = new Database(path ?? defaultCachePath());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 60000");
    // the trade index is tens of GB of rows; mmap turns per-wallet reads
    // into page-cache hits instead of syscall churn
    this.db.pragma("mmap_size = 8589934592");
    this.db.pragma("cache_size = -524288"); // 512 MB of page cache per connection
    this.db.exec(SCHEMA);
    this.ensureTradeIndexes();
  }

  /**
   * Create the trade indexes that are genuinely missing. An index whose
   * columns are already covered under another name is left alone, and on
   * a table that already holds rows nothing is built unless it is asked
   * for with XRAY_BUILD_INDEXES=1 - a build there takes hours and blocks
   * every reader, so it belongs in a maintenance window, never in the
   * startup path of a scan.
   */
  private ensureTradeIndexes(): void {
    if (process.env.XRAY_BUILD_INDEXES === "0") return;
    const indexesOf = (table: string): string[][] =>
      (
        this.db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL")
          .all(table) as { sql: string }[]
      ).map((r) => columnsOf(r.sql));
    const hasRows = (table: string): boolean => this.db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined;

    // An empty index is folded by definition, so a new install folds
    // every trade from its first one and never keeps a second copy of
    // the history to read profiles from.
    if (!hasRows("chain_trades") && this.getMeta("positions_built") === null) this.setMeta("positions_built", "1");

    for (const want of TRADE_INDEXES) {
      if (indexesOf(want.table).some((cols) => sameColumns(cols, want.columns))) continue;
      if (hasRows(want.table) && process.env.XRAY_BUILD_INDEXES !== "1") {
        console.warn(`xray: ${want.name} is missing on a populated ${want.table}; build it with XRAY_BUILD_INDEXES=1`);
        continue;
      }
      try {
        this.db.exec(`CREATE INDEX IF NOT EXISTS ${want.name} ON ${want.table}(${want.columns.join(", ")})`);
      } catch {
        /* a concurrent writer holds the lock; built out of band */
      }
    }
  }

  close(): void {
    this.db.close();
  }

  tokenState(address: string): { syncedBlock: bigint; createdBlock: bigint | null } | null {
    const row = this.db
      .prepare("SELECT synced_block, created_block FROM tokens WHERE address = ?")
      .get(address.toLowerCase()) as { synced_block: string; created_block: string | null } | undefined;
    return row
      ? { syncedBlock: BigInt(row.synced_block), createdBlock: row.created_block ? BigInt(row.created_block) : null }
      : null;
  }

  saveToken(meta: TokenMeta, syncedBlock: bigint): void {
    this.db
      .prepare(
        `INSERT INTO tokens (address, symbol, curve, created_block, synced_block)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(address) DO UPDATE SET synced_block = excluded.synced_block`,
      )
      .run(meta.address, meta.symbol, meta.curve, meta.createdBlock.toString(), syncedBlock.toString());
  }

  loadTrades(token: string): Trade[] {
    const rows = this.db
      .prepare("SELECT wallet, block, kind, tokens, eth, tx FROM trades WHERE token = ? ORDER BY rowid")
      .all(token.toLowerCase()) as { wallet: string; block: string; kind: "buy" | "sell"; tokens: string; eth: string; tx: string }[];
    return rows.map((r) => ({
      wallet: r.wallet,
      kind: r.kind,
      tokens: BigInt(r.tokens),
      eth: BigInt(r.eth),
      block: BigInt(r.block),
      tx: r.tx,
    }));
  }

  appendTrades(token: string, trades: Trade[]): void {
    const ins = this.db.prepare(
      "INSERT INTO trades (token, wallet, block, kind, tokens, eth, tx) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction((rows: Trade[]) => {
      for (const t of rows) {
        ins.run(token.toLowerCase(), t.wallet, t.block.toString(), t.kind, t.tokens.toString(), t.eth.toString(), t.tx);
      }
    });
    tx(trades);
  }

  loadTransfersIn(token: string): TransferIn[] {
    const rows = this.db
      .prepare("SELECT wallet, tokens FROM transfers_in WHERE token = ?")
      .all(token.toLowerCase()) as { wallet: string; tokens: string }[];
    return rows.map((r) => ({ wallet: r.wallet, tokens: BigInt(r.tokens) }));
  }

  appendTransfersIn(token: string, list: TransferIn[]): void {
    const ins = this.db.prepare("INSERT INTO transfers_in (token, wallet, tokens) VALUES (?, ?, ?)");
    const tx = this.db.transaction((rows: TransferIn[]) => {
      for (const t of rows) ins.run(token.toLowerCase(), t.wallet, t.tokens.toString());
    });
    tx(list);
  }

  launchesTip(): bigint {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'launches_tip'").get() as
      | { value: string }
      | undefined;
    return row ? BigInt(row.value) : 0n;
  }

  appendLaunches(
    rows: { block: bigint; token: string; symbol: string; curve: string; pairToken?: string }[],
    tip: bigint,
  ): void {
    const ins = this.db.prepare(
      "INSERT INTO launches (block, token, symbol, curve, pair_token) VALUES (?, ?, ?, ?, ?)\n       ON CONFLICT(token) DO UPDATE SET pair_token = COALESCE(excluded.pair_token, pair_token)",
    );
    const setTip = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES ('launches_tip', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        ins.run(r.block.toString(), r.token.toLowerCase(), r.symbol, r.curve.toLowerCase(), r.pairToken?.toLowerCase() ?? null);
      }
      setTip.run(tip.toString());
    });
    tx();
  }

  /** Which of these markets are quoted in ETH: only those carry a value
   * this scan can add up, since the rest are priced in a stock or a
   * stablecoin whose units mean nothing next to wei. */
  ethQuotedMarkets(markets: string[]): Set<string> {
    const out = new Set<string>();
    if (markets.length === 0) return out;
    for (const slice of chunks(markets, IN_CHUNK)) {
      const marks = slice.map(() => "?").join(",");
      const q = this.db.prepare(
        `SELECT token, curve, pair_token FROM launches WHERE (token IN (${marks}) OR curve IN (${marks}))
           AND (pair_token IS NULL OR pair_token = '${ZERO}' OR pair_token = '${ADDR.weth.toLowerCase()}')`,
      );
      const args = slice.map((m) => m.toLowerCase());
      for (const r of q.all(...args, ...args) as { token: string; curve: string; pair_token: string | null }[]) {
        // unknown pair is treated as not ETH until the backfill fills it
        if (r.pair_token === null) continue;
        out.add(r.token);
        out.add(r.curve);
      }
    }
    return out;
  }

  findTicker(symbol: string): { token: string; symbol: string; curve: string; block: bigint }[] {
    const rows = this.db
      .prepare("SELECT token, symbol, curve, block FROM launches WHERE symbol = ? COLLATE NOCASE")
      .all(symbol) as { token: string; symbol: string; curve: string; block: string }[];
    return rows.map((r) => ({ ...r, block: BigInt(r.block) }));
  }

  /**
   * Per wallet and token, the four running sums a ledger needs, computed
   * inside the database. Reading a hundred thousand rows into memory to
   * add them up was the slowest step of a scan; SQLite adds them in one
   * pass. Amounts come back as doubles, which hold fifteen significant
   * digits - far more than a pnl percentage needs.
   */
  walletAggregates(
    wallets: string[],
    afterBlock = -1n,
  ): Map<string, Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>> {
    const out = new Map<string, Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>>();
    if (wallets.length === 0) return out;
    const key = "COALESCE(NULLIF(token, ''), curve)";
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const marks = slice.map(() => "?").join(",");
      const args = [...slice.map((w) => w.toLowerCase()), Number(afterBlock)];
      const sums = this.db
        .prepare(
          `SELECT wallet, ${key} AS k, kind,
                  SUM(CAST(tokens AS REAL)) AS tok, SUM(CAST(eth AS REAL)) AS eth, COUNT(*) AS n
           FROM chain_trades WHERE wallet IN (${marks}) AND block > ?
           GROUP BY wallet, k, kind`,
        )
        .all(...args) as { wallet: string; k: string; kind: "buy" | "sell"; tok: number; eth: number; n: number }[];
      // the row carrying MAX(block) supplies the last price of the position
      const last = this.db
        .prepare(
          `SELECT wallet, ${key} AS k, MAX(block) AS mb, CAST(tokens AS REAL) AS tok, CAST(eth AS REAL) AS eth
           FROM chain_trades WHERE wallet IN (${marks}) AND block > ?
           GROUP BY wallet, k`,
        )
        .all(...args) as { wallet: string; k: string; mb: number; tok: number; eth: number }[];

      for (const r of sums) {
        const byToken = out.get(r.wallet) ?? new Map();
        const cur = byToken.get(r.k) ?? { buyTokens: 0, buyEth: 0, sellTokens: 0, sellEth: 0, trades: 0, lastPrice: 0, lastBlock: 0 };
        if (r.kind === "buy") {
          cur.buyTokens += r.tok;
          cur.buyEth += r.eth;
        } else {
          cur.sellTokens += r.tok;
          cur.sellEth += r.eth;
        }
        cur.trades += r.n;
        byToken.set(r.k, cur);
        out.set(r.wallet, byToken);
      }
      for (const r of last) {
        const cur = out.get(r.wallet)?.get(r.k);
        if (!cur) continue;
        cur.lastBlock = r.mb;
        cur.lastPrice = r.tok > 0 ? r.eth / r.tok : 0;
      }
    }
    return out;
  }

  /** Every indexed trade of one token: curve trades by its curve, pool
   * trades by the token itself. The scan reads these instead of pulling
   * the token's whole log history from the node again. */
  tokenTradesFromIndex(token: string, curve: string, fromBlock = 0n): { wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string }[] {
    // Two indexed lookups joined, not one OR: with a single OR the
    // planner falls back to scanning a hundred and eighty million rows.
    // fromBlock keeps a busy token's read to the window that needs trade
    // by trade detail - the rest of its history is read folded.
    const q = this.db.prepare(
      `SELECT wallet, kind, tokens, eth, block, log_index FROM chain_trades WHERE curve = ? AND block >= ?
       UNION ALL
       SELECT wallet, kind, tokens, eth, block, log_index FROM chain_trades WHERE token = ? AND block >= ?
       ORDER BY block, log_index`,
    );
    const from = Number(fromBlock);
    return (q.all(curve.toLowerCase(), from, token.toLowerCase(), from) as { wallet: string; kind: number; tokens: number; eth: number; block: number }[]).map((r) => ({
      wallet: r.wallet,
      kind: r.kind === 1 ? ("buy" as const) : ("sell" as const),
      tokens: BigInt(Math.round(r.tokens)),
      eth: BigInt(Math.round(r.eth)),
      block: BigInt(r.block),
      tx: "",
    }));
  }

  /** Wallets among these that have trades newer than the given block.
   * One indexed local query; lets cached profiles refresh the moment a
   * wallet trades again instead of sitting out a TTL. */
  walletsTradedSince(wallets: string[], afterBlock: bigint): Set<string> {
    const out = new Set<string>();
    // The folded positions carry the block of each market's last trade,
    // so the question is answered from a table a thousandth the size.
    const table = this.positionsReady()
      ? "SELECT DISTINCT wallet FROM wallet_positions WHERE last_block > ?"
      : "SELECT DISTINCT wallet FROM chain_trades WHERE block > ?";
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const q = this.db.prepare(`${table} AND wallet IN (${slice.map(() => "?").join(",")})`);
      for (const row of q.all(Number(afterBlock), ...slice.map((w) => w.toLowerCase())) as { wallet: string }[]) {
        out.add(row.wallet);
      }
    }
    return out;
  }

  /** Which of these token addresses are Pons launches. Pair tokens (NVDA,
   * SPCX, ...) move through the same pools but are not launches; profile
   * positions only make sense for launched tokens. */
  launchTokens(tokens: string[]): Set<string> {
    const out = new Set<string>();
    for (const slice of chunks(tokens, IN_CHUNK)) {
      const q = this.db.prepare(`SELECT token FROM launches WHERE token IN (${slice.map(() => "?").join(",")})`);
      for (const row of q.all(...slice.map((t) => t.toLowerCase())) as { token: string }[]) {
        out.add(row.token);
      }
    }
    return out;
  }

  curveTokens(curves: string[]): Map<string, string> {
    const out = new Map<string, string>();
    if (curves.length === 0) return out;
    // SQLite caps bound variables; a thousand wallets' history can name
    // tens of thousands of curves, so every IN () goes in chunks
    for (const slice of chunks(curves, IN_CHUNK)) {
      const q = this.db.prepare(`SELECT curve, token FROM curve_tokens WHERE curve IN (${slice.map(() => "?").join(",")})`);
      for (const row of q.all(...slice.map((c) => c.toLowerCase())) as { curve: string; token: string }[]) {
        out.set(row.curve, row.token);
      }
    }
    // the launch index knows most curves already
    const missing = curves.filter((c) => !out.has(c.toLowerCase()));
    for (const slice of chunks(missing, IN_CHUNK)) {
      const q2 = this.db.prepare(`SELECT curve, token FROM launches WHERE curve IN (${slice.map(() => "?").join(",")})`);
      for (const row of q2.all(...slice.map((c) => c.toLowerCase())) as { curve: string; token: string }[]) {
        out.set(row.curve, row.token);
      }
    }
    return out;
  }

  saveCurveTokens(map: Map<string, string>): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO curve_tokens (curve, token) VALUES (?, ?)");
    const tx = this.db.transaction(() => {
      for (const [curve, token] of map) ins.run(curve.toLowerCase(), token.toLowerCase());
    });
    tx();
  }

  poolIds(tokens: string[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const slice of chunks(tokens, IN_CHUNK)) {
      const q = this.db.prepare(`SELECT token, pool_id FROM pool_ids WHERE token IN (${slice.map(() => "?").join(",")})`);
      for (const r of q.all(...slice.map((t) => t.toLowerCase())) as { token: string; pool_id: string }[]) out.set(r.token, r.pool_id);
    }
    return out;
  }

  savePoolIds(map: Map<string, string>): void {
    const ins = this.db.prepare("INSERT OR IGNORE INTO pool_ids (token, pool_id) VALUES (?, ?)");
    const tx = this.db.transaction(() => {
      for (const [t, p] of map) ins.run(t.toLowerCase(), p.toLowerCase());
    });
    tx();
  }

  getMeta(key: string): string | null {
    return (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** Indexed span of a chain-wide trade lane: [floor, tip], both inclusive.
   * The "curve" lane holds curve trades, the "v4" lane post-graduation
   * pool trades; each backfills at its own pace. */
  tradeIndexSpan(lane: "curve" | "v4" = "curve"): { floor: bigint; tip: bigint } | null {
    const prefix = lane === "curve" ? "trades" : "trades_v4";
    const g = (k: string) => (this.db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value;
    const floor = g(`${prefix}_floor`);
    const tip = g(`${prefix}_tip`);
    return floor && tip ? { floor: BigInt(floor), tip: BigInt(tip) } : null;
  }

  setTradeIndexSpan(floor: bigint, tip: bigint, lane: "curve" | "v4" = "curve"): void {
    const prefix = lane === "curve" ? "trades" : "trades_v4";
    const put = this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const tx = this.db.transaction(() => {
      put.run(`${prefix}_floor`, floor.toString());
      put.run(`${prefix}_tip`, tip.toString());
    });
    tx();
  }

  appendChainTrades(rows: { block: bigint; logIndex: number; tx?: string; curve: string; wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; token?: string }[]): void {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO chain_trades (block, log_index, wallet, curve, token, kind, tokens, eth) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const fold = this.db.prepare(FOLD_POSITION);
    const price = this.db.prepare(FOLD_MARKET_PRICE);
    const tx = this.db.transaction(() => {
      // While the bulk fold is still walking the history it will reach
      // these blocks itself; folding them here too would count them
      // twice. The flag flips in the same transaction as the bulk fold's
      // last range, so exactly one of the two folds every trade.
      const folding = this.positionsReady();
      for (const r of rows) {
        const res = ins.run(Number(r.block), r.logIndex, r.wallet, r.curve || null, r.token ?? null, r.kind === "buy" ? 1 : 0, Number(r.tokens), Number(r.eth));
        // a row the index already had must not be folded twice
        if (res.changes !== 1 || !folding) continue;
        const market = r.token || r.curve;
        if (!market) continue;
        const tokens = Number(r.tokens);
        const eth = Number(r.eth);
        const buy = r.kind === "buy";
        // a leg that moves a sliver of tokens for a normal amount of
        // quote prices nothing; it must not become anyone's last price
        const priced = tokens >= 1e12 && eth >= 1e12;
        fold.run(
          r.wallet.toLowerCase(),
          market.toLowerCase(),
          buy ? tokens : 0,
          buy ? eth : 0,
          buy ? 0 : tokens,
          buy ? 0 : eth,
          priced ? eth / tokens : 0,
          Number(r.block),
        );
        // a dust trade sets an absurd price and would value every open
        // position in that market against it
        if (tokens >= 1e12 && eth >= 1e12) price.run(market.toLowerCase(), eth / tokens, Number(r.block));
      }
    });
    tx();
  }

  /** Where each of these markets last traded, whoever traded it. */
  marketPrices(markets: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (markets.length === 0) return out;
    for (const slice of chunks(markets, IN_CHUNK)) {
      const q = this.db.prepare(
        `SELECT market, last_price FROM market_price WHERE market IN (${slice.map(() => "?").join(",")})`,
      );
      for (const r of q.all(...slice.map((m) => m.toLowerCase())) as { market: string; last_price: number }[]) {
        out.set(r.market, r.last_price);
      }
    }
    return out;
  }

  /** Per wallet, the folded record of every market it has traded. */
  walletPositions(wallets: string[]): Map<string, Map<string, MarketAggregate>> {
    const out = new Map<string, Map<string, MarketAggregate>>();
    if (wallets.length === 0) return out;
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const q = this.db.prepare(
        `SELECT wallet, market, buy_tokens, buy_eth, sell_tokens, sell_eth, trades, last_price, last_block
         FROM wallet_positions WHERE wallet IN (${slice.map(() => "?").join(",")})`,
      );
      const rows = q.all(...slice.map((w) => w.toLowerCase())) as {
        wallet: string; market: string; buy_tokens: number; buy_eth: number;
        sell_tokens: number; sell_eth: number; trades: number; last_price: number; last_block: number;
      }[];
      for (const r of rows) {
        const byMarket = out.get(r.wallet) ?? new Map<string, MarketAggregate>();
        byMarket.set(r.market, {
          buyTokens: r.buy_tokens,
          buyEth: r.buy_eth,
          sellTokens: r.sell_tokens,
          sellEth: r.sell_eth,
          trades: r.trades,
          lastPrice: r.last_price,
          lastBlock: r.last_block,
        });
        out.set(r.wallet, byMarket);
      }
    }
    return out;
  }

  /**
   * Every wallet's folded record of one token: its curve trades and its
   * pool trades added together, which is what a holder's position on the
   * token is made of. Reading this instead of the token's trades is the
   * difference between thirty thousand rows and a quarter of a million.
   */
  marketPositions(token: string, curve: string): Map<string, MarketAggregate> {
    const out = new Map<string, MarketAggregate>();
    const q = this.db.prepare(
      `SELECT wallet, buy_tokens, buy_eth, sell_tokens, sell_eth, trades, last_price, last_block
       FROM wallet_positions WHERE market = ?`,
    );
    for (const market of [token.toLowerCase(), curve.toLowerCase()]) {
      if (!market) continue;
      const rows = q.all(market) as {
        wallet: string; buy_tokens: number; buy_eth: number; sell_tokens: number;
        sell_eth: number; trades: number; last_price: number; last_block: number;
      }[];
      for (const r of rows) {
        const cur = out.get(r.wallet);
        if (cur) {
          cur.buyTokens += r.buy_tokens;
          cur.buyEth += r.buy_eth;
          cur.sellTokens += r.sell_tokens;
          cur.sellEth += r.sell_eth;
          cur.trades += r.trades;
          if (r.last_block > cur.lastBlock) {
            cur.lastBlock = r.last_block;
            cur.lastPrice = r.last_price;
          }
        } else {
          out.set(r.wallet, {
            buyTokens: r.buy_tokens,
            buyEth: r.buy_eth,
            sellTokens: r.sell_tokens,
            sellEth: r.sell_eth,
            trades: r.trades,
            lastPrice: r.last_price,
            lastBlock: r.last_block,
          });
        }
      }
    }
    return out;
  }

  /**
   * A wallet's whole record folded to the six numbers a profile is made
   * of, computed inside the database. A trading bot has touched hundreds
   * of thousands of markets, and carrying those rows into memory to add
   * them up is the slowest thing a scan does; SQLite adds them where
   * they lie and returns one row per wallet.
   *
   * Only Pons launches count: a market is kept when it is a launched
   * token or a curve that resolves to one, the same rule the row by row
   * path applies. Both the record with the scanned token excluded (what
   * the terminal shows) and the full one (what badges judge) come back
   * from the same pass.
   */
  profileStats(wallets: string[], excludeToken?: string): Map<string, ProfileStats> {
    const out = new Map<string, ProfileStats>();
    if (wallets.length === 0) return out;
    const ex = excludeToken?.toLowerCase() ?? "";
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const marks = slice.map(() => "?").join(",");
      const q = this.db.prepare(`
        SELECT w,
          SUM(CASE WHEN shown THEN 1 ELSE 0 END) AS taken_s,
          SUM(CASE WHEN shown AND closed THEN 1 ELSE 0 END) AS closed_s,
          SUM(CASE WHEN shown AND pnl > 0 THEN 1 ELSE 0 END) AS wins_s,
          SUM(CASE WHEN shown AND closed AND pnl > 0 THEN 1 ELSE 0 END) AS wins_closed_s,
          SUM(CASE WHEN shown THEN MAX(-100.0, MIN(500.0, pnl / cost * 100)) ELSE 0 END) AS pct_s,
          SUM(CASE WHEN shown THEN pnl ELSE 0 END) AS realized_s,
          SUM(value) AS open_s,
          COUNT(*) AS taken_f,
          SUM(CASE WHEN closed THEN 1 ELSE 0 END) AS closed_f,
          SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins_f,
          SUM(CASE WHEN closed AND pnl > 0 THEN 1 ELSE 0 END) AS wins_closed_f,
          SUM(MAX(-100.0, MIN(500.0, pnl / cost * 100))) AS pct_f,
          SUM(value) AS open_f
        FROM (
          -- Only what a wallet actually took out counts. What it still
          -- holds cannot be checked from trades alone: tokens leave a
          -- wallet by transfer as often as by sale here, so a remainder
          -- computed as buys minus sells is frequently a position the
          -- wallet no longer has, and marking that to market invents
          -- money. The cost of the tokens it did sell, against what it
          -- got for them, is arithmetic nobody can argue with.
          SELECT w, tok, (tok <> ?) AS shown,
                 (bc * st / bt) AS cost,
                 ((bt - st) <= bt * 1e-9) AS closed,
                 0 AS value,
                 (sp - bc * st / bt) AS pnl
          FROM (
            SELECT wp.wallet AS w,
                   COALESCE(lt.token, lc.token, NULLIF(ct.token, '')) AS tok,
                   SUM(wp.buy_tokens) AS bt, SUM(wp.buy_eth) AS bc,
                   SUM(wp.sell_tokens) AS st, SUM(wp.sell_eth) AS sp,
                   MAX(wp.last_block) AS lb,
                   -- a market quoted in a stock or a stablecoin carries
                   -- amounts that are not wei; kept for readers of this
                   -- table, the record itself is a ratio either way
                   MAX(CASE WHEN COALESCE(lt.pair_token, lc.pair_token) IN (?, ?) THEN 1 ELSE 0 END) AS eth_quoted
            FROM wallet_positions wp
            LEFT JOIN launches lt ON lt.token = wp.market
            LEFT JOIN launches lc ON lc.curve = wp.market
            LEFT JOIN curve_tokens ct ON ct.curve = wp.market
            WHERE wp.wallet IN (${marks})
            GROUP BY w, tok
          )
          -- a cost basis of nothing is no basis; anything above that
          -- joins the average inside the clamped band, so a position
          -- bought for a rounding error cannot run away with it
          -- a position with no sale has no realized number, and a
          -- position that sold more than it bought has no honest basis
          WHERE tok IS NOT NULL AND st <= bt * 1.000000001 AND st > 0 AND bt > 0 AND bc > 0
        )
        GROUP BY w`);
      const rows = q.all(ex, ZERO, ADDR.weth.toLowerCase(), ...slice.map((w) => w.toLowerCase())) as {
        w: string; taken_s: number; closed_s: number; wins_s: number; wins_closed_s: number; pct_s: number;
        realized_s: number; open_s: number; taken_f: number; closed_f: number; wins_f: number;
        wins_closed_f: number; pct_f: number; open_f: number;
      }[];
      for (const r of rows) {
        out.set(r.w, {
          shown: {
            taken: r.taken_s, closed: r.closed_s, wins: r.wins_s, winsClosed: r.wins_closed_s,
            pnlPctSum: r.pct_s, realizedWei: r.realized_s, openValueWei: r.open_s,
          },
          full: {
            taken: r.taken_f, closed: r.closed_f, wins: r.wins_f, winsClosed: r.wins_closed_f,
            pnlPctSum: r.pct_f, realizedWei: 0, openValueWei: r.open_f,
          },
        });
      }
    }
    return out;
  }

  /** Whether the folded positions cover the whole index. Until the bulk
   * fold finishes, profiles keep reading raw trades. */
  positionsReady(): boolean {
    return this.getMeta("positions_built") === "1";
  }

  /**
   * The oldest block each lane was folded from. Raw trades may be pruned
   * to a rolling window afterwards, and the folded rows still hold every
   * trade that was ever indexed: a token scan asks this, not where the
   * raw trades now begin.
   */
  positionsFloor(): { curve: bigint; v4: bigint } | null {
    if (!this.positionsReady()) return null;
    const curve = this.getMeta("positions_floor") ?? this.getMeta("trades_floor");
    const v4 = this.getMeta("positions_floor_v4") ?? this.getMeta("trades_v4_floor");
    if (curve === null || v4 === null) return null;
    return { curve: BigInt(curve), v4: BigInt(v4) };
  }

  chainTradesFor(wallets: string[], afterBlock = -1n): Map<string, { curve: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string; token?: string }[]> {
    const out = new Map<string, { curve: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string; token?: string }[]>();
    if (wallets.length === 0) return out;
    // per-wallet indexed scan, optionally only trades past a block (the
    // incremental ledger applies new trades on top of the folded record).
    // Lean columns: the ledger needs no tx hash. A from-scratch read is
    // capped at the most recent trades - a bot with a hundred thousand of
    // them says the same thing about how it trades in the last few
    // thousand, and the cap is what keeps a thousand-wallet phase quick.
    const cap = Number(process.env.XRAY_WALLET_TRADE_CAP ?? 5000);
    // every column the fold needs lives in the index, so this never
    // touches the table itself
    const q = this.db.prepare(
      `SELECT curve, kind, tokens, eth, block, token FROM chain_trades WHERE wallet = ? AND block > ? ORDER BY block DESC, log_index DESC LIMIT ${cap}`,
    );
    for (const w of wallets) {
      const lw = w.toLowerCase();
      const rows = q.all(lw, Number(afterBlock)) as { curve: string | null; kind: number; tokens: number; eth: number; block: number; token: string | null }[];
      if (rows.length === 0) continue;
      rows.reverse(); // ascending block order for the fold
      out.set(
        lw,
        rows.map((row) => ({
          curve: row.curve ?? "",
          kind: row.kind === 1 ? ("buy" as const) : ("sell" as const),
          tokens: BigInt(Math.round(row.tokens)),
          eth: BigInt(Math.round(row.eth)),
          block: BigInt(row.block),
          tx: "",
          token: row.token ?? undefined,
        })),
      );
    }
    return out;
  }

  profile(wallet: string): { json: string; fetchedAt: number } | null {
    const row = this.db
      .prepare("SELECT json, fetched_at FROM profiles WHERE wallet = ?")
      .get(wallet.toLowerCase()) as { json: string; fetched_at: number } | undefined;
    if (!row) return null;
    return { json: row.json, fetchedAt: row.fetched_at };
  }

  freshProfile(wallet: string, now = Date.now()): string | null {
    const row = this.profile(wallet);
    if (!row || now - row.fetchedAt > PROFILE_TTL_MS) return null;
    return row.json;
  }

  saveProfile(wallet: string, json: string, now = Date.now()): void {
    this.saveProfiles([{ wallet, json }], now);
  }

  /**
   * Write many profiles at once. Each write is its own transaction
   * otherwise, and a transaction ends in an fsync: a thousand of them
   * cost a minute and a half on a busy disk, against well under a second
   * for the same rows written together.
   */
  saveProfiles(entries: { wallet: string; json: string }[], now = Date.now()): void {
    if (entries.length === 0) return;
    const put = this.db.prepare(
      "INSERT INTO profiles (wallet, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
    );
    const tx = this.db.transaction(() => {
      for (const e of entries) put.run(e.wallet.toLowerCase(), e.json, now);
    });
    tx();
  }

  /** Fresh cached profiles for many wallets, read in chunks rather than
   * one query per wallet. */
  freshProfiles(wallets: string[], now = Date.now()): Map<string, string> {
    const out = new Map<string, string>();
    if (wallets.length === 0) return out;
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const q = this.db.prepare(
        `SELECT wallet, json, fetched_at FROM profiles WHERE wallet IN (${slice.map(() => "?").join(",")})`,
      );
      for (const row of q.all(...slice.map((w) => w.toLowerCase())) as { wallet: string; json: string; fetched_at: number }[]) {
        if (now - row.fetched_at <= PROFILE_TTL_MS) out.set(row.wallet, row.json);
      }
    }
    return out;
  }
}

