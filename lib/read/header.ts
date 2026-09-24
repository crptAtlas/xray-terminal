import { CHAIN } from "../chain.ts";
import type { Provider } from "../providers/provider.ts";
import type { TokenSnapshot } from "./token.ts";

/**
 * Token header (spec 3.7): mcap, liquidity (ETH side x2, in dollars),
 * 24h volume, holder count before the dust filter, age, phase.
 */

export interface Header {
  mcapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  holders: number;
  ageMs: number;
  phase: TokenSnapshot["meta"]["phase"];
}

export async function header(provider: Provider, snap: TokenSnapshot): Promise<Header> {
  const { meta, priceEth, usdRate } = snap;
  const one = 10n ** BigInt(meta.decimals);
  const supplyFloat = Number(meta.totalSupply) / Number(one);
  const mcapUsd = supplyFloat * priceEth * usdRate;

  const liqWei = await provider.liquidityEth(meta);
  const liquidityUsd = (Number(liqWei) / 1e18) * 2 * usdRate;

  const dayAgo = snap.syncedBlock > CHAIN.blocksPerDay ? snap.syncedBlock - CHAIN.blocksPerDay : 0n;
  let volWei = 0n;
  for (const t of snap.trades) {
    if (t.block >= dayAgo) volWei += t.eth;
  }
  const volume24hUsd = (Number(volWei) / 1e18) * usdRate;

  return {
    mcapUsd,
    liquidityUsd,
    volume24hUsd,
    holders: snap.holdersTotal,
    ageMs: Date.now() - meta.createdAt * 1000,
    phase: meta.phase,
  };
}

