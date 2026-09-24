import { ADDR, CHAIN, DUST_SUPPLY_SHARE, INFRA, type Hex } from "../chain.ts";
import type { Cache, MarketAggregate } from "../cache.ts";
import { classify, type Trade, type TransferIn } from "../pnl/classify.ts";
import { MIN_COST_WEI, position, type Position } from "../pnl/position.ts";
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
  /** why this holder sits out of the averages, when it does */
  excluded?: "dust" | "no basis";
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
  // The folded rows hold every trade that was ever indexed, so coverage
  // is asked of them rather than of the raw trades, which may be kept to
  // a rolling window.
  const foldFloor = cache.positionsFloor();
  const floor = foldFloor ?? { curve: curveSpan?.floor ?? 0n, v4: v4Span?.floor ?? 0n };
  const indexCovers =
    !process.env.XRAY_NO_INDEX_SCAN &&
    !!curveSpan &&
    !!v4Span &&
    floor.curve <= meta.createdBlock &&
    floor.v4 <= meta.createdBlock &&
    curveSpan.tip > meta.createdBlock;

  let trades: Trade[];
  let transfersIn: TransferIn[];
  let syncedBlock: bigint;
  // Every wallet's folded record of this token, when the fold covers the
  // index. A position is four sums, so reading the sums beats reading the
  // trades that make them: a busy token has a quarter of a million trades
  // and thirty thousand holders.
  let folded: Map<string, MarketAggregate> | null = null;
  if (indexCovers) {
    syncedBlock = curveSpan!.tip < v4Span!.tip ? curveSpan!.tip : v4Span!.tip;
    if (cache.positionsReady()) {
      folded = cache.marketPositions(meta.address, meta.curve);
      // the last day trade by trade: that window is what the 24h volume
      // and the market price are read from
      const dayAgo = syncedBlock > CHAIN.blocksPerDay ? syncedBlock - CHAIN.blocksPerDay : 0n;
      trades = cache.tokenTradesFromIndex(meta.address, meta.curve, dayAgo);
      onStage({ agent: "scanner", status: "done", detail: `${folded.size} holders (folded)` });
    } else {
      trades = cache.tokenTradesFromIndex(meta.address, meta.curve);
      onStage({ agent: "scanner", status: "done", detail: `${trades.length} trades (index)` });
    }
    // transfers between wallets are not indexed; a wallet holding more
    // than it bought is caught by the position math anyway
    transfersIn = [];
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
  if (folded) for (const w of folded.keys()) wallets.add(w);
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

  // A position is the sum of what a wallet bought and what it sold, so a
  // folded record stands in for the trades exactly: one buy and one sell
  // carrying the sums. The window of recent trades is already inside
  // them and must not be added twice.
  const tradesByWallet = new Map<string, Trade[]>();
  if (folded) {
    for (const [w, a] of folded) {
      const list: Trade[] = [];
      const at = BigInt(a.lastBlock);
      if (a.buyTokens > 0 || a.buyEth > 0) {
        list.push({ wallet: w, kind: "buy", tokens: BigInt(Math.round(a.buyTokens)), eth: BigInt(Math.round(a.buyEth)), block: at, tx: "" });
      }
      if (a.sellTokens > 0 || a.sellEth > 0) {
        list.push({ wallet: w, kind: "sell", tokens: BigInt(Math.round(a.sellTokens)), eth: BigInt(Math.round(a.sellEth)), block: at, tx: "" });
      }
      tradesByWallet.set(w, list);
    }
  } else {
    for (const t of trades) {
      const list = tradesByWallet.get(t.wallet) ?? [];
      list.push(t);
      tradesByWallet.set(t.wallet, list);
    }
  }
  const tinByWallet = new Map<string, bigint>();
  for (const t of transfersIn) {
    tinByWallet.set(t.wallet, (tinByWallet.get(t.wallet) ?? 0n) + t.tokens);
  }

  const one = 10n ** BigInt(meta.decimals);
  const supplyFloat = Number(meta.totalSupply) / Number(one);
  // quote amounts are in the pair's units, so the floor below which a
  // cost basis means nothing has to be in those units too
  const pairDec = meta.pairDecimals ?? 18;
  const minCost = pairDec >= 18 ? MIN_COST_WEI * 10n ** BigInt(pairDec - 18) : MIN_COST_WEI / 10n ** BigInt(18 - pairDec);
  // the dust line is a share of the float, so it does not move when the
  // price does (see DUST_SUPPLY_SHARE)
  const dustTokens = supplyFloat * DUST_SUPPLY_SHARE;

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
    const pos = position(tradesByWallet.get(w) ?? [], tinByWallet.get(w) ?? 0n, bal, priceEth, meta.decimals, minCost);
    const balFloat = Number(bal) / Number(one);
    const share = supplyFloat > 0 ? balFloat / supplyFloat : 0;

    // A holder is never dropped from the list, only marked: the averages
    // and the bands read the clean rows, the table shows everyone who
    // holds the token. Hiding them made a token with four hundred and
    // fifty holders show forty.
    let excluded: HolderRow["excluded"];
    if (pos.unknownBasis) {
      excluded = "no basis";
      if (bal > 0n) {
        ubWallets++;
        ubSupply += share;
      }
    } else if (bal > 0n && balFloat < dustTokens) {
      // too small a share of the float to be a holder; fully exited
      // wallets (balance zero) stay - their realized pnl is the story
      excluded = "dust";
      dust++;
    } else if (bal === 0n && pos.boughtTokens === 0n) {
      continue; // never really in
    }
    holders.push({ wallet: w, position: pos, supplyShare: share, excluded });
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

