/**
 * What the whole chain's traders actually do.
 *
 * The same rules the terminal applies to one holder, applied to every
 * wallet that ever traded a Pons launch: realized positions only, each
 * position's return clamped to the band an average is read in, winrate
 * penalised by one virtual loss. Two views come out of it - what a
 * typical wallet does, and what a typical position returns - because
 * they answer different questions and disagree in an interesting way.
 *
 *   npx tsx scripts/network-stats.mts
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
// read only: the follower is writing to this file the whole time,
// and nothing here needs the main database to change
const db = new Database(path, { readonly: true });
db.pragma("busy_timeout = 600000");
db.pragma("cache_size = -524288"); // 512 MB, the site needs the rest
db.pragma("temp_store = FILE"); // the grouping spills to disk, not into 3 GB of RAM

const t0 = Date.now();
const say = (s: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`);

// One row per wallet and token: the curve side and the pool side of the
// same launch are one position, exactly as a profile reads it.
say("folding every wallet's positions (this walks the whole index)...");
db.exec(`
DROP TABLE IF EXISTS temp.net_pos;
CREATE TEMP TABLE net_pos AS
SELECT wp.wallet AS w,
       COALESCE(lt.token, lc.token, NULLIF(ct.token, '')) AS tok,
       SUM(wp.buy_tokens) AS bt, SUM(wp.buy_eth) AS bc,
       SUM(wp.sell_tokens) AS st, SUM(wp.sell_eth) AS sp
FROM wallet_positions wp
LEFT JOIN launches lt ON lt.token = wp.market
LEFT JOIN launches lc ON lc.curve = wp.market
LEFT JOIN curve_tokens ct ON ct.curve = wp.market
GROUP BY w, tok;
`);
say(`positions: ${(db.prepare("SELECT COUNT(*) n FROM temp.net_pos").get() as { n: number }).n}`);

// Realized only, and every return read inside the same band, so one
// position bought for a rounding error cannot carry an average.
say("scoring the positions a wallet actually closed out of...");
db.exec(`
DROP TABLE IF EXISTS temp.net_real;
CREATE TEMP TABLE net_real AS
SELECT w, MAX(-100.0, MIN(500.0, (sp - bc * st / bt) / (bc * st / bt) * 100)) AS pct
FROM temp.net_pos
WHERE tok IS NOT NULL AND bt > 0 AND bc > 0 AND st > 0
  AND st <= bt * 1.000000001
  AND bc * st / bt > 0;
`);

say("folding those into one record per wallet...");
db.exec(`
DROP TABLE IF EXISTS temp.net_wallet;
CREATE TEMP TABLE net_wallet AS
SELECT w, COUNT(*) AS n, AVG(pct) AS avg_pct,
       SUM(CASE WHEN pct > 0 THEN 1 ELSE 0 END) AS wins
FROM temp.net_real GROUP BY w;
CREATE INDEX temp.idx_nw_avg ON net_wallet(avg_pct);
CREATE INDEX temp.idx_nw_n ON net_wallet(n);
`);

const one = <T>(sql: string, ...a: unknown[]): T => db.prepare(sql).get(...a) as T;
const pct = (table: string, col: string, where: string, p: number, total: number): number => {
  const off = Math.max(0, Math.min(total - 1, Math.floor(total * p)));
  return (one<{ v: number }>(`SELECT ${col} AS v FROM ${table} ${where} ORDER BY ${col} LIMIT 1 OFFSET ${off}`) ?? { v: 0 }).v;
};

const walletsAll = one<{ n: number }>("SELECT COUNT(DISTINCT wallet) n FROM wallet_positions").n;
const walletsRealized = one<{ n: number }>("SELECT COUNT(*) n FROM temp.net_wallet").n;
const positions = one<{ n: number }>("SELECT COUNT(*) n FROM temp.net_real").n;

console.log("");
console.log("=".repeat(64));
console.log("EVERY WALLET THAT EVER TRADED A PONS LAUNCH");
console.log("=".repeat(64));
console.log(`wallets seen trading            ${walletsAll.toLocaleString("en-US")}`);
console.log(`of them, ever closed a position ${walletsRealized.toLocaleString("en-US")}  (${((walletsRealized / walletsAll) * 100).toFixed(1)}%)`);
console.log(`realized positions in total     ${positions.toLocaleString("en-US")}`);

// what one position returns
const posStats = one<{ mean: number }>("SELECT AVG(pct) AS mean FROM temp.net_real");
console.log("");
console.log("--- per position (what one trade returns) ---");
console.log(`mean   ${posStats.mean.toFixed(1)}%`);
for (const p of [0.25, 0.5, 0.75, 0.9]) {
  console.log(`p${(p * 100).toFixed(0).padStart(2)}    ${pct("temp.net_real", "pct", "", p, positions).toFixed(1)}%`);
}
const winPositions = one<{ n: number }>("SELECT COUNT(*) n FROM temp.net_real WHERE pct > 0").n;
console.log(`in profit  ${winPositions.toLocaleString("en-US")} of ${positions.toLocaleString("en-US")}  (${((winPositions / positions) * 100).toFixed(1)}%)`);

// what one wallet averages
const wStats = one<{ mean: number }>("SELECT AVG(avg_pct) AS mean FROM temp.net_wallet");
console.log("");
console.log("--- per wallet (what a trader averages) ---");
console.log(`mean   ${wStats.mean.toFixed(1)}%`);
for (const p of [0.25, 0.5, 0.75, 0.9]) {
  console.log(`p${(p * 100).toFixed(0).padStart(2)}    ${pct("temp.net_wallet", "avg_pct", "", p, walletsRealized).toFixed(1)}%`);
}
const upWallets = one<{ n: number }>("SELECT COUNT(*) n FROM temp.net_wallet WHERE avg_pct > 0").n;
console.log(`net up     ${upWallets.toLocaleString("en-US")} of ${walletsRealized.toLocaleString("en-US")}  (${((upWallets / walletsRealized) * 100).toFixed(1)}%)`);

// winrate needs two positions to mean anything
db.exec(`
DROP TABLE IF EXISTS temp.net_wr;
CREATE TEMP TABLE net_wr AS
SELECT w, (CAST(wins AS REAL) / (n + 1)) * 100 AS wr FROM temp.net_wallet WHERE n >= 2;
CREATE INDEX temp.idx_wr ON net_wr(wr);
`);
const wrN = one<{ n: number }>("SELECT COUNT(*) n FROM temp.net_wr").n;
const wrMean = one<{ mean: number }>("SELECT AVG(wr) AS mean FROM temp.net_wr").mean;
console.log("");
console.log(`--- winrate, wallets with 2+ closed positions (${wrN.toLocaleString("en-US")} wallets) ---`);
console.log(`mean   ${wrMean.toFixed(1)}%`);
for (const p of [0.25, 0.5, 0.75, 0.9]) {
  console.log(`p${(p * 100).toFixed(0).padStart(2)}    ${pct("temp.net_wr", "wr", "", p, wrN).toFixed(1)}%`);
}

// how much of the crowd is a tourist and how much is a machine
console.log("");
console.log("--- how many positions a wallet closes ---");
for (const [label, cond] of [["1", "n = 1"], ["2-5", "n BETWEEN 2 AND 5"], ["6-20", "n BETWEEN 6 AND 20"], ["21-100", "n BETWEEN 21 AND 100"], ["100+", "n > 100"]] as const) {
  const r = one<{ n: number; avg: number | null }>(`SELECT COUNT(*) n, AVG(avg_pct) avg FROM temp.net_wallet WHERE ${cond}`);
  const share = ((r.n / walletsRealized) * 100).toFixed(1);
  console.log(`${label.padEnd(7)} ${String(r.n).padStart(9)} wallets (${share.padStart(5)}%)   their avg ${r.avg === null ? "-" : r.avg.toFixed(1) + "%"}`);
}
console.log("");
say("done");
db.close();
