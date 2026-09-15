import type { Hex } from "../chain.ts";
import { RpcProvider } from "./rpc.ts";
import type { Provider, QuoteEvent, RawTransfer, TokenActivity, TokenMeta } from "./provider.ts";
import type { Trade } from "../pnl/classify.ts";

/**
 * Mode B: Bitquery streaming GraphQL, network `robinhood`. Pons is indexed
 * there: CurveBuy/CurveSell arrive decoded and the same trades sit in the
 * DEX trades cube as protocol `pons_v2` with USD prices. The trades cube
 * keeps roughly the last 30 days; deeper history needs their archive
 * add-on, so a wallet's averages are month-scoped.
 *
 * Cheap point reads (token meta, current price, reserves) still go through
 * the public RPC - they are single eth_calls and free. Bitquery carries
 * everything bulky: token trade history, balances and the wallet-wide
 * trade history that the RPC cannot answer at all.
 *
 * Live verification of this provider is pending a Bitquery account; the
 * response mapping is pinned by tests on canned responses. The token comes
 * only from the BITQUERY_TOKEN env var - never from the repo.
 */

export const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

const TOKEN_TRADES_QUERY = `
query ($token: String!, $since: DateTime) {
  EVM(network: robinhood, dataset: combined) {
    DEXTrades(
      where: {Trade: {Currency: {SmartContract: {is: $token}}}, Block: {Time: {since: $since}}}
      orderBy: {ascending: Block_Number}
      limit: {count: 25000}
    ) {
      Block { Number }
      Transaction { Hash }
      Trade {
        Buy { Amount Buyer Currency { SmartContract } }
        Sell { Amount Seller Currency { SmartContract } }
      }
    }
  }
}`;

const TOKEN_TRANSFERS_QUERY = `
query ($token: String!, $since: DateTime) {
  EVM(network: robinhood, dataset: combined) {
    Transfers(
      where: {Transfer: {Currency: {SmartContract: {is: $token}}}, Block: {Time: {since: $since}}}
      orderBy: {ascending: Block_Number}
      limit: {count: 25000}
    ) {
      Block { Number }
      Transaction { Hash }
      Transfer { Amount Sender Receiver }
    }
  }
}`;

const BALANCES_QUERY = `
query ($token: String!) {
  EVM(network: robinhood, dataset: combined) {
    BalanceUpdates(
      where: {Currency: {SmartContract: {is: $token}}}
      orderBy: {descendingByField: "balance"}
      limit: {count: 25000}
    ) {
      BalanceUpdate { Address }
      balance: sum(of: BalanceUpdate_Amount)
    }
  }
}`;

const WALLET_TRADES_QUERY = `
query ($wallet: String!) {
  EVM(network: robinhood, dataset: combined) {
    DEXTrades(
      where: {any: [{Trade: {Buy: {Buyer: {is: $wallet}}}}, {Trade: {Sell: {Seller: {is: $wallet}}}}]}
      orderBy: {ascending: Block_Number}
      limit: {count: 25000}
    ) {
      Block { Number }
      Transaction { Hash }
      Trade {
        Buy { Amount Buyer Currency { SmartContract } }
        Sell { Amount Seller Currency { SmartContract } }
      }
    }
  }
}`;

// --- response shapes (the mapping contract, pinned by tests) ---

export interface BqTradeRow {
  Block: { Number: string };
  Transaction: { Hash: string };
  Trade: {
    Buy: { Amount: string; Buyer: string; Currency: { SmartContract: string } };
    Sell: { Amount: string; Seller: string; Currency: { SmartContract: string } };
  };
}

export interface BqTransferRow {
  Block: { Number: string };
  Transaction: { Hash: string };
  Transfer: { Amount: string; Sender: string; Receiver: string };
}

export interface BqBalanceRow {
  BalanceUpdate: { Address: string };
  balance: string;
}

function toWei(amount: string, decimals: number): bigint {
  // Bitquery amounts are decimal strings in whole-token units.
  const [int, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/**
 * A pons_v2 cube row is one decoded trade: one side is the token, the other
 * the quote (ETH). Rebuild the (transfer, quote) pair our classifier eats,
 * so mode A and mode B run the identical pipeline.
 */
export function mapTokenTrades(
  rows: BqTradeRow[],
  token: string,
  curve: string,
  decimals: number,
): { transfers: RawTransfer[]; quotes: QuoteEvent[] } {
  const transfers: RawTransfer[] = [];
  const quotes: QuoteEvent[] = [];
  const t = token.toLowerCase();
  let logIndex = 0;
  for (const r of rows) {
    const buySide = r.Trade.Buy;
    const sellSide = r.Trade.Sell;
    const tokenIsBuySide = buySide.Currency.SmartContract.toLowerCase() === t;
    const block = BigInt(r.Block.Number);
    const tx = r.Transaction.Hash as Hex;
    if (tokenIsBuySide) {
      // trader bought the token: tokens flow market -> buyer
      const tokens = toWei(buySide.Amount, decimals);
      const eth = toWei(sellSide.Amount, 18);
      transfers.push({ from: curve, to: buySide.Buyer.toLowerCase(), tokens, block, tx, logIndex: logIndex++ });
      quotes.push({ tx, kind: "curveBuy", eth, tokens });
    } else {
      const tokens = toWei(sellSide.Amount, decimals);
      const eth = toWei(buySide.Amount, 18);
      transfers.push({ from: sellSide.Seller.toLowerCase(), to: curve, tokens, block, tx, logIndex: logIndex++ });
      quotes.push({ tx, kind: "curveSell", eth, tokens });
    }
  }
  return { transfers, quotes };
}

export function mapWalletTrades(
  rows: BqTradeRow[],
  wallet: string,
  decimalsOf: (token: string) => number,
): Map<string, Trade[]> {
  const w = wallet.toLowerCase();
  const out = new Map<string, Trade[]>();
  for (const r of rows) {
    const { Buy, Sell } = r.Trade;
    const block = BigInt(r.Block.Number);
    const tx = r.Transaction.Hash;
    let token: string;
    let trade: Trade;
    if (Buy.Buyer.toLowerCase() === w) {
      token = Buy.Currency.SmartContract.toLowerCase();
      trade = { wallet: w, kind: "buy", tokens: toWei(Buy.Amount, decimalsOf(token)), eth: toWei(Sell.Amount, 18), block, tx };
    } else if (Sell.Seller.toLowerCase() === w) {
      token = Sell.Currency.SmartContract.toLowerCase();
      trade = { wallet: w, kind: "sell", tokens: toWei(Sell.Amount, decimalsOf(token)), eth: toWei(Buy.Amount, 18), block, tx };
    } else {
      continue;
    }
    const list = out.get(token) ?? [];
    list.push(trade);
    out.set(token, list);
  }
  return out;
}

export function mapBalances(rows: BqBalanceRow[], decimals: number): Map<string, bigint> {
  const out = new Map<string, bigint>();
  for (const r of rows) {
    out.set(r.BalanceUpdate.Address.toLowerCase(), toWei(r.balance, decimals));
  }
  return out;
}

export class BitqueryProvider implements Provider {
  readonly name = "bitquery" as const;
  readonly supportsProfiles = true;
  private rpc: RpcProvider;
  private token: string;
  private requests = 0;
  private fetchImpl: typeof fetch;

  constructor(opts: { apiToken?: string; rpc?: RpcProvider; fetchImpl?: typeof fetch } = {}) {
    const t = opts.apiToken ?? process.env.BITQUERY_TOKEN;
    if (!t) throw new Error("BITQUERY_TOKEN is not set");
    this.token = t;
    this.rpc = opts.rpc ?? new RpcProvider();
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    this.requests++;
    const res = await this.fetchImpl(BITQUERY_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`bitquery http ${res.status}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`bitquery: ${body.errors[0]!.message}`);
    if (!body.data) throw new Error("bitquery: empty response");
    return body.data;
  }

  tokenMeta(address: Hex): Promise<TokenMeta> {
    return this.rpc.tokenMeta(address);
  }

  async activity(token: TokenMeta, fromBlock: bigint): Promise<TokenActivity> {
    // The cube is time-indexed; ask since the launch and let the caller's
    // cache dedupe by block. 30-day cube window: on a young token this is
    // everything; on an older one it is what Bitquery keeps.
    const since = new Date(token.createdAt * 1000).toISOString();
    const [tradesData, transfersData] = await Promise.all([
      this.gql<{ EVM: { DEXTrades: BqTradeRow[] } }>(TOKEN_TRADES_QUERY, { token: token.address, since }),
      this.gql<{ EVM: { Transfers: BqTransferRow[] } }>(TOKEN_TRANSFERS_QUERY, { token: token.address, since }),
    ]);
    const mapped = mapTokenTrades(tradesData.EVM.DEXTrades, token.address, token.curve, token.decimals);
    // plain transfers (possible unknown-basis wallets); trades already carry
    // their own synthetic transfers, so keep only rows whose tx has no trade
    const tradeTxs = new Set(mapped.transfers.map((t) => t.tx));
    let logIndex = 1_000_000;
    const plain: RawTransfer[] = transfersData.EVM.Transfers.filter(
      (r) => !tradeTxs.has(r.Transaction.Hash as Hex),
    ).map((r) => ({
      from: r.Transfer.Sender.toLowerCase(),
      to: r.Transfer.Receiver.toLowerCase(),
      tokens: toWei(r.Transfer.Amount, token.decimals),
      block: BigInt(r.Block.Number),
      tx: r.Transaction.Hash as Hex,
      logIndex: logIndex++,
    }));
    const transfers = mapped.transfers.concat(plain).filter((t) => t.block >= fromBlock);
    const toBlock = transfers.reduce((m, t) => (t.block > m ? t.block : m), fromBlock);
    return { transfers, quotes: mapped.quotes, toBlock };
  }

  async balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>> {
    const data = await this.gql<{ EVM: { BalanceUpdates: BqBalanceRow[] } }>(BALANCES_QUERY, {
      token: token.address,
    });
    const all = mapBalances(data.EVM.BalanceUpdates, token.decimals);
    const out = new Map<string, bigint>();
    for (const w of wallets) out.set(w, all.get(w.toLowerCase()) ?? 0n);
    return out;
  }

  async walletTrades(wallet: string): Promise<Map<string, Trade[]>> {
    const data = await this.gql<{ EVM: { DEXTrades: BqTradeRow[] } }>(WALLET_TRADES_QUERY, {
      wallet,
    });
    // decimals per token are unknown here; pons launches are uniformly 18
    return mapWalletTrades(data.EVM.DEXTrades, wallet, () => 18);
  }

  async walletEthWei(wallet: string): Promise<bigint> {
    return this.rpc.client.getBalance({ address: wallet as Hex });
  }

  priceNowEth(token: TokenMeta): Promise<number> {
    return this.rpc.priceNowEth(token);
  }

  liquidityEth(token: TokenMeta): Promise<bigint> {
    return this.rpc.liquidityEth(token);
  }

  stats(): { label: string; requests: number } {
    const rpcReqs = this.rpc.stats().requests;
    return { label: "bitquery", requests: this.requests + rpcReqs };
  }
}
