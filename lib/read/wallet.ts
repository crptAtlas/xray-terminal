import type { Cache } from "../cache.ts";
import type { BitqueryProvider } from "../providers/bitquery.ts";
import { buildProfile, type Profile } from "../profile/profile.ts";

/**
 * Wallet profile through the global 24h cache. remainingOf comes from the
 * wallet's own trade ledger (buys minus sells), which is what the cube can
 * answer without one balance query per token.
 */

export async function walletProfile(
  provider: BitqueryProvider,
  cache: Cache,
  wallet: string,
): Promise<Profile> {
  const cached = cache.freshProfile(wallet);
  if (cached) return JSON.parse(cached) as Profile;

  const [byToken, ethWei] = await Promise.all([
    provider.walletTrades(wallet),
    provider.walletEthWei(wallet),
  ]);

  const remainingOf = (token: string): bigint => {
    let bal = 0n;
    for (const t of byToken.get(token) ?? []) {
      bal += t.kind === "buy" ? t.tokens : -t.tokens;
    }
    return bal > 0n ? bal : 0n;
  };

  const profile = buildProfile(wallet, byToken, remainingOf, ethWei);
  cache.saveProfile(wallet, JSON.stringify(profile));
  return profile;
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
): Promise<Map<string, Profile>> {
  const out = new Map<string, Profile>();
  const deadline = Date.now() + deadlineMs;
  const misses: string[] = [];
  for (const w of wallets) {
    const cached = cache.freshProfile(w);
    if (cached) out.set(w, JSON.parse(cached) as Profile);
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
        const remainingOf = (token: string): bigint => {
          let bal = 0n;
          for (const t of byToken.get(token) ?? []) bal += t.kind === "buy" ? t.tokens : -t.tokens;
          return bal > 0n ? bal : 0n;
        };
        const profile = buildProfile(w, byToken, remainingOf, ethWei.get(w.toLowerCase()) ?? 0n);
        cache.saveProfile(w, JSON.stringify(profile));
        out.set(w, profile);
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
