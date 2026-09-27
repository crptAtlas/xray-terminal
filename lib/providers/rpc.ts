import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  keccak256,
  parseAbiParameters,
  toEventSelector,
  type PublicClient,
} from "viem";
import { ADDR, CHAIN, TOPIC, ZERO, type Hex } from "../chain.ts";
import { erc20Abi } from "../abi/erc20.ts";
import { parseAbi } from "viem";
import { curveAbi, factoryAbi, PHASE } from "../abi/pons.ts";
import { poolManagerAbi, SWAP_TOPIC } from "../abi/pool.ts";
import { makeTransport, rpcStats } from "./gate.ts";
import { getLogsAdaptive, type RawLog } from "./logs.ts";
import type { Provider, QuoteEvent, RawTransfer, TokenActivity, TokenMeta } from "./provider.ts";
import type { Trade } from "../pnl/classify.ts";

const chainDef = {
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [] as string[] } },
  contracts: { multicall3: { address: ADDR.multicall3 as Hex } },
} as const;

export function makeClient(): PublicClient {
  return createPublicClient({ chain: chainDef, transport: makeTransport() });
}

const tokenLaunchedTopic = toEventSelector(
  "TokenLaunched(address,address,address,address,uint256,uint256)",
);

function topicAddress(topic: Hex): string {
  return ("0x" + topic.slice(26)).toLowerCase();
}

/** v4 pool id for the token's pool: keccak of the sorted PoolKey. */
export function poolIdFor(token: Hex, pairToken: Hex, fee: number, tickSpacing: number): Hex {
  // v4 native ETH pools use address(0) as the currency; pairToken comes from
  // the factory as-is. Currencies sort ascending.
  const a = token.toLowerCase();
  const b = pairToken.toLowerCase();
  const [c0, c1] = a < b ? [a, b] : [b, a];
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      c0 as Hex,
      c1 as Hex,
      fee,
      tickSpacing,
      ADDR.hook as Hex,
    ]),
  );
}

interface Launched {
  curve: Hex;
  deployer: Hex;
  creatorFeeRecipient: Hex;
  pairToken: Hex;
  poolFee: number;
  tickSpacing: number;
  phase: number;
}

export class RpcProvider implements Provider {
  readonly name = "rpc" as const;
  // wallet histories come straight off the chain: the curve events index
  // the real trader in their topics, so one topic-filtered getLogs over
  // the whole chain returns a wallet's every curve trade in ~a second
  readonly supportsProfiles = true;
  readonly client: PublicClient;

  constructor(client?: PublicClient) {
    this.client = client ?? makeClient();
  }

  async tokenMeta(address: Hex, hint?: { createdBlock?: bigint }): Promise<TokenMeta> {
    const addr = address.toLowerCase() as Hex;
    const launchedRaw = (await this.client.readContract({
      address: ADDR.factory as Hex,
      abi: factoryAbi,
      functionName: "getLaunchedToken",
      args: [addr],
    })) as Record<string, unknown>;
    if (!launchedRaw.exists) throw new Error(`not a Pons V2 launch: ${address}`);
    const launched: Launched = {
      curve: (launchedRaw.curve as string).toLowerCase() as Hex,
      deployer: (launchedRaw.deployer as string).toLowerCase() as Hex,
      creatorFeeRecipient: (launchedRaw.creatorFeeRecipient as string).toLowerCase() as Hex,
      pairToken: (launchedRaw.pairToken as string).toLowerCase() as Hex,
      poolFee: Number(launchedRaw.poolFee),
      tickSpacing: Number(launchedRaw.tickSpacing),
      phase: Number(launchedRaw.phase),
    };

    // one multicall instead of five round trips
    const [symbol, name, decimals, totalSupply, launchedAt] = (await this.client.multicall({
      contracts: [
        { address: addr, abi: erc20Abi, functionName: "symbol" },
        { address: addr, abi: erc20Abi, functionName: "name" },
        { address: addr, abi: erc20Abi, functionName: "decimals" },
        { address: addr, abi: erc20Abi, functionName: "totalSupply" },
        { address: launched.curve, abi: curveAbi, functionName: "launchedAt" },
      ],
      allowFailure: false,
      batchSize: 20_000,
    })) as [string, string, number, bigint, bigint];

    let phase: TokenMeta["phase"];
    if (launched.phase === PHASE.curve) {
      const [real, threshold] = (await this.client.multicall({
        contracts: [
          { address: launched.curve, abi: curveAbi, functionName: "realQuoteReserve" },
          { address: launched.curve, abi: curveAbi, functionName: "graduationThreshold" },
        ],
        allowFailure: false,
      })) as [bigint, bigint];
      const fillPct = threshold === 0n ? 0 : Number((real * 10_000n) / threshold) / 100;
      phase = { kind: "curve", fillPct: Math.min(fillPct, 100) };
    } else {
      phase = { kind: "graduated" };
    }

    const createdBlock = hint?.createdBlock ?? (await this.findLaunchBlock(addr));

    const ethPaired = launched.pairToken === ZERO || launched.pairToken === ADDR.weth;
    let pairSymbol: string | null = null;
    // the pair's own decimals: quote amounts are denominated in it, and
    // a stablecoin or a wrapped coin is rarely eighteen decimals
    let pairDecimals: number | null = null;
    if (!ethPaired) {
      const [sym, dec] = await Promise.all([
        this.client
          .readContract({ address: launched.pairToken, abi: erc20Abi, functionName: "symbol" })
          .catch(() => "?" as string),
        this.client
          .readContract({ address: launched.pairToken, abi: erc20Abi, functionName: "decimals" })
          .catch(() => 18),
      ]);
      pairSymbol = sym as string;
      pairDecimals = Number(dec);
    }

    return {
      address: addr,
      symbol: symbol as string,
      name: name as string,
      decimals: Number(decimals),
      totalSupply: totalSupply as bigint,
      curve: launched.curve,
      pool:
        phase.kind === "graduated"
          ? poolIdFor(addr, launched.pairToken, launched.poolFee, launched.tickSpacing)
          : undefined,
      deployer: launched.deployer,
      creatorFeeRecipient: launched.creatorFeeRecipient,
      createdBlock,
      createdAt: Number(launchedAt),
      phase,
      pairToken: launched.pairToken,
      pairSymbol,
      pairDecimals,
    };
  }

  private async findLaunchBlock(token: Hex): Promise<bigint> {
    const latest = await this.client.getBlockNumber();
    const logs = await getLogsAdaptive(this.client, {
      address: ADDR.factory as Hex,
      topics: [tokenLaunchedTopic, `0x000000000000000000000000${token.slice(2)}` as Hex],
      fromBlock: 0n,
      toBlock: latest,
    }, { parallel: 1 });
    const first = logs[0];
    if (!first) throw new Error(`launch event not found for ${token}`);
    return first.blockNumber;
  }

  async activity(token: TokenMeta, fromBlock: bigint): Promise<TokenActivity> {
    const toBlock = await this.client.getBlockNumber();
    if (fromBlock > toBlock) return { transfers: [], quotes: [], toBlock };

    const [transferLogs, curveLogs, swapLogs] = await Promise.all([
      getLogsAdaptive(this.client, {
        address: token.address,
        topics: [TOPIC.transfer as Hex],
        fromBlock,
        toBlock,
      }),
      getLogsAdaptive(this.client, {
        address: token.curve,
        topics: [[TOPIC.curveBuy as Hex, TOPIC.curveSell as Hex]],
        fromBlock,
        toBlock,
      }),
      token.pool
        ? getLogsAdaptive(this.client, {
            address: ADDR.poolManager as Hex,
            topics: [SWAP_TOPIC as Hex, token.pool],
            fromBlock,
            toBlock,
          })
        : Promise.resolve([] as RawLog[]),
    ]);

    const transfers: RawTransfer[] = transferLogs.map((l) => ({
      from: topicAddress(l.topics[1] as Hex),
      to: topicAddress(l.topics[2] as Hex),
      tokens: BigInt(l.data === "0x" ? 0 : l.data),
      block: l.blockNumber,
      tx: l.transactionHash,
      logIndex: l.logIndex,
    }));

    const quotes: QuoteEvent[] = [];
    for (const l of curveLogs) {
      const decoded = decodeEventLog({ abi: curveAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (decoded.eventName === "CurveBuy") {
        // spec 3.1: fees and the opening tax are not part of cost basis -
        // quoteIn includes them, so strip them to the clean swap amount
        // (this also matches what the trade cubes report)
        const a = decoded.args as { quoteIn: bigint; tokensOut: bigint; fee: bigint; tax: bigint };
        const eth = a.quoteIn - a.fee - a.tax;
        quotes.push({ tx: l.transactionHash, kind: "curveBuy", eth: eth > 0n ? eth : a.quoteIn, tokens: a.tokensOut });
      } else {
        const a = decoded.args as { tokensIn: bigint; quoteOut: bigint };
        quotes.push({ tx: l.transactionHash, kind: "curveSell", eth: a.quoteOut, tokens: a.tokensIn });
      }
    }
    for (const l of swapLogs) {
      const decoded = decodeEventLog({ abi: poolManagerAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      const a = decoded.args as { amount0: bigint; amount1: bigint };
      // The token is one currency, the quote the other (native ETH pools
      // use address(0), stock pairs the pair token). Sort order decides
      // which side is which; classify matches by token amount.
      const tokenIsC0 = token.address.toLowerCase() < token.pairToken;
      const tokenAmt = tokenIsC0 ? a.amount0 : a.amount1;
      const ethAmt = tokenIsC0 ? a.amount1 : a.amount0;
      quotes.push({
        tx: l.transactionHash,
        kind: "swap",
        eth: ethAmt < 0n ? -ethAmt : ethAmt,
        tokens: tokenAmt < 0n ? -tokenAmt : tokenAmt,
      });
    }

    return { transfers, quotes, toBlock };
  }

  /** Native ETH balances for many wallets in a few multicalls. */
  async ethBalances(wallets: string[]): Promise<Map<string, bigint>> {
    const abi = parseAbi(["function getEthBalance(address addr) view returns (uint256)"]);
    const out = new Map<string, bigint>();
    const chunk = 1000;
    for (let i = 0; i < wallets.length; i += chunk) {
      const slice = wallets.slice(i, i + chunk);
      const res = await this.client.multicall({
        contracts: slice.map((w) => ({
          address: ADDR.multicall3 as Hex,
          abi,
          functionName: "getEthBalance" as const,
          args: [w as Hex],
        })),
        allowFailure: true,
        batchSize: 80_000,
      });
      res.forEach((r, j) => {
        out.set(slice[j] as string, r.status === "success" ? (r.result as bigint) : 0n);
      });
    }
    return out;
  }

  async balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    // One multicall per chunk, with viem's calldata chunking raised to
    // fit the whole chunk in one request. A thousand balances per request
    // is what this node answers in one piece: measured against the same
    // wallets read in chunks of 250, same answers, a quarter of the
    // requests. Larger chunks are where a node starts failing the call
    // silently, and allowFailure would read that as every wallet holding
    // nothing.
    const chunk = 1000;
    for (let i = 0; i < wallets.length; i += chunk) {
      const slice = wallets.slice(i, i + chunk);
      const res = await this.client.multicall({
        contracts: slice.map((w) => ({
          address: token.address,
          abi: erc20Abi,
          functionName: "balanceOf" as const,
          args: [w as Hex],
        })),
        allowFailure: true,
        batchSize: 80_000,
      });
      res.forEach((r, j) => {
        out.set(slice[j] as string, r.status === "success" ? (r.result as bigint) : 0n);
      });
    }
    return out;
  }

  // The latest pool swap, found by scanning backwards in widening windows
  // and memoized per token per provider instance: priceNowEth and
  // liquidityEth both need it and a day-wide scan for it was the single
  // biggest request sink on graduated tokens.
  private lastSwapMemo = new Map<string, Promise<{ sqrtPriceX96: bigint; liquidity: bigint } | null>>();

  private lastSwap(token: TokenMeta): Promise<{ sqrtPriceX96: bigint; liquidity: bigint } | null> {
    const memo = this.lastSwapMemo.get(token.address);
    if (memo) return memo;
    const p = (async () => {
      if (!token.pool) return null;
      const toBlock = await this.client.getBlockNumber();
      // one recent window: a token with no swap in it has no live price
      // worth quoting, and the escalating hunt cost dozens of requests
      for (const span of [40_000n]) {
        const fromBlock = toBlock > span ? toBlock - span : 0n;
        const swaps = await getLogsAdaptive(this.client, {
          address: ADDR.poolManager as Hex,
          topics: [SWAP_TOPIC as Hex, token.pool],
          fromBlock,
          toBlock,
        }, { parallel: 2 });
        const last = swaps[swaps.length - 1];
        if (last) {
          const decoded = decodeEventLog({ abi: poolManagerAbi, topics: last.topics as [Hex, ...Hex[]], data: last.data });
          return decoded.args as { sqrtPriceX96: bigint; liquidity: bigint };
        }
        if (fromBlock === 0n) break;
      }
      return null;
    })();
    this.lastSwapMemo.set(token.address, p);
    return p;
  }

  async priceNowEth(token: TokenMeta): Promise<number> {
    if (token.phase.kind === "curve") {
      const [quoteReserve, tokenReserve] = (await this.client.readContract({
        address: token.curve,
        abi: curveAbi,
        functionName: "getReserves",
      })) as readonly [bigint, bigint];
      if (tokenReserve === 0n) return 0;
      return Number(quoteReserve) / Number(tokenReserve);
    }
    const last = await this.lastSwap(token);
    if (!last) return 0;
    // price(c1 per c0) = (sqrtP / 2^96)^2; convert to ETH per token.
    const ratio = Number(last.sqrtPriceX96) / 2 ** 96;
    const p = ratio * ratio;
    const tokenIsC0 = token.address.toLowerCase() < token.pairToken;
    return tokenIsC0 ? p : 1 / p;
  }

  async liquidityEth(token: TokenMeta): Promise<bigint> {
    if (token.phase.kind === "curve") {
      return (await this.client.readContract({
        address: token.curve,
        abi: curveAbi,
        functionName: "realQuoteReserve",
      })) as bigint;
    }
    // Graduated: the locker holds one full-range position; approximate the
    // ETH side as L * sqrtP / 2^96 from the latest swap.
    const last = await this.lastSwap(token);
    if (!last) return 0n;
    const tokenIsC0 = token.address.toLowerCase() < token.pairToken;
    if (tokenIsC0) {
      return (last.liquidity * last.sqrtPriceX96) / 2n ** 96n;
    }
    return (last.liquidity * 2n ** 96n) / last.sqrtPriceX96;
  }

  /**
   * Every curve trade of the given wallets across the whole chain, full
   * history, grouped wallet -> token -> trades. Two topic-filtered
   * getLogs calls per batch (buys by recipient, sells by seller); curve
   * addresses resolve to tokens through the launch index plus a batched
   * factory-event lookup for curves the index has not seen yet.
   * Post-graduation v4 swaps carry no trader topic and are not included.
   */
  async walletTradesBatch(
    wallets: string[],
    curveToToken: (curves: string[]) => Promise<Map<string, string>>,
  ): Promise<Map<string, Map<string, Trade[]>>> {
    const latest = await this.client.getBlockNumber();
    const padded = wallets.map((w) => `0x000000000000000000000000${w.slice(2).toLowerCase()}` as Hex);
    const [buyLogs, sellLogs] = await Promise.all([
      // CurveBuy(buyer indexed, recipient indexed, ...): recipient = topic2
      getLogsAdaptive(this.client, { topics: [TOPIC.curveBuy as Hex, null, padded], fromBlock: 0n, toBlock: latest }, { parallel: 2, maxDepth: 3 }),
      // CurveSell(seller indexed, recipient indexed, ...): seller = topic1
      getLogsAdaptive(this.client, { topics: [TOPIC.curveSell as Hex, padded], fromBlock: 0n, toBlock: latest }, { parallel: 2, maxDepth: 3 }),
    ]);
    const curves = [...new Set([...buyLogs, ...sellLogs].map((l) => l.address))];
    const tokenOf = await curveToToken(curves);
    const out = new Map<string, Map<string, Trade[]>>();
    for (const w of wallets) out.set(w.toLowerCase(), new Map());
    const push = (wallet: string, token: string, trade: Trade) => {
      const byToken = out.get(wallet);
      if (!byToken) return;
      const list = byToken.get(token) ?? [];
      list.push(trade);
      byToken.set(token, list);
    };
    for (const l of buyLogs) {
      const token = tokenOf.get(l.address);
      if (!token) continue;
      const decoded = decodeEventLog({ abi: curveAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (decoded.eventName !== "CurveBuy") continue;
      const a = decoded.args as { recipient: Hex; quoteIn: bigint; tokensOut: bigint; fee: bigint; tax: bigint };
      const eth = a.quoteIn - a.fee - a.tax;
      push(a.recipient.toLowerCase(), token, {
        wallet: a.recipient.toLowerCase(),
        kind: "buy",
        tokens: a.tokensOut,
        eth: eth > 0n ? eth : a.quoteIn,
        block: l.blockNumber,
        tx: l.transactionHash,
      });
    }
    for (const l of sellLogs) {
      const token = tokenOf.get(l.address);
      if (!token) continue;
      const decoded = decodeEventLog({ abi: curveAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      if (decoded.eventName !== "CurveSell") continue;
      const a = decoded.args as { seller: Hex; tokensIn: bigint; quoteOut: bigint };
      push(a.seller.toLowerCase(), token, {
        wallet: a.seller.toLowerCase(),
        kind: "sell",
        tokens: a.tokensIn,
        eth: a.quoteOut,
        block: l.blockNumber,
        tx: l.transactionHash,
      });
    }
    // trades in block order per token
    for (const byToken of out.values()) {
      for (const list of byToken.values()) list.sort((x, y) => (x.block < y.block ? -1 : x.block > y.block ? 1 : 0));
    }
    return out;
  }

  /** Resolve curve addresses to their tokens via batched factory events. */
  async curvesToTokens(curves: string[]): Promise<Map<string, string>> {
    if (curves.length === 0) return new Map();
    const latest = await this.client.getBlockNumber();
    const out = new Map<string, string>();
    const chunk = 200;
    for (let i = 0; i < curves.length; i += chunk) {
      const slice = curves.slice(i, i + chunk).map((c) => `0x000000000000000000000000${c.slice(2).toLowerCase()}` as Hex);
      // TokenLaunched(token indexed, curve indexed, ...): curve = topic2
      const logs = await getLogsAdaptive(this.client, {
        address: ADDR.factory as Hex,
        topics: [tokenLaunchedTopic, null, slice],
        fromBlock: 0n,
        toBlock: latest,
      }, { parallel: 1 });
      for (const l of logs) {
        out.set(("0x" + (l.topics[2] as string).slice(26)).toLowerCase(), ("0x" + (l.topics[1] as string).slice(26)).toLowerCase());
      }
    }
    return out;
  }

  stats(): { label: string; requests: number } {
    return { label: "rpc", requests: rpcStats().requests };
  }
}

export async function pickProvider(flag?: "rpc" | "bitquery"): Promise<Provider> {
  // The RPC path is the product: full history, no key, no rate budget.
  // Bitquery stays available behind an explicit flag for benchmarking.
  const wanted = flag ?? "rpc";
  if (wanted === "bitquery") {
    const { BitqueryProvider } = await import("./bitquery.ts");
    return new BitqueryProvider();
  }
  return new RpcProvider();
}

