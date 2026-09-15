/**
 * ETH/USD spot rate. The chain has no reliable USD oracle, so dollar figures
 * (dust filter, mcap, liquidity, volume) use one keyless GET to a public
 * spot API, cached in memory for 5 minutes. The ETH_USD env var overrides it
 * entirely — that is also the offline/demo path. This is the only external
 * call besides the chain RPC.
 */

const CACHE_MS = 5 * 60 * 1000;
const SPOT_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

let cached: { rate: number; at: number } | null = null;

export async function ethUsd(fetchImpl: typeof fetch = fetch): Promise<number> {
  const env = process.env.ETH_USD;
  if (env) {
    const n = Number(env);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.rate;
  try {
    const res = await fetchImpl(SPOT_URL);
    if (!res.ok) throw new Error(`http ${res.status}`);
    const body = (await res.json()) as { data?: { amount?: string } };
    const rate = Number(body.data?.amount);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("bad spot payload");
    cached = { rate, at: Date.now() };
    return rate;
  } catch (err) {
    if (cached) return cached.rate; // stale beats nothing
    throw new Error(
      `cannot fetch ETH/USD spot (${err instanceof Error ? err.message : err}); set ETH_USD to override`,
    );
  }
}
