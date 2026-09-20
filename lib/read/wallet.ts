import type { Cache } from "../cache.ts";
import type { RpcProvider } from "../providers/rpc.ts";
import { buildPositions, profileFromPositions, type PositionSummary, type Profile } from "../profile/profile.ts";
import { applyTrades, emptyLedger, ledgerPositions, type WalletLedger } from "../profile/ledger.ts";
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

function currentFloor(cache: Cache, lane: "curve" | "v4" = "curve"): bigint {
  return cache.tradeIndexSpan(lane)?.floor ?? 0n;
}

function readCached(cache: Cache, wallet: string): CachedWallet | null {
  const raw = cache.freshProfile(wallet);
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
      const fetched = await rpc.curvesToTokens(missing);
      cache.saveCurveTokens(fetched);
      for (const [c, t] of fetched) known.set(c, t);
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
  const rate = await ethUsd().catch(() => 0);
  const misses: string[] = [];
  const increments = new Map<string, CachedWallet>();
  const hits = new Map<string, CachedWallet>();
  for (const w of wallets) {
    const cached = readCached(cache, w);
    if (cached) hits.set(w, cached);
    else misses.push(w);
  }
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

  const span = cache.tradeIndexSpan();
  if (increments.size && span && span.tip > span.floor) {
    await profilesFromIndex(rpc, cache, [...increments.keys()], excludeToken, rate, out, increments);
  }
  if (misses.length && span && span.tip > span.floor) {
    await profilesFromIndex(rpc, cache, misses, excludeToken, rate, out);
  } else if (misses.length) {
    await profilesFromRpc(rpc, cache, misses, deadline, excludeToken, rate, out);
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
  const { syncTradeIndexTail } = await import("./indexer.ts");
  try {
    await syncTradeIndexTail(rpc.client, cache, "curve");
    await syncTradeIndexTail(rpc.client, cache, "v4");
  } catch (err) {
    console.warn(`trade index tail sync: ${err instanceof Error ? err.message : err}`);
  }
  const floorNow = currentFloor(cache, "curve");
  const floorV4Now = currentFloor(cache, "v4");
  const tipNow = cache.tradeIndexSpan("curve")?.tip ?? 0n;
  const lower = misses.map((w) => w.toLowerCase());
  // wallets with a prior ledger read only trades past their synced block;
  // fresh wallets read everything (once)
  const rowsByWallet = new Map<string, ReturnType<Cache["chainTradesFor"]> extends Map<string, infer R> ? R : never>();
  const fresh: string[] = [];
  for (const w of misses) {
    const lw = w.toLowerCase();
    const p = prior.get(w)?.ledger;
    if (p) {
      const rows = cache.chainTradesFor([lw], BigInt(p.syncedBlock)).get(lw);
      if (rows) rowsByWallet.set(lw, rows);
    } else fresh.push(lw);
  }
  for (const [lw, rows] of cache.chainTradesFor(fresh)) rowsByWallet.set(lw, rows);
  const curves = new Set<string>();
  const directTokens = new Set<string>();
  for (const rows of rowsByWallet.values()) {
    for (const r of rows) {
      if (r.token) directTokens.add(r.token);
      else if (r.curve) curves.add(r.curve);
    }
  }
  const tokenOf = await curveResolver(rpc, cache)([...curves]);
  // v4 rows name their token directly, but pair tokens (NVDA, SPCX, ...)
  // ride the same pools; only launched tokens count as positions
  const launched = cache.launchTokens([...directTokens]);
  const ethWei = await rpc.ethBalances(lower).catch(() => new Map<string, bigint>());
  for (const w of misses) {
    const lw = w.toLowerCase();
    const byToken = new Map<string, { wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string }[]>();
    for (const r of rowsByWallet.get(lw) ?? []) {
      const token = r.token ? (launched.has(r.token) ? r.token : undefined) : tokenOf.get(r.curve);
      if (!token) continue;
      const list = byToken.get(token) ?? [];
      list.push({ wallet: lw, kind: r.kind, tokens: r.tokens, eth: r.eth, block: r.block, tx: r.tx });
      byToken.set(token, list);
    }
    const before = prior.get(w)?.ledger ?? emptyLedger();
    const ledger = applyTrades(before, byToken, tipNow);
    const positions = ledgerPositions(ledger);
    const eth = ethWei.get(lw) ?? 0n;
    cache.saveProfile(
      w,
      JSON.stringify({
        positions,
        ethWei: eth.toString(),
        ledger,
        floor: floorNow.toString(),
        floorV4: floorV4Now.toString(),
        tip: tipNow.toString(),
        at: Date.now(),
      } satisfies CachedWallet),
    );
    out.set(w, profileFromPositions(w, positions, eth, excludeToken, rate));
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
      for (const w of chunk) {
        const byToken = byWallet.get(w.toLowerCase()) ?? new Map();
        const positions = buildPositions(byToken, ledgerRemaining(byToken));
        const eth = ethWei.get(w.toLowerCase()) ?? 0n;
        cache.saveProfile(
          w,
          JSON.stringify({ positions, ethWei: eth.toString(), floor: "0", floorV4: currentFloor(cache, "v4").toString() } satisfies CachedWallet),
        );
        out.set(w, profileFromPositions(w, positions, eth, excludeToken, rate));
      }
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
