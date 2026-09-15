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
import { curveAbi, factoryAbi, PHASE } from "../abi/pons.ts";
import { poolManagerAbi, SWAP_TOPIC } from "../abi/pool.ts";
import { makeTransport, rpcStats } from "./gate.ts";
import { getLogsAdaptive, type RawLog } from "./logs.ts";
import type { Provider, QuoteEvent, RawTransfer, TokenActivity, TokenMeta } from "./provider.ts";

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
  readonly supportsProfiles = false;
  readonly client: PublicClient;

  constructor(client?: PublicClient) {
    this.client = client ?? makeClient();
  }

  async tokenMeta(address: Hex): Promise<TokenMeta> {
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

    const [symbol, name, decimals, totalSupply, launchedAt] = await Promise.all([
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: "name" }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: "decimals" }),
      this.client.readContract({ address: addr, abi: erc20Abi, functionName: "totalSupply" }),
      this.client.readContract({ address: launched.curve, abi: curveAbi, functionName: "launchedAt" }),
    ]);

    let phase: TokenMeta["phase"];
    if (launched.phase === PHASE.curve) {
      const [real, threshold] = await Promise.all([
        this.client.readContract({ address: launched.curve, abi: curveAbi, functionName: "realQuoteReserve" }),
        this.client.readContract({ address: launched.curve, abi: curveAbi, functionName: "graduationThreshold" }),
      ]);
      const fillPct = threshold === 0n ? 0 : Number((real * 10_000n) / threshold) / 100;
      phase = { kind: "curve", fillPct: Math.min(fillPct, 100) };
    } else {
      phase = { kind: "graduated" };
    }

    const createdBlock = await this.findLaunchBlock(addr);

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
        const a = decoded.args as { quoteIn: bigint; tokensOut: bigint };
        quotes.push({ tx: l.transactionHash, kind: "curveBuy", eth: a.quoteIn, tokens: a.tokensOut });
      } else {
        const a = decoded.args as { tokensIn: bigint; quoteOut: bigint };
        quotes.push({ tx: l.transactionHash, kind: "curveSell", eth: a.quoteOut, tokens: a.tokensIn });
      }
    }
    for (const l of swapLogs) {
      const decoded = decodeEventLog({ abi: poolManagerAbi, topics: l.topics as [Hex, ...Hex[]], data: l.data });
      const a = decoded.args as { amount0: bigint; amount1: bigint };
      // The token is one currency, ETH/WETH the other; take the quote side.
      // Which side is which depends on currency sort order; classify matches
      // by token amount, so hand over both magnitudes.
      const tokenIsC0 = token.address.toLowerCase() < ADDR.weth;
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

  async balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>> {
    const out = new Map<string, bigint>();
    const chunk = 500;
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
      });
      res.forEach((r, j) => {
        out.set(slice[j] as string, r.status === "success" ? (r.result as bigint) : 0n);
      });
    }
    return out;
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
    // Graduated: price from the most recent swap in the last day of blocks.
    const toBlock = await this.client.getBlockNumber();
    const fromBlock = toBlock > CHAIN.blocksPerDay ? toBlock - CHAIN.blocksPerDay : 0n;
    const swaps = token.pool
      ? await getLogsAdaptive(this.client, {
          address: ADDR.poolManager as Hex,
          topics: [SWAP_TOPIC as Hex, token.pool],
          fromBlock,
          toBlock,
        })
      : [];
    const last = swaps[swaps.length - 1];
    if (!last) return 0;
    const decoded = decodeEventLog({ abi: poolManagerAbi, topics: last.topics as [Hex, ...Hex[]], data: last.data });
    const a = decoded.args as { sqrtPriceX96: bigint };
    // price(c1 per c0) = (sqrtP / 2^96)^2; convert to ETH per token.
    const ratio = Number(a.sqrtPriceX96) / 2 ** 96;
    const p = ratio * ratio;
    const tokenIsC0 = token.address.toLowerCase() < ADDR.weth;
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
    const toBlock = await this.client.getBlockNumber();
    const fromBlock = toBlock > CHAIN.blocksPerDay ? toBlock - CHAIN.blocksPerDay : 0n;
    const swaps = token.pool
      ? await getLogsAdaptive(this.client, {
          address: ADDR.poolManager as Hex,
          topics: [SWAP_TOPIC as Hex, token.pool],
          fromBlock,
          toBlock,
        })
      : [];
    const last = swaps[swaps.length - 1];
    if (!last) return 0n;
    const decoded = decodeEventLog({ abi: poolManagerAbi, topics: last.topics as [Hex, ...Hex[]], data: last.data });
    const a = decoded.args as { sqrtPriceX96: bigint; liquidity: bigint };
    const tokenIsC0 = token.address.toLowerCase() < ADDR.weth;
    if (tokenIsC0) {
      return (a.liquidity * a.sqrtPriceX96) / 2n ** 96n;
    }
    return (a.liquidity * 2n ** 96n) / a.sqrtPriceX96;
  }

  stats(): { label: string; requests: number } {
    return { label: "rpc", requests: rpcStats().requests };
  }
}

export async function pickProvider(flag?: "rpc" | "bitquery"): Promise<Provider> {
  const wanted = flag ?? (process.env.BITQUERY_TOKEN ? "bitquery" : "rpc");
  if (wanted === "bitquery") {
    const { BitqueryProvider } = await import("./bitquery.ts");
    return new BitqueryProvider();
  }
  return new RpcProvider();
}
