/**
 * Fold the whole trade index into wallet_positions: one row per wallet
 * and market instead of one per trade. A profile needs four sums and a
 * last price, so a scan that reads folded rows touches a few tens of
 * thousands of them where the raw trades run to a million.
 *
 * Runs a block range at a time so the follower and the site keep their
 * turn at the database, checkpoints the journal after every range (a
 * bulk write in WAL mode grows it by everything it touches), and
 * remembers where it got to. Sets positions_built when it reaches the
 * tip, which is what switches profiles over to reading it.
 *
 *   npx tsx scripts/build-positions.mts [budgetMinutes]
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanInProgress } from "../lib/scanflag.ts";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
const budgetMs = Number(process.argv[2] ?? 0) * 60_000;
const db = new Database(path);
db.pragma("busy_timeout = 120000");
db.pragma("cache_size = -524288");

db.exec(`
CREATE TABLE IF NOT EXISTS wallet_positions (
  wallet TEXT NOT NULL, market TEXT NOT NULL,
  buy_tokens REAL NOT NULL, buy_eth REAL NOT NULL,
  sell_tokens REAL NOT NULL, sell_eth REAL NOT NULL,
  trades INTEGER NOT NULL, last_price REAL NOT NULL, last_block INTEGER NOT NULL,
  PRIMARY KEY (wallet, market)
) WITHOUT ROWID;
`);

const getMeta = (k: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

const minBlock = (db.prepare("SELECT MIN(block) AS b FROM chain_trades").get() as { b: number | null }).b ?? 0;
// the head keeps moving while this runs, so the target is re-read rather
// than fixed at the start
const tip = (): number => (db.prepare("SELECT MAX(block) AS b FROM chain_trades").get() as { b: number | null }).b ?? 0;
const maxBlock = tip();
let cursor = Number(getMeta("positions_cursor") ?? String(minBlock));
const STEP = Number(process.env.XRAY_POSITIONS_STEP ?? 150_000);

// One range, one statement. The bare tokens and eth columns come from the
// row carrying MAX(block), which is how SQLite resolves them when a query
// holds a single min or max aggregate - that row is the market's last
// trade in this range, and its price is the one to carry.
const fold = db.prepare(`
INSERT INTO wallet_positions (wallet, market, buy_tokens, buy_eth, sell_tokens, sell_eth, trades, last_price, last_block)
SELECT wallet,
       COALESCE(NULLIF(token, ''), curve) AS market,
       SUM(CASE WHEN kind = 1 THEN tokens ELSE 0 END),
       SUM(CASE WHEN kind = 1 THEN eth ELSE 0 END),
       SUM(CASE WHEN kind = 0 THEN tokens ELSE 0 END),
       SUM(CASE WHEN kind = 0 THEN eth ELSE 0 END),
       COUNT(*),
       CASE WHEN tokens > 0 THEN eth / tokens ELSE 0 END,
       MAX(block)
FROM chain_trades
WHERE block >= ? AND block < ? AND COALESCE(NULLIF(token, ''), curve) IS NOT NULL
GROUP BY wallet, market
ON CONFLICT(wallet, market) DO UPDATE SET
  buy_tokens = buy_tokens + excluded.buy_tokens,
  buy_eth = buy_eth + excluded.buy_eth,
  sell_tokens = sell_tokens + excluded.sell_tokens,
  sell_eth = sell_eth + excluded.sell_eth,
  trades = trades + excluded.trades,
  last_price = CASE WHEN excluded.last_block >= last_block THEN excluded.last_price ELSE last_price END,
  last_block = MAX(last_block, excluded.last_block)`);

const step = db.transaction((from: number, to: number) => {
  const r = fold.run(from, to);
  setMeta.run("positions_cursor", String(to));
  return r.changes;
});

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const started = Date.now();
let folded = 0;
let budgetHit = false;
console.error(`folding positions from block ${cursor} up to ${maxBlock}, step ${STEP}`);
while (cursor <= tip()) {
  if (budgetMs && Date.now() - started > budgetMs) {
    console.error("\nbudget reached; run again to continue");
    budgetHit = true;
    break;
  }
  // a visitor's scan owns the database while it runs
  while (scanInProgress()) sleep(1000);
  folded += step(cursor, cursor + STEP);
  cursor += STEP;
  db.pragma("wal_checkpoint(TRUNCATE)");
  const done = Math.min(100, ((cursor - minBlock) / Math.max(1, maxBlock - minBlock)) * 100);
  process.stderr.write(`\r  block ${cursor}  ${done.toFixed(1)}%  rows written ${folded}  ${((Date.now() - started) / 1000).toFixed(0)}s   `);
}
process.stderr.write("\n");

if (!budgetHit) {
  // Everything left, and the handover, in one transaction: from here the
  // follower folds what it appends, and no trade is folded twice.
  db.transaction(() => {
    fold.run(cursor, Number.MAX_SAFE_INTEGER);
    setMeta.run("positions_cursor", String(Number.MAX_SAFE_INTEGER));
    setMeta.run("positions_built", "1");
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  const rows = (db.prepare("SELECT COUNT(*) AS n FROM wallet_positions").get() as { n: number }).n;
  console.error(`done: ${rows} folded positions, profiles now read them`);
}
db.close();
