/**
 * Keep the raw trades to a rolling window and let the folded positions
 * carry the rest of the history.
 *
 * Nothing that a scan or a profile reads is lost: positions hold every
 * trade ever indexed, and the only thing raw trades are still read for
 * is the last day, where 24h volume and the market price come from. The
 * floors the fold covered are written down first, so a token launched
 * before the window still scans from the folded rows.
 *
 * What is given up is the ability to re-decode old history in place
 * (repair-v4) and to rebuild positions from scratch below the window.
 *
 *   npx tsx scripts/prune-trades.mts [retentionDays] [budgetMinutes]
 */
import Database from "better-sqlite3";
import { statfsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CHAIN } from "../lib/chain.ts";
import { scanInProgress } from "../lib/scanflag.ts";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
const retentionDays = Number(process.argv[2] ?? 45);
const budgetMs = Number(process.argv[3] ?? 0) * 60_000;
const MIN_FREE_GB = Number(process.env.XRAY_MIN_FREE_GB ?? 6);

const db = new Database(path);
db.pragma("busy_timeout = 120000");

const getMeta = (k: string): string | null =>
  (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
const setMeta = db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");

if (getMeta("positions_built") !== "1") {
  console.error("positions are not folded yet; run scripts/build-positions.mts first");
  process.exit(1);
}

// what the fold covered stays true even after the raw trades below it go
if (getMeta("positions_floor") === null) setMeta.run("positions_floor", getMeta("trades_floor") ?? "0");
if (getMeta("positions_floor_v4") === null) setMeta.run("positions_floor_v4", getMeta("trades_v4_floor") ?? "0");

const tip = Number(getMeta("trades_tip") ?? "0");
const keepFrom = tip - retentionDays * Number(CHAIN.blocksPerDay);
const floor = Number((db.prepare("SELECT MIN(block) AS b FROM chain_trades").get() as { b: number | null }).b ?? 0);
if (keepFrom <= floor) {
  console.error(`nothing to prune: the index starts at ${floor}, the window starts at ${keepFrom}`);
  process.exit(0);
}

const freeGb = (): number => {
  const s = statfsSync(path);
  return (Number(s.bavail) * Number(s.bsize)) / 1024 ** 3;
};

const STEP = Number(process.env.XRAY_PRUNE_STEP ?? 20_000);
const wipe = db.prepare("DELETE FROM chain_trades WHERE block >= ? AND block < ?");
const step = db.transaction((from: number, to: number) => {
  const n = wipe.run(from, to).changes;
  setMeta.run("trades_floor", String(to));
  setMeta.run("trades_v4_floor", String(Math.max(to, Number(getMeta("trades_v4_floor") ?? "0"))));
  return n;
});
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const started = Date.now();
let cursor = floor;
let removed = 0;
console.error(`pruning raw trades below block ${keepFrom} (${retentionDays} days), from ${floor}, step ${STEP}`);
while (cursor < keepFrom) {
  if (budgetMs && Date.now() - started > budgetMs) {
    console.error("\nbudget reached; run again to continue");
    break;
  }
  // deleting writes a journal of everything it frees, and that journal
  // cannot be trimmed mid-transaction: small steps, checkpointed
  if (freeGb() < MIN_FREE_GB) {
    console.error(`\nstopping: only ${freeGb().toFixed(1)}G free`);
    break;
  }
  while (scanInProgress()) sleep(1000);
  removed += step(cursor, Math.min(cursor + STEP, keepFrom));
  cursor = Math.min(cursor + STEP, keepFrom);
  db.pragma("wal_checkpoint(TRUNCATE)");
  process.stderr.write(`\r  block ${cursor}  removed ${removed}  free ${freeGb().toFixed(1)}G  ${((Date.now() - started) / 1000).toFixed(0)}s   `);
}
process.stderr.write("\n");
db.close();
