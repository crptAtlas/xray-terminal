import type { Cache } from "../cache.ts";
import type { RpcProvider } from "../providers/rpc.ts";
import { buildPositions, profileFromPositions, profileFromStats, type PositionSummary, type Profile } from "../profile/profile.ts";
import { applyAggregates, applyTrades, emptyLedger, ledgerPositions, type WalletLedger } from "../profile/ledger.ts";
import { ethUsd } from "../usd.ts";

/**
 * Wallet profiles through the global 24h cache, built from the local
 * chain-wide trade index: curve trades (trader in the event topics) plus
 * v4 pool trades (trader from the token transfer beside the swap). Full
 * history, no paid API; details in docs/DATA.md.
 *
 * The cache stores per-token position summaries plus the ETH balance, so
 * a profile can be folded with any token excluded (the token being
 * scanned never feeds its own holders' shown stats). remainingOf comes
 * from the wallet's own trade ledger (buys minus sells).
 */

interface CachedWallet {
  positions: PositionSummary[];
  ethWei: string;
  // the incremental ledger this profile derives from; new trades fold
  // on top of it, the record is never recomputed from the first block
  ledger?: WalletLedger;
  // trade-index floors at capture time, one per lane: while a backfill
  // deepens either lane, profiles captured shallower are stale and rebuilt
  floor: string;
  floorV4: string;
  // chain tip at capture: a wallet that traded past it gets recomputed
  tip?: string;
  // capture time: very fresh profiles are accepted as-is even if the
  // wallet traded again - hot bots trade every minute and rebuilding
  // a thousand of them on every scan costs minutes
  at?: number;
}

const FRESH_ENOUGH_MS = 10 * 60 * 1000;

/** A record with nothing in it: no Pons position, so no closed trade. */
const EMPTY_FOLD = { taken: 0, closed: 0, wins: 0, winsClosed: 0, pnlPctSum: 0, realizedWei: 0, openValueWei: 0 };

/** Step timings for a profile phase, on stderr under XRAY_TIMING=1. The
 * phase reads several sources and one slow step hides in the total. */
function timer(label: string) {
  const on = process.env.XRAY_TIMING === "1";
  let t = Date.now();
  return (step: string, extra = ""): void => {
    if (on) console.error(`  ${label} ${step}: ${Date.now() - t}ms ${extra}`);
    t = Date.now();
  };
}

function currentFloor(cache: Cache, lane: "curve" | "v4" = "curve"): bigint {
  return cache.tradeIndexSpan(lane)?.floor ?? 0n;
}

function readCached(cache: Cache, wallet: string, raw = cache.freshProfile(wallet)): CachedWallet | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedWallet>;
    if (!Array.isArray(parsed.positions) || typeof parsed.ethWei !== "string") return null; // old format
    if (typeof parsed.floor !== "string" || typeof parsed.floorV4 !== "string") return null; // pre-lane format
    if (BigInt(parsed.floor) > currentFloor(cache, "curve")) return null; // curve lane got deeper since
    if (BigInt(parsed.floorV4) > currentFloor(cache, "v4")) return null; // v4 lane got deeper since
    return parsed as CachedWallet;
  } catch {
    return null;
  }
}

const ledgerRemaining = (byToken: Map<string, { kind: string; tokens: bigint }[]>) => (token: string): bigint => {
  let bal = 0n;
  for (const t of byToken.get(token) ?? []) {
    bal += t.kind === "buy" ? t.tokens : -t.tokens;
  }
  return bal > 0n ? bal : 0n;
};

function curveResolver(rpc: RpcProvider, cache: Cache) {
  return async (curves: string[]): Promise<Map<string, string>> => {
    const known = cache.curveTokens(curves);
    const missing = curves.filter((c) => !known.has(c.toLowerCase()));
    if (missing.length) {
      // With the launch index at the head it already names every curve
      // there is, so an address missing from it is not one - no need to
      // ask the chain, which answers by scanning every launch ever made.
      // Nothing is written down: a launch indexed a moment later must
      // still be able to resolve, so this holds only for this scan.
      // The slack is generous on purpose: the follower indexes launches
      // right after trades, so it trails the head by a few hundred blocks
      // at all times, and a curve younger than the slack is a token
      // launched minutes ago - worth skipping in someone's record rather
      // than paying a full launch-history scan for.
      const tip = cache.tradeIndexSpan("curve")?.tip ?? 0n;
      if (cache.launchesTip() + 50_000n >= tip) {
        for (const c of missing) known.set(c.toLowerCase(), "");
        return known;
      }
      const fetched = await rpc.curvesToTokens(missing);
      // Asking the chain costs a scan of every launch ever made, so an
      // address the factory never launched is remembered as such: the
      // pair tokens and infrastructure addresses that ride the same
      // pools would otherwise be asked about on every single scan.
      const learned = new Map(fetched);
      for (const c of missing) {
        const lc = c.toLowerCase();
        if (!learned.has(lc)) learned.set(lc, "");
      }
      cache.saveCurveTokens(learned);
      for (const [c, t] of learned) known.set(c, t);
    }
    return known;
  };
}

export async function walletProfile(
  rpc: RpcProvider,
  cache: Cache,
  wallet: string,
  excludeToken?: string,
): Promise<Profile> {
  const rate = await ethUsd().catch(() => 0);
  const cached = readCached(cache, wallet);
  if (cached) return profileFromPositions(wallet, cached.positions, BigInt(cached.ethWei), excludeToken, rate);

  const w = wallet.toLowerCase();
  const [byWallet, ethWei] = await Promise.all([
    rpc.walletTradesBatch([w], curveResolver(rpc, cache)),
    rpc.ethBalances([w]),
  ]);
  const byToken = byWallet.get(w) ?? new Map();
  const positions = buildPositions(byToken, ledgerRemaining(byToken));
  const eth = ethWei.get(w) ?? 0n;
  // a direct topic query reads the whole chain of curve events, but no
  // v4 history: mark the v4 side stale so the index replaces it
  cache.saveProfile(
    w,
    JSON.stringify({ positions, ethWei: eth.toString(), floor: "0", floorV4: currentFloor(cache, "v4").toString() } satisfies CachedWallet),
  );
  return profileFromPositions(w, positions, eth, excludeToken, rate);
}

/**
 * Profiles for many wallets. Preferred source: the local chain-wide
 * trade index (lib/read/indexer.ts) - one tail sync, then everything is
 * a local SELECT plus a balance multicall; a thousand wallets take
 * seconds and the depth is whatever the index has backfilled. Without
 * an index (a fresh serverless instance) it falls back to direct
 * topic-filtered getLogs in small batches, which the public node only
 * answers reliably for a couple dozen wallets at a time.
 */
export async function walletProfilesBatch(
  rpc: RpcProvider,
  cache: Cache,
  wallets: string[],
  deadlineMs: number,
  excludeToken?: string,
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>();
  const deadline = Date.now() + deadlineMs;
  const lap = timer("batch");
  const rate = await ethUsd().catch(() => 0);
  lap("ethUsd");

  // With the positions folded, a profile is a handful of indexed rows:
  // cheaper to read than the cached copy of it, which carries a wallet's
  // whole per-token ledger as JSON and runs to megabytes for a bot that
  // has touched twenty thousand markets. Reading two hundred of those
  // cost seven seconds, writing one cost three.
  if (cache.positionsReady()) {
    await profilesFromIndex(rpc, cache, wallets, excludeToken, rate, out);
    lap("build");
    for (const w of wallets) {
      if (!out.has(w)) out.set(w, notRead(w));
    }
    return out;
  }

  const misses: string[] = [];
  const increments = new Map<string, CachedWallet>();
  const hits = new Map<string, CachedWallet>();
  // one chunked read for the whole set, not a query per wallet
  const cachedJson = cache.freshProfiles(wallets);
  for (const w of wallets) {
    const cached = readCached(cache, w, cachedJson.get(w.toLowerCase()) ?? null);
    if (cached) hits.set(w, cached);
    else misses.push(w);
  }
  lap("cached", `${hits.size} hits, ${misses.length} misses`);
  // a cached profile goes stale the moment its wallet trades again; the
  // check is a local indexed query per distinct capture tip (profiles
  // cached in one scan share a tip, so this is one or two queries)
  if (hits.size) {
    const byTip = new Map<string, string[]>();
    const now = Date.now();
    for (const [w, c] of hits) {
      if (c.tip === undefined) {
        misses.push(w); // pre-tip format: rebuild once
        hits.delete(w);
        continue;
      }
      if (c.at !== undefined && now - c.at < FRESH_ENOUGH_MS) continue; // fresh enough as-is
      const list = byTip.get(c.tip) ?? [];
      list.push(w);
      byTip.set(c.tip, list);
    }
    const stale = new Set<string>();
    for (const [tip, ws] of byTip) {
      for (const w of cache.walletsTradedSince(ws, BigInt(tip))) stale.add(w);
    }
    for (const [w, c] of hits) {
      if (stale.has(w.toLowerCase())) {
        if (c.ledger) increments.set(w, c); // fold only the new trades
        else misses.push(w);
      } else out.set(w, profileFromPositions(w, c.positions, BigInt(c.ethWei), excludeToken, rate));
    }
  }

  lap("staleness", `${increments.size} to extend`);
  const span = cache.tradeIndexSpan();
  if (increments.size && span && span.tip > span.floor) {
    await profilesFromIndex(rpc, cache, [...increments.keys()], excludeToken, rate, out, increments);
    lap("extend");
  }
  if (misses.length && span && span.tip > span.floor) {
    await profilesFromIndex(rpc, cache, misses, excludeToken, rate, out);
    lap("rebuild");
  } else if (misses.length) {
    await profilesFromRpc(rpc, cache, misses, deadline, excludeToken, rate, out);
    lap("rebuild from rpc");
  }
  for (const w of wallets) {
    if (!out.has(w)) out.set(w, notRead(w));
  }
  return out;
}

async function profilesFromIndex(
  rpc: RpcProvider,
  cache: Cache,
  misses: string[],
  excludeToken: string | undefined,
  rate: number,
  out: Map<string, Profile>,
  prior: Map<string, CachedWallet> = new Map(),
): Promise<void> {
  // the head is followed by a dedicated process (xray follow) wherever
  // one runs; a scan only syncs the tail itself when nobody else does
  const lap = timer(`index(${misses.length})`);
  if (process.env.XRAY_FOLLOWER !== "external") {
    const { syncTradeIndexTail } = await import("./indexer.ts");
    try {
      await syncTradeIndexTail(rpc.client, cache, "curve");
      await syncTradeIndexTail(rpc.client, cache, "v4");
    } catch (err) {
      console.warn(`trade index tail sync: ${err instanceof Error ? err.message : err}`);
    }
    lap("tail sync");
  }
  const floorNow = currentFloor(cache, "curve");
  const floorV4Now = currentFloor(cache, "v4");
  const tipNow = cache.tradeIndexSpan("curve")?.tip ?? 0n;
  const lower = misses.map((w) => w.toLowerCase());
  // The folded positions hold every wallet's whole record already, so
  // when they are built a profile is one indexed read of a few dozen
  // rows rather than a fold over its trades.
  const folded = cache.positionsReady();

  if (folded) {
    // The database adds the record up and returns the six numbers a
    // profile is made of. Carrying the rows out instead means moving a
    // bot's three hundred thousand markets through memory for an
    // average it could compute in place.
    const stats = cache.profileStats(lower, excludeToken);
    lap("record", `${stats.size} wallets`);
    const ethWei = await rpc.ethBalances(lower).catch(() => new Map<string, bigint>());
    lap("eth balances");
    for (const w of misses) {
      const lw = w.toLowerCase();
      // no row means nothing of theirs is a Pons position, which is a
      // record of zero trades, not a record that could not be read
      const s = stats.get(lw) ?? { shown: EMPTY_FOLD, full: EMPTY_FOLD };
      out.set(w, profileFromStats(w, s, ethWei.get(lw) ?? 0n, rate));
    }
    lap("profiles", `${out.size} built`);
    return;
  }
  // Wallets with a prior ledger read only what happened past their synced
  // block; fresh ones read their history once.
  const rowsByWallet = new Map<string, ReturnType<Cache["chainTradesFor"]> extends Map<string, infer R> ? R : never>();
  const fresh: string[] = [];
  const byPriorBlock = new Map<string, string[]>();
  for (const w of misses) {
    const lw = w.toLowerCase();
    const p = prior.get(w)?.ledger;
    if (p) {
      const list = byPriorBlock.get(p.syncedBlock) ?? [];
      list.push(lw);
      byPriorBlock.set(p.syncedBlock, list);
    } else fresh.push(lw);
  }
  if (!folded) {
    for (const [block, ws] of byPriorBlock) {
      for (const [lw, rows] of cache.chainTradesFor(ws, BigInt(block))) rowsByWallet.set(lw, rows);
    }
    for (const [lw, rows] of cache.chainTradesFor(fresh)) rowsByWallet.set(lw, rows);
  }
  // per wallet and token, the sums a ledger needs
  lap("trade rows", `${rowsByWallet.size} wallets`);
  const aggByWallet = folded
    ? cache.walletPositions(lower)
    : new Map<string, Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>>();
  if (folded) lap("folded positions", `${aggByWallet.size} wallets`);
  for (const [lw, rows] of rowsByWallet) {
    const byKey = new Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>();
    for (const r of rows) {
      const k = r.token && r.token !== "" ? r.token : r.curve;
      if (!k) continue;
      const cur = byKey.get(k) ?? { buyTokens: 0, buyEth: 0, sellTokens: 0, sellEth: 0, trades: 0, lastPrice: 0, lastBlock: 0 };
      const tok = Number(r.tokens);
      const eth = Number(r.eth);
      if (r.kind === "buy") {
        cur.buyTokens += tok;
        cur.buyEth += eth;
      } else {
        cur.sellTokens += tok;
        cur.sellEth += eth;
      }
      cur.trades++;
      const b = Number(r.block);
      if (b >= cur.lastBlock) {
        cur.lastBlock = b;
        if (tok > 0) cur.lastPrice = eth / tok;
      }
      byKey.set(k, cur);
    }
    aggByWallet.set(lw, byKey);
  }
  // an aggregate key is either a token address (pool trades) or a curve
  const curves = new Set<string>();
  const directTokens = new Set<string>();
  for (const agg of aggByWallet.values()) {
    for (const key of agg.keys()) {
      if (!key) continue;
      directTokens.add(key);
      curves.add(key);
    }
  }
  lap("aggregate");
  // v4 rows name their token directly, but pair tokens (NVDA, SPCX, ...)
  // ride the same pools; only launched tokens count as positions
  const launched = cache.launchTokens([...directTokens]);
  lap("launch lookup", `${directTokens.size} tokens`);
  // a key that is a launched token is a pool trade, never a curve: asking
  // the chain to resolve it as one is a full launch-history scan for an
  // answer that does not exist
  const tokenOf = await curveResolver(rpc, cache)([...curves].filter((k) => !launched.has(k)));
  lap("resolve curves", `${curves.size} keys`);
  const ethWei = await rpc.ethBalances(lower).catch(() => new Map<string, bigint>());
  lap("eth balances");
  // every rebuilt profile lands in one transaction at the end
  const writes: { wallet: string; json: string }[] = [];
  for (const w of misses) {
    const lw = w.toLowerCase();
    const byToken = new Map<string, { buyTokens: number; buyEth: number; sellTokens: number; sellEth: number; trades: number; lastPrice: number; lastBlock: number }>();
    for (const [key, a] of aggByWallet.get(lw) ?? []) {
      // a key that is a launched token is a pool trade; otherwise it is a
      // curve address that resolves to its token
      const token = launched.has(key) ? key : tokenOf.get(key);
      if (!token) continue;
      const cur = byToken.get(token);
      if (cur) {
        cur.buyTokens += a.buyTokens;
        cur.buyEth += a.buyEth;
        cur.sellTokens += a.sellTokens;
        cur.sellEth += a.sellEth;
        cur.trades += a.trades;
        if (a.lastBlock > cur.lastBlock) {
          cur.lastBlock = a.lastBlock;
          cur.lastPrice = a.lastPrice;
        }
      } else byToken.set(token, { ...a });
    }
    // folded positions are the whole record, so they fold onto nothing;
    // raw rows continue whatever ledger the wallet already had
    const before = folded ? emptyLedger() : (prior.get(w)?.ledger ?? emptyLedger());
    const ledger = applyAggregates(before, byToken, tipNow);
    const positions = ledgerPositions(ledger);
    const eth = ethWei.get(lw) ?? 0n;
    if (!folded) {
      writes.push({
        wallet: w,
        json: JSON.stringify({
          positions,
          ethWei: eth.toString(),
          ledger,
          floor: floorNow.toString(),
          floorV4: floorV4Now.toString(),
          tip: tipNow.toString(),
          at: Date.now(),
        } satisfies CachedWallet),
      });
    }
    out.set(w, profileFromPositions(w, positions, eth, excludeToken, rate));
  }
  lap("fold ledgers");
  // folded profiles are rebuilt from the positions every time, so there
  // is nothing worth storing a copy of
  if (!folded) {
    cache.saveProfiles(writes);
    lap("save", `${writes.length} profiles`);
  }
}

async function profilesFromRpc(
  rpc: RpcProvider,
  cache: Cache,
  misses: string[],
  deadline: number,
  excludeToken: string | undefined,
  rate: number,
  out: Map<string, Profile>,
): Promise<void> {
  const CHUNK = 25; // the node answers small topic batches over the full range; larger ones time out
  let failures = 0;
  for (let i = 0; i < misses.length; i += CHUNK) {
    if (Date.now() > deadline) break;
    if (failures >= 2) break; // the node is refusing - stop burning time, the cache fills in later
    const chunk = misses.slice(i, i + CHUNK);
    try {
      const [byWallet, ethWei] = await Promise.all([
        rpc.walletTradesBatch(chunk.map((w) => w.toLowerCase()), curveResolver(rpc, cache)),
        rpc.ethBalances(chunk.map((w) => w.toLowerCase())),
      ]);
      failures = 0;
      const writes: { wallet: string; json: string }[] = [];
      for (const w of chunk) {
        const byToken = byWallet.get(w.toLowerCase()) ?? new Map();
        const positions = buildPositions(byToken, ledgerRemaining(byToken));
        const eth = ethWei.get(w.toLowerCase()) ?? 0n;
        writes.push({
          wallet: w,
          json: JSON.stringify({ positions, ethWei: eth.toString(), floor: "0", floorV4: currentFloor(cache, "v4").toString() } satisfies CachedWallet),
        });
        out.set(w, profileFromPositions(w, positions, eth, excludeToken, rate));
      }
      cache.saveProfiles(writes);
    } catch (err) {
      failures++;
      console.warn(`profile batch ${i / CHUNK}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function notRead(wallet: string): Profile {
  return {
    wallet,
    trades: 0,
    wins: 0,
    avgPnlPerTrade: null,
    winrate: null,
    realizedTotalEth: 0,
    balanceEth: 0,
    badges: [],
    notRead: true,
  };
}
