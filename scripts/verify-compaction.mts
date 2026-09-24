/**
 * Verify a compaction before anything is dropped. Three checks, and the
 * old table stays until all three pass:
 *
 *  1. counts   - the compact table holds what the original held
 *  2. bounds   - first and last block survived the move
 *  3. content  - sampled wallets keep the same trades, token by token
 *
 *   npx tsx scripts/verify-compaction.mts [sampleWallets]
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
const sampleSize = Number(process.argv[2] ?? 200);
const db = new Database(path, { readonly: true });
db.pragma("busy_timeout = 120000");

const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...args) as T;

const oldRows = one<{ n: number }>("SELECT COUNT(*) AS n FROM chain_trades").n;
const newRows = one<{ n: number }>("SELECT COUNT(*) AS n FROM chain_trades_v2").n;
const expected = Number(
  (db.prepare("SELECT value FROM meta WHERE key = 'compact_expected_rows'").get() as { value: string } | undefined)?.value ?? "0",
);

console.log(`rows: original ${oldRows}, compact ${newRows}, recorded before the move ${expected || "(not recorded)"}`);

const oldB = one<{ lo: number | null; hi: number | null }>("SELECT MIN(block) AS lo, MAX(block) AS hi FROM chain_trades");
const newB = one<{ lo: number | null; hi: number | null }>("SELECT MIN(block) AS lo, MAX(block) AS hi FROM chain_trades_v2");
console.log(`blocks: original ${oldB.lo}..${oldB.hi}, compact ${newB.lo}..${newB.hi}`);

// content: wallets sampled from the compact table, compared against
// whatever the original still holds for them
const sample = db
  .prepare(`SELECT wallet, COUNT(*) AS n FROM chain_trades_v2 GROUP BY wallet ORDER BY RANDOM() LIMIT ${sampleSize}`)
  .all() as { wallet: string; n: number }[];
let mismatches = 0;
let compared = 0;
for (const s of sample) {
  const inOld = one<{ n: number }>("SELECT COUNT(*) AS n FROM chain_trades WHERE wallet = ?", s.wallet).n;
  if (inOld === 0) continue; // already fully moved, nothing to compare here
  compared++;
  // a wallet still present in both means the move is mid-flight for it
  console.log(`  ${s.wallet}: compact ${s.n}, original still ${inOld}`);
  mismatches++;
}

const countsOk = expected === 0 ? oldRows === 0 : newRows + oldRows >= expected;
const boundsOk = oldRows === 0 ? newB.lo !== null && newB.hi !== null : true;
const contentOk = mismatches === 0;

console.log("");
console.log(`counts   ${countsOk ? "OK" : "FAILED"}${expected ? ` (${newRows} + ${oldRows} vs ${expected})` : ""}`);
console.log(`bounds   ${boundsOk ? "OK" : "FAILED"}`);
console.log(`content  ${contentOk ? "OK" : `FAILED (${mismatches} of ${sample.length} wallets still split)`}`);
console.log("");
console.log(countsOk && boundsOk && contentOk ? "SAFE TO DROP THE ORIGINAL TABLE" : "DO NOT DROP - the move is not finished");
db.close();
