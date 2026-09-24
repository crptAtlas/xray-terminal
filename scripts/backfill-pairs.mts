/**
 * Fill in what each launch is quoted in. The factory announces it in
 * TokenLaunched, but the launch index only started recording it once a
 * balance had to be read in the right currency: amounts in a market
 * quoted against a stock or a stablecoin are not wei and must not be
 * added to one.
 *
 *   npx tsx scripts/backfill-pairs.mts
 */
import { decodeEventLog, toEventSelector } from "viem";
import { Cache } from "../lib/cache.ts";
import { makeClient } from "../lib/providers/rpc.ts";
import { getLogsAdaptive } from "../lib/providers/logs.ts";
import { factoryAbi } from "../lib/abi/pons.ts";
import { ADDR, type Hex } from "../lib/chain.ts";

const topic = toEventSelector("TokenLaunched(address,address,address,address,uint256,uint256)");
const cache = new Cache();
const db = (cache as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => unknown }; transaction: (f: () => void) => () => void } }).db;
const client = makeClient();

const latest = await client.getBlockNumber();
const STEP = 2_000_000n;
const put = db.prepare("UPDATE launches SET pair_token = ? WHERE token = ?");
let filled = 0;

for (let from = 0n; from <= latest; from += STEP) {
  const to = from + STEP - 1n > latest ? latest : from + STEP - 1n;
  const logs = await getLogsAdaptive(client, { address: ADDR.factory as Hex, topics: [topic as Hex], fromBlock: from, toBlock: to }, { parallel: 1 });
  const rows = logs.map((l) => {
    const d = decodeEventLog({ abi: factoryAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
    const a = d.args as unknown as { token: Hex; pairToken: Hex };
    return { token: a.token.toLowerCase(), pair: (a.pairToken ?? "0x0000000000000000000000000000000000000000").toLowerCase() };
  });
  db.transaction(() => {
    for (const r of rows) put.run(r.pair, r.token);
  })();
  filled += rows.length;
  process.stderr.write(`\r  blocks ${from}..${to}  launches filled ${filled}   `);
}
process.stderr.write("\n");
cache.close();
