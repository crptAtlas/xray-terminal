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
