/**
 * Rebuild chain_trades in a compact shape, in place, a block range at a
 * time. The table carries a transaction hash nobody reads and stores
 * amounts as text; dropping the hash and keeping amounts as numbers
 * halves the file, which is what makes a wallet read fast - the disk is
 * the bottleneck, not the CPU.
 *
 * Rows move in ranges and each range is deleted from the old table right
 * after it lands, so the file reuses its own freed pages instead of
 * needing a second copy of itself. Resumable: it remembers the block it
 * reached.
 *
 *   npx tsx scripts/compact-index.mts [budgetMinutes]
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
const budgetMs = Number(process.argv[2] ?? 0) * 60_000;
const db = new Database(path);
// A bulk move in WAL mode grows the journal by everything it touches,
// and a checkpoint cannot shrink it while a reader is attached - that
// is nineteen gigabytes of journal for a table that never changed size.
// A rollback journal is deleted after every range instead.
db.pragma("journal_mode = DELETE");
db.pragma("busy_timeout = 120000");

db.exec(`
CREATE TABLE IF NOT EXISTS chain_trades_v2 (
  block INTEGER NOT NULL, log_index INTEGER NOT NULL,
  wallet TEXT NOT NULL, curve TEXT, token TEXT,
  kind INTEGER NOT NULL, tokens REAL NOT NULL, eth REAL NOT NULL,
  PRIMARY KEY (block, log_index)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_v2_wallet ON chain_trades_v2(wallet, block, log_index, kind, tokens, eth, token, curve);
`);
// The curve and token indexes are built after the move, when the old
// table is gone and there is room for them. Carrying them during the
// move costs space the migration itself needs.

const getMeta = (k: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

// migrate from the oldest blocks upward: the freshest history, which is
// what scans read, stays in the original table until the very end
const minBlock = (db.prepare("SELECT MIN(block) AS b FROM chain_trades").get() as { b: number | null }).b ?? 0;
const maxBlock = (db.prepare("SELECT MAX(block) AS b FROM chain_trades").get() as { b: number | null }).b ?? 0;
let cursor = Number(getMeta("compact_cursor") ?? String(minBlock));
// small ranges with a breath between them: a rollback journal locks
// readers while it writes, so the site needs those gaps to answer scans
const STEP = Number(process.env.XRAY_COMPACT_STEP ?? 40_000);
const PAUSE_MS = Number(process.env.XRAY_COMPACT_PAUSE_MS ?? 1500);

const copy = db.prepare(
  `INSERT OR IGNORE INTO chain_trades_v2 (block, log_index, wallet, curve, token, kind, tokens, eth)
   SELECT block, log_index, wallet, NULLIF(curve, ''), token,
          CASE kind WHEN 'buy' THEN 1 ELSE 0 END,
          CAST(tokens AS REAL), CAST(eth AS REAL)
   FROM chain_trades WHERE block >= ? AND block < ?`,
);
const wipe = db.prepare("DELETE FROM chain_trades WHERE block >= ? AND block < ?");
const move = db.transaction((from: number, to: number) => {
  const r = copy.run(from, to);
  wipe.run(from, to);
  setMeta.run("compact_cursor", String(from));
  return r.changes;
});

const started = Date.now();
let moved = 0;
console.error(`compacting from block ${cursor} up to ${maxBlock}, step ${STEP}`);
while (cursor <= maxBlock) {
  if (budgetMs && Date.now() - started > budgetMs) {
    console.error("\nbudget reached; run again to continue");
    break;
  }
  const to = cursor + STEP;
  moved += move(cursor, to);
  cursor = to;
  if (PAUSE_MS > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PAUSE_MS);
  process.stderr.write(`\r  block ${cursor}   rows moved ${moved}   ${((Date.now() - started) / 1000).toFixed(0)}s   `);
}
process.stderr.write("\n");
if (cursor > maxBlock) {
  const left = (db.prepare("SELECT COUNT(*) AS n FROM chain_trades").get() as { n: number }).n;
  console.error(`old table rows left: ${left}`);
  console.error("done moving; drop the old table and rename when you have verified counts");
}
db.pragma("journal_mode = WAL"); // back to the mode the site reads in
db.close();
