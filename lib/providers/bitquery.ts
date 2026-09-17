import { ADDR, ZERO, type Hex } from "../chain.ts";
import { RpcProvider } from "./rpc.ts";
import type { Provider, TokenActivity, TokenMeta } from "./provider.ts";
import type { Trade } from "../pnl/classify.ts";

/**
 * Mode B: Bitquery streaming GraphQL, network `robinhood`, verified against
 * the live schema. Token scans stay on the RPC (exact, free); Bitquery
 * answers the one question the RPC cannot: every trade of a wallet across
 * every Pons token, which powers winrate, badges and wallet profiles.
 *
 * How a wallet's history is rebuilt: token Transfers touching the wallet
 * (the trader is the token movement - Buyer/Seller in the trade cubes are
 * relayers and pool contracts on this chain), joined with DEXTradeByTokens
 * rows of the same transactions for the ETH quote. A transfer with no
 * trade in its transaction is a plain transfer: no cost basis, skipped.
 *
 * The `realtime` dataset spans only the last several days (the archive
 * add-on unlocks deeper history), so a wallet's averages are windowed to
 * what the plan covers. The token comes from BITQUERY_TOKEN, never the repo.
 */

export const BITQUERY_URL = "https://streaming.bitquery.io/graphql";

// Adaptive throttle shared by every provider instance in the process:
// full speed until the API answers 429, then a global queue with spacing
// for a while (the free plan allows on the order of ten requests a
// minute; a paid plan effectively never trips this).
const SPACING_MS = Number(process.env.BITQUERY_SPACING_MS ?? 6500);
const COOLDOWN_MS = 120_000;
let rateLimitedUntil = 0;
let queueTail: Promise<void> = Promise.resolve();

function throttled<T>(fn: () => Promise<T>): Promise<T> {
  if (Date.now() > rateLimitedUntil) return fn();
  const run = queueTail.then(async () => {
    await new Promise((r) => setTimeout(r, SPACING_MS));
  });
  queueTail = run.catch(() => {});
  return run.then(fn);
}

export function noteRateLimit(): void {
  rateLimitedUntil = Date.now() + COOLDOWN_MS;
}

// Conservative width of the realtime dataset: tokens born inside it can be
// scanned entirely from Bitquery in a handful of requests; older ones fall
// back to the RPC log walk.
export const REALTIME_WINDOW_S = 3.5 * 24 * 3600;

const TOKEN_TRANSFERS_PAGE = `
query ($token: String!, $after: String!) {
  EVM(network: robinhood, dataset: realtime) {
    Transfers(
      where: {Transfer: {Currency: {SmartContract: {is: $token}}}, Block: {Number: {gt: $after}}}
      orderBy: {ascending: Block_Number}
      limit: {count: 25000}
    ) {
      Block { Number }
      Transaction { Hash }
      Transfer { Amount Sender Receiver }
      TransactionStatus { Success }
    }
  }
}`;

const TOKEN_QUOTES_PAGE = `
query ($token: String!, $after: String!) {
  EVM(network: robinhood, dataset: realtime) {
    DEXTradeByTokens(
      where: {Trade: {Currency: {SmartContract: {is: $token}}, Side: {Currency: {SmartContract: {is: "0x0000000000000000000000000000000000000000"}}}}, Block: {Number: {gt: $after}}}
      orderBy: {ascending: Block_Number}
      limit: {count: 25000}
    ) {
      Block { Number }
      Transaction { Hash }
      Trade { Amount Side { Amount } }
    }
  }
}`;

const TOKEN_BALANCES_QUERY = `
query ($token: String!) {
  EVM(network: robinhood, dataset: realtime) {
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

const WALLET_TRANSFERS_QUERY = `
query ($wallet: String!) {
  EVM(network: robinhood, dataset: realtime) {
    Transfers(
      where: {any: [{Transfer: {Sender: {is: $wallet}}}, {Transfer: {Receiver: {is: $wallet}}}], Transfer: {Currency: {Fungible: true}}}
      orderBy: {ascending: Block_Number}
      limit: {count: 5000}
    ) {
      Block { Number }
      Transaction { Hash }
      Transfer { Amount Sender Receiver Currency { SmartContract } }
    }
  }
}`;

const QUOTES_BY_TX_QUERY = `
query ($hashes: [String!]) {
  EVM(network: robinhood, dataset: realtime) {
    DEXTradeByTokens(
      where: {Transaction: {Hash: {in: $hashes}}, Trade: {Side: {Currency: {SmartContract: {is: "0x0000000000000000000000000000000000000000"}}}}}
      limit: {count: 5000}
    ) {
      Transaction { Hash }
      Trade {
        Currency { SmartContract }
        Amount
        Side { Amount }
      }
    }
  }
}`;

// --- response shapes (the mapping contract, pinned by tests) ---

export interface BqTransferRow {
  Block: { Number: string };
  Transaction: { Hash: string };
  Transfer: { Amount: string; Sender: string; Receiver: string; Currency: { SmartContract: string } };
}

export interface BqQuoteRow {
  Transaction: { Hash: string };
  Trade: { Currency: { SmartContract: string }; Amount: string; Side: { Amount: string } };
}

interface BqTokenTransferRow {
  Block: { Number: string };
  Transaction: { Hash: string };
  Transfer: { Amount: string; Sender: string; Receiver: string };
  TransactionStatus: { Success: boolean };
}

interface BqTokenQuoteRow {
  Block: { Number: string };
  Transaction: { Hash: string };
  Trade: { Amount: string; Side: { Amount: string } };
}

interface BqBalanceRow {
  BalanceUpdate: { Address: string };
  balance: string;
}

export function toWei(amount: string, decimals: number): bigint {
  // Bitquery amounts are decimal strings in whole-token units.
  const [int, frac = ""] = amount.split(".");
  const fracPadded = (frac + "0".repeat(decimals)).slice(0, decimals);
  return BigInt(int || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
}

/**
 * Rebuild a wallet's per-token trade ledger from its transfers plus the
 * ETH quotes of the same transactions. Pons launches are uniformly 18
 * decimals.
 */
export function mapWalletHistory(
  wallet: string,
  transfers: BqTransferRow[],
  quotes: BqQuoteRow[],
): Map<string, Trade[]> {
  const w = wallet.toLowerCase();
  const quoteByTxToken = new Map<string, bigint>();
  for (const q of quotes) {
    const key = q.Transaction.Hash.toLowerCase() + ":" + q.Trade.Currency.SmartContract.toLowerCase();
    quoteByTxToken.set(key, (quoteByTxToken.get(key) ?? 0n) + toWei(q.Trade.Side.Amount, 18));
  }
  const out = new Map<string, Trade[]>();
  for (const t of transfers) {
    const token = t.Transfer.Currency.SmartContract.toLowerCase();
    if (token === ZERO || token === ADDR.weth) continue; // quote legs, not positions
    const tx = t.Transaction.Hash.toLowerCase();
    const eth = quoteByTxToken.get(tx + ":" + token);
    if (eth === undefined) continue; // plain transfer: no honest cost basis
    const inbound = t.Transfer.Receiver.toLowerCase() === w;
    const trade: Trade = {
      wallet: w,
      kind: inbound ? "buy" : "sell",
      tokens: toWei(t.Transfer.Amount, 18),
      eth,
      block: BigInt(t.Block.Number),
      tx,
    };
    const list = out.get(token) ?? [];
    list.push(trade);
    out.set(token, list);
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

  private gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    return throttled(async () => {
      for (let attempt = 0; ; attempt++) {
        this.requests++;
        const res = await this.fetchImpl(BITQUERY_URL, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.token}`,
          },
          body: JSON.stringify({ query, variables }),
        });
        if (res.status === 429 && attempt < 4) {
          noteRateLimit();
          await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** attempt, 8000)));
          continue;
        }
        if (!res.ok) throw new Error(`bitquery http ${res.status}`);
        const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
        if (body.errors?.length) throw new Error(`bitquery: ${body.errors[0]!.message}`);
        if (!body.data) throw new Error("bitquery: empty response");
        return body.data;
      }
    });
  }

  // Cheap point reads stay on the RPC; the bulky log walks go to Bitquery
  // for tokens born inside the realtime window (a handful of requests
  // instead of hundreds of getLogs windows), with the RPC as the fallback.
  tokenMeta(address: Hex, hint?: { createdBlock?: bigint }): Promise<TokenMeta> {
    return this.rpc.tokenMeta(address, hint);
  }

  private insideWindow(token: TokenMeta): boolean {
    return Date.now() / 1000 - token.createdAt < REALTIME_WINDOW_S;
  }

  async activity(token: TokenMeta, fromBlock: bigint): Promise<TokenActivity> {
    if (!this.insideWindow(token)) return this.rpc.activity(token, fromBlock);
    try {
      const [transfers, quotes, toBlock] = await Promise.all([
        this.pageAll<BqTokenTransferRow>(TOKEN_TRANSFERS_PAGE, token.address, fromBlock, (d) => (d as { EVM: { Transfers: BqTokenTransferRow[] } }).EVM.Transfers),
        this.pageAll<BqTokenQuoteRow>(TOKEN_QUOTES_PAGE, token.address, fromBlock, (d) => (d as { EVM: { DEXTradeByTokens: BqTokenQuoteRow[] } }).EVM.DEXTradeByTokens),
        this.rpc.client.getBlockNumber(),
      ]);
      let logIndex = 0;
      const rawTransfers = transfers
        .filter((t) => t.TransactionStatus.Success)
        .map((t) => ({
          from: t.Transfer.Sender.toLowerCase(),
          to: t.Transfer.Receiver.toLowerCase(),
          tokens: toWei(t.Transfer.Amount, token.decimals),
          block: BigInt(t.Block.Number),
          tx: t.Transaction.Hash.toLowerCase() as Hex,
          logIndex: logIndex++,
        }));
      const rawQuotes = quotes.map((q) => ({
        tx: q.Transaction.Hash.toLowerCase() as Hex,
        kind: "swap" as const,
        eth: toWei(q.Trade.Side.Amount, 18),
        tokens: toWei(q.Trade.Amount, token.decimals),
      }));
      return { transfers: rawTransfers, quotes: rawQuotes, toBlock };
    } catch {
      return this.rpc.activity(token, fromBlock);
    }
  }

  private async pageAll<T extends { Block: { Number: string } }>(
    query: string,
    token: string,
    fromBlock: bigint,
    pick: (d: unknown) => T[],
  ): Promise<T[]> {
    const out: T[] = [];
    let after = fromBlock > 0n ? (fromBlock - 1n).toString() : "0";
    for (let page = 0; page < 12; page++) {
      const data = await this.gql<unknown>(query, { token, after });
      const rows = pick(data);
      out.push(...rows);
      if (rows.length < 25000) return out;
      after = rows[rows.length - 1]!.Block.Number;
    }
    return out;
  }

  async balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>> {
    if (!this.insideWindow(token)) return this.rpc.balances(token, wallets);
    try {
      const data = await this.gql<{ EVM: { BalanceUpdates: BqBalanceRow[] } }>(TOKEN_BALANCES_QUERY, { token: token.address });
      const all = new Map<string, bigint>();
      for (const r of data.EVM.BalanceUpdates) {
        const v = toWei(r.balance.startsWith("-") ? "0" : r.balance, token.decimals);
        all.set(r.BalanceUpdate.Address.toLowerCase(), v);
      }
      const out = new Map<string, bigint>();
      for (const w of wallets) out.set(w, all.get(w.toLowerCase()) ?? 0n);
      return out;
    } catch {
      return this.rpc.balances(token, wallets);
    }
  }

  priceNowEth(token: TokenMeta): Promise<number> {
    return this.rpc.priceNowEth(token);
  }

  liquidityEth(token: TokenMeta): Promise<bigint> {
    return this.rpc.liquidityEth(token);
  }

  async walletTrades(wallet: string): Promise<Map<string, Trade[]>> {
    const w = wallet.toLowerCase();
    const data = await this.gql<{ EVM: { Transfers: BqTransferRow[] } }>(WALLET_TRANSFERS_QUERY, { wallet: w });
    const transfers = data.EVM.Transfers.filter((t) => {
      const c = t.Transfer.Currency.SmartContract.toLowerCase();
      return c !== ZERO && c !== ADDR.weth;
    });
    const hashes = [...new Set(transfers.map((t) => t.Transaction.Hash))];
    const quotes: BqQuoteRow[] = [];
    for (let i = 0; i < hashes.length; i += 100) {
      const chunk = hashes.slice(i, i + 100);
      const q = await this.gql<{ EVM: { DEXTradeByTokens: BqQuoteRow[] } }>(QUOTES_BY_TX_QUERY, { hashes: chunk });
      quotes.push(...q.EVM.DEXTradeByTokens);
    }
    return mapWalletHistory(w, transfers, quotes);
  }

  async walletEthWei(wallet: string): Promise<bigint> {
    return this.rpc.client.getBalance({ address: wallet as Hex });
  }

  stats(): { label: string; requests: number } {
    const rpcReqs = this.rpc.stats().requests;
    return { label: "rpc + bitquery", requests: this.requests + rpcReqs };
  }
}
