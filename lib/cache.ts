import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
  block TEXT NOT NULL, token TEXT PRIMARY KEY, symbol TEXT NOT NULL, curve TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_launch_symbol ON launches(symbol);
CREATE TABLE IF NOT EXISTS profiles (
  wallet TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS curve_tokens (
  curve TEXT PRIMARY KEY, token TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chain_trades (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL, tx TEXT NOT NULL,
  curve TEXT NOT NULL, wallet TEXT NOT NULL, kind TEXT NOT NULL,
  tokens TEXT NOT NULL, eth TEXT NOT NULL, token TEXT,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS idx_ct_wallet_block ON chain_trades(wallet, block, log_index);
CREATE TABLE IF NOT EXISTS pool_ids (token TEXT PRIMARY KEY, pool_id TEXT NOT NULL);
`;

export function defaultCachePath(): string {
  const dir = join(homedir(), ".xray");
  mkdirSync(dir, { recursive: true });
  return join(dir, "cache.db");
}

export class Cache {
  private db: Database.Database;
  /** the compact table exists while or after a migration; reads span both */
  private hasV2 = false;

  constructor(path?: string) {
    this.db = new Database(path ?? defaultCachePath());
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 60000");
    // the trade index is tens of GB of rows; mmap turns per-wallet reads
    // into page-cache hits instead of syscall churn
    this.db.pragma("mmap_size = 8589934592");
    this.db.pragma("cache_size = -524288"); // 512 MB of page cache per connection
    this.db.exec(SCHEMA);
    // v4 trades know their token directly (no curve involved); the column
    // arrived after the table, so add it in place on older databases
    try {
      this.db.exec("ALTER TABLE chain_trades ADD COLUMN token TEXT");
    } catch {
      /* already there */
    }
    // indexes that need the token column exist only after it does; on a
    // big database the caller builds them once out of band, so this is a
    // no-op there and instant on a fresh one
    this.hasV2 =
      (this.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='chain_trades_v2'").get() as { n: number }).n > 0;
    if (process.env.XRAY_BUILD_INDEXES !== "0") {
      try {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_ct_curve_block ON chain_trades(curve, block, log_index)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_ct_token_block ON chain_trades(token, block, log_index)");
      } catch {
        /* a concurrent writer holds the lock; the index is built out of band */
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

  appendLaunches(rows: { block: bigint; token: string; symbol: string; curve: string }[], tip: bigint): void {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO launches (block, token, symbol, curve) VALUES (?, ?, ?, ?)",
    );
    const setTip = this.db.prepare(
      "INSERT INTO meta (key, value) VALUES ('launches_tip', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) ins.run(r.block.toString(), r.token.toLowerCase(), r.symbol, r.curve.toLowerCase());
      setTip.run(tip.toString());
    });
    tx();
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
  tokenTradesFromIndex(token: string, curve: string): { wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string }[] {
    const sql = this.hasV2
      ? `SELECT wallet, kind, tokens, eth, block, tx FROM (
           SELECT wallet, CASE kind WHEN 1 THEN 'buy' ELSE 'sell' END AS kind,
                  CAST(tokens AS TEXT) AS tokens, CAST(eth AS TEXT) AS eth, block, '' AS tx, log_index
           FROM chain_trades_v2 WHERE curve = ? OR token = ?
           UNION ALL
           SELECT wallet, kind, tokens, eth, block, tx, log_index
           FROM chain_trades WHERE curve = ? OR token = ?
         ) ORDER BY block, log_index`
      : `SELECT wallet, kind, tokens, eth, block, tx FROM chain_trades
         WHERE curve = ? OR token = ?
         ORDER BY block, log_index`;
    const q = this.db.prepare(sql);
    const a = [curve.toLowerCase(), token.toLowerCase()];
    return (q.all(...(this.hasV2 ? [...a, ...a] : a)) as { wallet: string; kind: "buy" | "sell"; tokens: string; eth: string; block: number; tx: string }[]).map((r) => ({
      wallet: r.wallet,
      kind: r.kind,
      tokens: BigInt(r.tokens),
      eth: BigInt(r.eth),
      block: BigInt(r.block),
      tx: r.tx,
    }));
  }

  /** Wallets among these that have trades newer than the given block.
   * One indexed local query; lets cached profiles refresh the moment a
   * wallet trades again instead of sitting out a TTL. */
  walletsTradedSince(wallets: string[], afterBlock: bigint): Set<string> {
    const out = new Set<string>();
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const q = this.db.prepare(
        `SELECT DISTINCT wallet FROM chain_trades WHERE block > ? AND wallet IN (${slice.map(() => "?").join(",")})`,
      );
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

  appendChainTrades(rows: { block: bigint; logIndex: number; tx: string; curve: string; wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; token?: string }[]): void {
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO chain_trades (block, log_index, tx, curve, wallet, kind, tokens, eth, token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) {
        ins.run(Number(r.block), r.logIndex, r.tx, r.curve, r.wallet, r.kind, r.tokens.toString(), r.eth.toString(), r.token ?? null);
      }
    });
    tx();
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
    // The compact table holds migrated rows, the original holds whatever
    // has not moved yet; during a migration a wallet's history spans both.
    const sql = this.hasV2
      ? `SELECT curve, kind, tokens, eth, block, token FROM (
           SELECT curve, CASE kind WHEN 1 THEN 'buy' ELSE 'sell' END AS kind,
                  CAST(tokens AS TEXT) AS tokens, CAST(eth AS TEXT) AS eth, block, token, log_index
           FROM chain_trades_v2 WHERE wallet = ? AND block > ?
           UNION ALL
           SELECT curve, kind, tokens, eth, block, token, log_index
           FROM chain_trades WHERE wallet = ? AND block > ?
         ) ORDER BY block DESC, log_index DESC LIMIT ${cap}`
      : `SELECT curve, kind, tokens, eth, block, token FROM chain_trades WHERE wallet = ? AND block > ? ORDER BY block DESC, log_index DESC LIMIT ${cap}`;
    const q = this.db.prepare(sql);
    for (const w of wallets) {
      const lw = w.toLowerCase();
      const args = this.hasV2 ? [lw, Number(afterBlock), lw, Number(afterBlock)] : [lw, Number(afterBlock)];
      const rows = q.all(...args) as { curve: string; kind: "buy" | "sell"; tokens: string; eth: string; block: number; token: string | null }[];
      if (rows.length === 0) continue;
      rows.reverse(); // ascending block order for the fold
      out.set(
        lw,
        rows.map((row) => ({
          curve: row.curve,
          kind: row.kind,
          tokens: BigInt(row.tokens),
          eth: BigInt(row.eth),
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
    this.db
      .prepare(
        "INSERT INTO profiles (wallet, json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET json = excluded.json, fetched_at = excluded.fetched_at",
      )
      .run(wallet.toLowerCase(), json, now);
  }
}
