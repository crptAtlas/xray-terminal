import { ADDR, DUST_USD, INFRA, type Hex } from "../chain.ts";
import type { Cache } from "../cache.ts";
import { classify, type Trade, type TransferIn } from "../pnl/classify.ts";
import { position, type Position } from "../pnl/position.ts";
import type { Provider, TokenMeta } from "../providers/provider.ts";
import { ethUsd } from "../usd.ts";
import type { StageReporter } from "../stages.ts";

/**
 * Builds the full holder snapshot for one token: incremental trade sync
 * through the cache, classification, balances, per-wallet positions and the
 * spec 3.2 filters (infra, dust, unknown basis).
 */

export interface HolderRow {
  wallet: string;
  position: Position;
  supplyShare: number; // 0..1 of circulating (non-market) supply
}

export interface TokenSnapshot {
  meta: TokenMeta;
  holders: HolderRow[]; // pnl-ranked, filters applied
  holdersTotal: number; // nonzero balances before the dust filter (header)
  excluded: {
    dust: number;
    unknownBasis: { wallets: number; supplyShare: number };
    infra: number;
  };
  trades: Trade[]; // all classified trades (volume, exited stats)
  syncedBlock: bigint;
  priceEth: number;
  usdRate: number;
}

export function marketSet(meta: TokenMeta): Set<string> {
  const m = new Set<string>([meta.curve, ADDR.router, ADDR.hook, ADDR.poolManager, ADDR.locker]);
  return m;
}

export function infraSet(meta: TokenMeta): Set<string> {
  return new Set<string>([
    ...INFRA,
    meta.curve,
    meta.deployer,
    meta.creatorFeeRecipient,
  ]);
}

export async function tokenSnapshot(
  provider: Provider,
  cache: Cache,
  address: Hex,
  onStage: StageReporter = () => {},
): Promise<TokenSnapshot> {
  onStage({ agent: "scanner", status: "start" });
  const known = cache.tokenState(address.toLowerCase());
  const meta = await provider.tokenMeta(address, known?.createdBlock ? { createdBlock: known.createdBlock } : undefined);

  // incremental sync: cached trades + only the new blocks
  const state = cache.tokenState(meta.address);
  const fromBlock = state ? state.syncedBlock + 1n : meta.createdBlock;
  const activity = await provider.activity(meta, fromBlock);
  const market = marketSet(meta);
  const fresh = classify(activity.transfers, activity.quotes, market);
  cache.appendTrades(meta.address, fresh.trades);
  cache.appendTransfersIn(meta.address, fresh.transfersIn);
  cache.saveToken(meta, activity.toBlock);

  const trades = state ? cache.loadTrades(meta.address) : fresh.trades;
  const transfersIn = state ? cache.loadTransfersIn(meta.address) : fresh.transfersIn;
  onStage({ agent: "scanner", status: "done", detail: `${trades.length} trades` });
  onStage({ agent: "ledger", status: "start" });

  // candidate wallets: anyone who ever traded or received tokens
  const wallets = new Set<string>();
  for (const t of trades) wallets.add(t.wallet);
  for (const t of transfersIn) wallets.add(t.wallet);

  const infra = infraSet(meta);
  const candidates = [...wallets].filter((w) => !infra.has(w));
  const infraCount = wallets.size - candidates.length;

  const [balances, priceEth, usdRate] = await Promise.all([
    provider.balances(meta, candidates),
    provider.priceNowEth(meta),
    ethUsd(),
  ]);

  const tradesByWallet = new Map<string, Trade[]>();
  for (const t of trades) {
    const list = tradesByWallet.get(t.wallet) ?? [];
    list.push(t);
    tradesByWallet.set(t.wallet, list);
  }
  const tinByWallet = new Map<string, bigint>();
  for (const t of transfersIn) {
    tinByWallet.set(t.wallet, (tinByWallet.get(t.wallet) ?? 0n) + t.tokens);
  }

  const one = 10n ** BigInt(meta.decimals);
  const supplyFloat = Number(meta.totalSupply) / Number(one);
  const dustTokens = priceEth > 0 ? (DUST_USD / usdRate / priceEth) : Infinity;

  onStage({ agent: "ledger", status: "done", detail: `${candidates.length} wallets` });
  onStage({ agent: "flagger", status: "start" });
  const holders: HolderRow[] = [];
  let dust = 0;
  let ubWallets = 0;
  let ubSupply = 0;
  let holdersTotal = 0;

  for (const w of candidates) {
    const bal = balances.get(w) ?? 0n;
    if (bal > 0n) holdersTotal++;
    const pos = position(tradesByWallet.get(w) ?? [], tinByWallet.get(w) ?? 0n, bal, priceEth, meta.decimals);
    const balFloat = Number(bal) / Number(one);
    const share = supplyFloat > 0 ? balFloat / supplyFloat : 0;

    if (pos.unknownBasis) {
      if (bal > 0n) {
        ubWallets++;
        ubSupply += share;
      }
      continue;
    }
    // dust: remaining balance worth less than $50; fully exited wallets
    // (balance zero) stay - their realized pnl is part of the story
    if (bal > 0n && balFloat < dustTokens) {
      dust++;
      continue;
    }
    if (bal === 0n && pos.boughtTokens === 0n) continue; // never really in
    holders.push({ wallet: w, position: pos, supplyShare: share });
  }

  onStage({
    agent: "flagger",
    status: "done",
    detail: `dust ${dust}, unknown basis ${ubWallets}`,
  });
  // "top holders" means by supply held
  holders.sort((a, b) => b.supplyShare - a.supplyShare);

  return {
    meta,
    holders,
    holdersTotal,
    excluded: { dust, unknownBasis: { wallets: ubWallets, supplyShare: ubSupply }, infra: infraCount },
    trades,
    syncedBlock: activity.toBlock,
    priceEth,
    usdRate,
  };
}
