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
  tokens TEXT NOT NULL, eth TEXT NOT NULL,
  PRIMARY KEY (block, log_index)
);
CREATE INDEX IF NOT EXISTS idx_ct_wallet ON chain_trades(wallet);
`;

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
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(SCHEMA);
    // v4 trades know their token directly (no curve involved); the column
    // arrived after the table, so add it in place on older databases
    try {
      this.db.exec("ALTER TABLE chain_trades ADD COLUMN token TEXT");
    } catch {
      /* already there */
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

  chainTradesFor(wallets: string[]): Map<string, { curve: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string; token?: string }[]> {
    const out = new Map<string, { curve: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string; token?: string }[]>();
    if (wallets.length === 0) return out;
    for (const slice of chunks(wallets, IN_CHUNK)) {
      const q = this.db.prepare(
        `SELECT wallet, curve, kind, tokens, eth, block, tx, token FROM chain_trades WHERE wallet IN (${slice.map(() => "?").join(",")}) ORDER BY block, log_index`,
      );
      for (const row of q.all(...slice.map((w) => w.toLowerCase())) as { wallet: string; curve: string; kind: "buy" | "sell"; tokens: string; eth: string; block: number; tx: string; token: string | null }[]) {
        const list = out.get(row.wallet) ?? [];
        list.push({ curve: row.curve, kind: row.kind, tokens: BigInt(row.tokens), eth: BigInt(row.eth), block: BigInt(row.block), tx: row.tx, token: row.token ?? undefined });
        out.set(row.wallet, list);
      }
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
