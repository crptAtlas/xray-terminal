/**
 * Rebuild each market's price from its own recent trades.
 *
 * A single trade is not a price: a leg that moves a sliver of tokens for
 * a normal amount of quote reads as a price a thousand times the real
 * one, and everything a wallet still holds in that market gets valued
 * against it. This takes the median of a market's last twenty trades,
 * the same rule the scanned token's own price already uses.
 *
 *   npx tsx scripts/rebuild-market-price.mts [minBlock]
 */
import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.env.XRAY_DB ?? join(homedir(), ".xray", "cache.db");
const db = new Database(path);
db.pragma("busy_timeout = 120000");
db.pragma("cache_size = -524288");

const markets = db
  .prepare("SELECT market, last_block FROM market_price ORDER BY last_block DESC")
  .all() as { market: string; last_block: number }[];
console.error(`rebuilding prices for ${markets.length} markets`);

// The trailing trades of one market, one indexed side at a time. Asking
// for both sides in a union and sorting that reads the market's whole
// history before it can take twenty rows: on a busy market that is a
// hundred thousand random reads for a number twenty rows can answer.
const recentToken = db.prepare(
  "SELECT tokens, eth FROM chain_trades WHERE token = ? ORDER BY block DESC, log_index DESC LIMIT 20",
);
const recentCurve = db.prepare(
  "SELECT tokens, eth FROM chain_trades WHERE curve = ? ORDER BY block DESC, log_index DESC LIMIT 20",
);
const put = db.prepare("UPDATE market_price SET last_price = ? WHERE market = ?");

let done = 0;
let changed = 0;
const started = Date.now();
const batch = db.transaction((slice: { market: string }[]) => {
  for (const m of slice) {
    const rows = [
      ...(recentToken.all(m.market) as { tokens: number; eth: number }[]),
      ...(recentCurve.all(m.market) as { tokens: number; eth: number }[]),
    ];
    // a trade too small on either side prices nothing
    const prices = rows
      .filter((r) => r.tokens >= 1e12 && r.eth >= 1e12)
      .map((r) => r.eth / r.tokens)
      .sort((a, b) => a - b);
    if (prices.length === 0) continue;
    const mid = prices[Math.floor(prices.length / 2)]!;
    if (Number.isFinite(mid) && mid > 0) {
      put.run(mid, m.market);
      changed++;
    }
  }
});

for (let i = 0; i < markets.length; i += 500) {
  // the follower writes to the same file, so each batch takes the write
  // lock up front rather than reading first and failing to upgrade
  batch.immediate(markets.slice(i, i + 500));
  done += Math.min(500, markets.length - i);
  process.stderr.write(`\r  ${done} of ${markets.length}  repriced ${changed}  ${((Date.now() - started) / 1000).toFixed(0)}s   `);
}
process.stderr.write("\n");
db.close();

