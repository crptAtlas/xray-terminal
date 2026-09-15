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
`;

export function defaultCachePath(): string {
  const dir = join(homedir(), ".appname");
  mkdirSync(dir, { recursive: true });
  return join(dir, "cache.db");
}

export class Cache {
  private db: Database.Database;

  constructor(path?: string) {
    this.db = new Database(path ?? defaultCachePath());
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  tokenState(address: string): { syncedBlock: bigint } | null {
    const row = this.db
      .prepare("SELECT synced_block FROM tokens WHERE address = ?")
      .get(address.toLowerCase()) as { synced_block: string } | undefined;
    return row ? { syncedBlock: BigInt(row.synced_block) } : null;
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
