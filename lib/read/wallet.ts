import type { Cache } from "../cache.ts";
import type { BitqueryProvider } from "../providers/bitquery.ts";
import { buildPositions, profileFromPositions, type PositionSummary, type Profile } from "../profile/profile.ts";
import { ethUsd } from "../usd.ts";

/**
 * Wallet profiles through the global 24h cache. The cache stores per-token
 * position summaries plus the ETH balance, so a profile can be folded with
 * any token excluded (the token being scanned never feeds its own holders'
 * profiles - see lib/profile/profile.ts). remainingOf comes from the
 * wallet's own trade ledger (buys minus sells).
 */

interface CachedWallet {
  positions: PositionSummary[];
  ethWei: string;
}

function readCached(cache: Cache, wallet: string): CachedWallet | null {
  const raw = cache.freshProfile(wallet);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedWallet>;
    if (!Array.isArray(parsed.positions) || typeof parsed.ethWei !== "string") return null; // old format
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

export async function walletProfile(
  provider: BitqueryProvider,
  cache: Cache,
  wallet: string,
  excludeToken?: string,
): Promise<Profile> {
  const rate = await ethUsd().catch(() => 0);
  const cached = readCached(cache, wallet);
  if (cached) return profileFromPositions(wallet, cached.positions, BigInt(cached.ethWei), excludeToken, rate);

  const [byToken, ethWei] = await Promise.all([
    provider.walletTrades(wallet),
    provider.walletEthWei(wallet),
  ]);
  const positions = buildPositions(byToken, ledgerRemaining(byToken));
  cache.saveProfile(wallet, JSON.stringify({ positions, ethWei: ethWei.toString() } satisfies CachedWallet));
  return profileFromPositions(wallet, positions, ethWei, excludeToken, rate);
}

/**
 * Profiles for many wallets, batched: cache hits first, then chunks of
 * 100 wallets - one transfer batch + quote chunks + one balance multicall
 * per chunk. The deadline is checked between chunks; wallets left over
 * come back notRead and fill in from the cache on later scans.
 */
export async function walletProfilesBatch(
  provider: BitqueryProvider,
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
  const CHUNK = 100;
  let failures = 0;
  for (let i = 0; i < misses.length; i += CHUNK) {
    if (Date.now() > deadline) break;
    if (failures >= 2) break; // the plan is rate-limited out - stop burning time, the cache fills in later
    const chunk = misses.slice(i, i + CHUNK);
    try {
      const [byWallet, ethWei] = await Promise.all([
        provider.walletTradesBatch(chunk),
        provider.ethBalances(chunk.map((w) => w.toLowerCase())),
      ]);
      failures = 0;
      for (const w of chunk) {
        const byToken = byWallet.get(w.toLowerCase()) ?? new Map();
        const positions = buildPositions(byToken, ledgerRemaining(byToken));
        const eth = ethWei.get(w.toLowerCase()) ?? 0n;
        cache.saveProfile(w, JSON.stringify({ positions, ethWei: eth.toString() } satisfies CachedWallet));
        out.set(w, profileFromPositions(w, positions, eth, excludeToken, rate));
      }
    } catch (err) {
      failures++;
      console.warn(`profile batch ${i / CHUNK}: ${err instanceof Error ? err.message : err}`);
    }
  }
  for (const w of wallets) {
    if (!out.has(w)) out.set(w, notRead(w));
  }
  return out;
}

export async function walletProfilesWithDeadline(
  provider: BitqueryProvider,
  cache: Cache,
  wallets: string[],
  deadlineMs: number,
  concurrency = 3,
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>();
  const queue = wallets.slice();
  const deadline = Date.now() + deadlineMs;

  async function worker(): Promise<void> {
    for (;;) {
      const w = queue.shift();
      if (!w) return;
      if (Date.now() > deadline) {
        out.set(w, notRead(w));
        continue;
      }
      try {
        out.set(w, await walletProfile(provider, cache, w));
      } catch (err) {
        console.warn(`profile ${w.slice(0, 10)}: ${err instanceof Error ? err.message : err}`);
        out.set(w, notRead(w));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
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
