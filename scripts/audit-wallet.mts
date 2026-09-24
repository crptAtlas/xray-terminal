/**
 * Wallet audit: rebuild one wallet's record straight from the chain and
 * compare it against what the terminal shows. The chain side re-reads
 * curve events by topic and v4 trades by pool transfer, independent of
 * the local index, so a mismatch means the index or the fold is wrong.
 *
 *   npx tsx scripts/audit-wallet.mts <wallet> [maxTokens]
 */
import { Cache } from "../lib/cache.ts";
import { RpcProvider } from "../lib/providers/rpc.ts";
import { getLogsAdaptive } from "../lib/providers/logs.ts";
import { decodeV4Rows } from "../lib/read/indexer.ts";
import { ADDR, TOPIC, type Hex } from "../lib/chain.ts";
import { SWAP_TOPIC } from "../lib/abi/pool.ts";
import { applyTrades, emptyLedger, ledgerPositions } from "../lib/profile/ledger.ts";
import type { Trade } from "../lib/pnl/classify.ts";

const wallet = (process.argv[2] ?? "").toLowerCase();
const maxTokens = Number(process.argv[3] ?? 4);
if (!/^0x[0-9a-f]{40}$/.test(wallet)) {
  console.error("usage: audit-wallet.mts <wallet> [maxTokens]");
  process.exit(1);
}

const cache = new Cache();
const rpc = new RpcProvider();
const span = cache.tradeIndexSpan("v4");
const curveSpan = cache.tradeIndexSpan("curve");
console.log(`index spans: curve ${curveSpan?.floor}..${curveSpan?.tip}  v4 ${span?.floor}..${span?.tip}`);

// --- what the index says ---
const rows = cache.chainTradesFor([wallet]).get(wallet) ?? [];
const curves = [...new Set(rows.filter((r) => !r.token && r.curve).map((r) => r.curve))];
const known = cache.curveTokens(curves);
const missing = curves.filter((c) => !known.has(c));
if (missing.length) {
  const fetched = await rpc.curvesToTokens(missing);
  cache.saveCurveTokens(fetched);
  for (const [c, t] of fetched) known.set(c, t);
}
const launched = cache.launchTokens([...new Set(rows.filter((r) => r.token).map((r) => r.token!))]);
const byToken = new Map<string, Trade[]>();
for (const r of rows) {
  const token = r.token ? (launched.has(r.token) ? r.token : undefined) : known.get(r.curve);
  if (!token) continue;
  const list = byToken.get(token) ?? [];
  list.push({ wallet, kind: r.kind, tokens: r.tokens, eth: r.eth, block: r.block, tx: r.tx });
  byToken.set(token, list);
}
const indexPositions = ledgerPositions(applyTrades(emptyLedger(), byToken, span?.tip ?? 0n));
console.log(`index: ${rows.length} rows, ${byToken.size} launched tokens, ${indexPositions.length} positions`);

// --- what the chain says, token by token ---
const pad = (a: string) => `0x000000000000000000000000${a.slice(2)}` as Hex;
const tokens = [...byToken.keys()].slice(0, maxTokens);
let bad = 0;
for (const token of tokens) {
  const meta = await rpc.tokenMeta(token as Hex).catch(() => null);
  if (!meta) continue;
  const from = meta.createdBlock;
  const to = await rpc.client.getBlockNumber();
  // curve side: the wallet's own buys and sells of this token
  const [buyLogs, sellLogs] = await Promise.all([
    getLogsAdaptive(rpc.client, { address: meta.curve, topics: [TOPIC.curveBuy as Hex, null, pad(wallet)], fromBlock: from, toBlock: to }, { parallel: 1 }),
    getLogsAdaptive(rpc.client, { address: meta.curve, topics: [TOPIC.curveSell as Hex, pad(wallet)], fromBlock: from, toBlock: to }, { parallel: 1 }),
  ]);
  // v4 side: token transfers between the wallet and the pool manager
  const [toPm, fromPm] = await Promise.all([
    getLogsAdaptive(rpc.client, { address: token as Hex, topics: [TOPIC.transfer as Hex, pad(wallet), pad(ADDR.poolManager)], fromBlock: from, toBlock: to }, { parallel: 1 }),
    getLogsAdaptive(rpc.client, { address: token as Hex, topics: [TOPIC.transfer as Hex, pad(ADDR.poolManager), pad(wallet)], fromBlock: from, toBlock: to }, { parallel: 1 }),
  ]);
  const txs = new Set([...toPm, ...fromPm].map((l) => l.transactionHash));
  let v4Rows: ReturnType<typeof decodeV4Rows> = [];
  if (txs.size) {
    const blocks = [...new Set([...toPm, ...fromPm].map((l) => l.blockNumber))];
    const swaps = (
      await Promise.all(
        blocks.map((b) =>
          getLogsAdaptive(rpc.client, { address: ADDR.poolManager as Hex, topics: [SWAP_TOPIC as Hex], fromBlock: b, toBlock: b }, { parallel: 1 }),
        ),
      )
    ).flat();
    // the pool pays the wallet and the hook in the same tx; decode needs both legs
    const allLegs = (
      await Promise.all(
        blocks.map((b) =>
          getLogsAdaptive(rpc.client, { address: token as Hex, topics: [TOPIC.transfer as Hex], fromBlock: b, toBlock: b }, { parallel: 1 }),
        ),
      )
    ).flat().filter((l) => txs.has(l.transactionHash));
    v4Rows = decodeV4Rows(allLegs, swaps.filter((s) => txs.has(s.transactionHash))).filter((r) => r.wallet === wallet);
  }
  const chainBuys = buyLogs.length + v4Rows.filter((r) => r.kind === "buy").length;
  const chainSells = sellLogs.length + v4Rows.filter((r) => r.kind === "sell").length;
  const mine = byToken.get(token) ?? [];
  const idxBuys = mine.filter((t) => t.kind === "buy").length;
  const idxSells = mine.filter((t) => t.kind === "sell").length;
  const ok = chainBuys === idxBuys && chainSells === idxSells;
  if (!ok) bad++;
  console.log(
    `  $${meta.symbol.padEnd(10)} index ${idxBuys}b/${idxSells}s   chain ${chainBuys}b/${chainSells}s   ${ok ? "MATCH" : "MISMATCH"}`,
  );
}
console.log(bad === 0 ? "ALL TOKENS MATCH" : `${bad} of ${tokens.length} tokens mismatch`);
cache.close();

