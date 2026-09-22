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

  // Fast path: the chain-wide index already holds every trade of this
  // token, so the scan reads them locally instead of pulling the token's
  // whole log history from the node again. It applies when both lanes
  // cover the token's lifetime; otherwise the node path below runs.
  const curveSpan = cache.tradeIndexSpan("curve");
  const v4Span = cache.tradeIndexSpan("v4");
  const indexCovers =
    !process.env.XRAY_NO_INDEX_SCAN &&
    !!curveSpan &&
    !!v4Span &&
    curveSpan.floor <= meta.createdBlock &&
    v4Span.floor <= meta.createdBlock &&
    curveSpan.tip > meta.createdBlock;

  let trades: Trade[];
  let transfersIn: TransferIn[];
  let syncedBlock: bigint;
  if (indexCovers) {
    trades = cache.tokenTradesFromIndex(meta.address, meta.curve);
    // transfers between wallets are not indexed; a wallet holding more
    // than it bought is caught by the position math anyway
    transfersIn = [];
    syncedBlock = curveSpan!.tip < v4Span!.tip ? curveSpan!.tip : v4Span!.tip;
    onStage({ agent: "scanner", status: "done", detail: `${trades.length} trades (index)` });
  } else {
    // incremental sync: cached trades + only the new blocks
    const state = cache.tokenState(meta.address);
    const fromBlock = state ? state.syncedBlock + 1n : meta.createdBlock;
    const activity = await provider.activity(meta, fromBlock);
    const market = marketSet(meta);
    const fresh = classify(activity.transfers, activity.quotes, market);
    cache.appendTrades(meta.address, fresh.trades);
    cache.appendTransfersIn(meta.address, fresh.transfersIn);
    cache.saveToken(meta, activity.toBlock);

    trades = state ? cache.loadTrades(meta.address) : fresh.trades;
    transfersIn = state ? cache.loadTransfersIn(meta.address) : fresh.transfersIn;
    syncedBlock = activity.toBlock;
    onStage({ agent: "scanner", status: "done", detail: `${trades.length} trades` });
  }
  onStage({ agent: "ledger", status: "start" });

  // candidate wallets: anyone who ever traded or received tokens
  const wallets = new Set<string>();
  for (const t of trades) wallets.add(t.wallet);
  for (const t of transfersIn) wallets.add(t.wallet);

  const infra = infraSet(meta);
  const candidates = [...wallets].filter((w) => !infra.has(w));
  const infraCount = wallets.size - candidates.length;

  // Recent trades in the index give the market price without hunting the
  // latest swap in the logs. One trade is not enough: a dust trade or a
  // rounding artifact would set the price for the whole token, so this
  // takes the median of the last twenty and falls back to the provider
  // when they say nothing sane.
  const recent = trades.slice(-20).filter((t) => t.tokens > 0n && t.eth > 0n);
  let indexPrice: number | null = null;
  if (indexCovers && recent.length >= 3) {
    const prices = recent.map((t) => Number(t.eth) / Number(t.tokens)).sort((a, b) => a - b);
    const mid = prices[Math.floor(prices.length / 2)]!;
    if (Number.isFinite(mid) && mid > 0) indexPrice = mid;
  }
  const [balances, priceFromProvider, usdRate] = await Promise.all([
    provider.balances(meta, candidates),
    indexPrice === null ? provider.priceNowEth(meta) : Promise.resolve(indexPrice),
    ethUsd(),
  ]);
  const priceEth = priceFromProvider;

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
    syncedBlock,
    priceEth,
    usdRate,
  };
}
