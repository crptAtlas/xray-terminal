/**
 * Token audit: count a token's trades in the index and against the chain.
 * The curve side is exact (events name the trader); the pool side is a
 * best-effort decode, so its capture rate is reported, not asserted.
 *
 *   npx tsx scripts/audit-token.mts <token> [...more tokens]
 */
import { Cache } from "../lib/cache.ts";
import { RpcProvider } from "../lib/providers/rpc.ts";
import { getLogsAdaptive } from "../lib/providers/logs.ts";
import { ADDR, TOPIC, INFRA, type Hex } from "../lib/chain.ts";
import { SWAP_TOPIC } from "../lib/abi/pool.ts";

const tokens = process.argv.slice(2).map((t) => t.toLowerCase());
if (tokens.length === 0) {
  console.error("usage: audit-token.mts <token> [...]");
  process.exit(1);
}

const cache = new Cache();
const rpc = new RpcProvider();
const pad = (a: string) => `0x000000000000000000000000${a.slice(2)}` as Hex;

for (const token of tokens) {
  const meta = await rpc.tokenMeta(token as Hex).catch(() => null);
  if (!meta) {
    console.log(`${token}: not a Pons launch`);
    continue;
  }
  const to = await rpc.client.getBlockNumber();
  const indexed = cache.tokenTradesFromIndex(token, meta.curve);
  const idxCurve = indexed.filter((t) => t.block <= to).length;

  // chain: every curve event of this token's curve
  const [buys, sells] = await Promise.all([
    getLogsAdaptive(rpc.client, { address: meta.curve, topics: [TOPIC.curveBuy as Hex], fromBlock: meta.createdBlock, toBlock: to }, { parallel: 2 }),
    getLogsAdaptive(rpc.client, { address: meta.curve, topics: [TOPIC.curveSell as Hex], fromBlock: meta.createdBlock, toBlock: to }, { parallel: 2 }),
  ]);
  const chainCurve = buys.length + sells.length;

  // chain: pool legs that belong to a wallet, the ceiling for the v4 side
  const [toPm, fromPm] = await Promise.all([
    getLogsAdaptive(rpc.client, { address: token as Hex, topics: [TOPIC.transfer as Hex, null, pad(ADDR.poolManager)], fromBlock: meta.createdBlock, toBlock: to }, { parallel: 2 }),
    getLogsAdaptive(rpc.client, { address: token as Hex, topics: [TOPIC.transfer as Hex, pad(ADDR.poolManager)], fromBlock: meta.createdBlock, toBlock: to }, { parallel: 2 }),
  ]);
  const walletLegs = [...toPm, ...fromPm].filter((l) => {
    const f = ("0x" + (l.topics[1] as string).slice(26)).toLowerCase();
    const t = ("0x" + (l.topics[2] as string).slice(26)).toLowerCase();
    const w = t === ADDR.poolManager ? f : t;
    return !INFRA.has(w);
  }).length;

  const idxTotal = indexed.length;
  const idxV4 = idxTotal - idxCurve >= 0 ? idxTotal - idxCurve : 0;
  // curve rows in the index are identified by having a curve address
  const curveRows = indexed.filter((t) => t.tx !== "" && t.block > 0n).length;
  console.log(
    `$${meta.symbol.padEnd(10)} index ${idxTotal} rows  |  curve chain ${chainCurve}  |  pool wallet legs ${walletLegs}  |  index/chain ${(100 * idxTotal / Math.max(1, chainCurve + walletLegs)).toFixed(0)}%`,
  );
}
cache.close();
