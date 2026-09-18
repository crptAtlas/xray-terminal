import type { Cache } from "../cache.ts";
import type { RpcProvider } from "../providers/rpc.ts";
import { buildPositions, profileFromPositions, type PositionSummary, type Profile } from "../profile/profile.ts";
import { ethUsd } from "../usd.ts";

/**
 * Wallet profiles through the global 24h cache, built from the public RPC:
 * the curve events index the real trader in their topics, so a batch of
 * wallets costs two topic-filtered getLogs over the whole chain - full
 * history, no indexer, no paid API. Post-graduation v4 swaps carry no
 * trader topic and are not part of the profile (the curve is where meme
 * life happens; noted in docs/DATA.md).
 *
 * The cache stores per-token position summaries plus the ETH balance, so
 * a profile can be folded with any token excluded (the token being
 * scanned never feeds its own holders' shown stats). remainingOf comes
 * from the wallet's own trade ledger (buys minus sells).
 */

interface CachedWallet {
  positions: PositionSummary[];
  ethWei: string;
  // trade-index floor at capture time: while the backfill deepens the
  // index, profiles captured at a shallower floor are stale and rebuilt
  floor: string;
}

function currentFloor(cache: Cache): bigint {
  return cache.tradeIndexSpan()?.floor ?? 0n;
}

function readCached(cache: Cache, wallet: string): CachedWallet | null {
  const raw = cache.freshProfile(wallet);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedWallet>;
    if (!Array.isArray(parsed.positions) || typeof parsed.ethWei !== "string") return null; // old format
    if (typeof parsed.floor !== "string") return null; // pre-floor format
    if (BigInt(parsed.floor) > currentFloor(cache)) return null; // the index got deeper since
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
  // a direct topic query reads the whole chain: floor 0
  cache.saveProfile(w, JSON.stringify({ positions, ethWei: eth.toString(), floor: "0" } satisfies CachedWallet));
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
  for (const w of wallets) {
    const cached = readCached(cache, w);
    if (cached) out.set(w, profileFromPositions(w, cached.positions, BigInt(cached.ethWei), excludeToken, rate));
    else misses.push(w);
  }

  const span = cache.tradeIndexSpan();
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
): Promise<void> {
  const { syncTradeIndexTail } = await import("./indexer.ts");
  try {
    await syncTradeIndexTail(rpc.client, cache, "curve");
    await syncTradeIndexTail(rpc.client, cache, "v4");
  } catch (err) {
    console.warn(`trade index tail sync: ${err instanceof Error ? err.message : err}`);
  }
  const floorNow = currentFloor(cache);
  const lower = misses.map((w) => w.toLowerCase());
  const rowsByWallet = cache.chainTradesFor(lower);
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
    const positions = buildPositions(byToken, ledgerRemaining(byToken));
    const eth = ethWei.get(lw) ?? 0n;
    cache.saveProfile(w, JSON.stringify({ positions, ethWei: eth.toString(), floor: floorNow.toString() } satisfies CachedWallet));
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
        cache.saveProfile(w, JSON.stringify({ positions, ethWei: eth.toString(), floor: "0" } satisfies CachedWallet));
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
