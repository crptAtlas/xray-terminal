import type { Hex } from "../chain.ts";

// The data-source boundary. Everything above this interface is agnostic to
// where the data comes from: the public RPC (mode A) or Bitquery (mode B).

export type Phase = { kind: "curve"; fillPct: number } | { kind: "graduated" };

export interface TokenMeta {
  address: Hex;
  symbol: string;
  name: string;
  decimals: number;
  totalSupply: bigint;
  curve: Hex;
  pool?: Hex; // v4 pool id is tracked via the hook; unset while on the curve
  deployer: Hex;
  creatorFeeRecipient: Hex;
  createdBlock: bigint;
  createdAt: number; // unix seconds
  phase: Phase;
  // launches can be paired with a token instead of ETH (tokenized stocks:
  // NVDA, GOOGL, ...). All curve amounts are then in pair-token units and
  // ETH-based pnl math does not apply.
  pairToken: Hex;
  pairSymbol: string | null; // null when the pair is native ETH
  pairDecimals?: number | null; // decimals of the pair token, 18 for ETH
}

export interface RawTransfer {
  from: string; // lowercase
  to: string; // lowercase
  tokens: bigint;
  block: bigint;
  tx: Hex;
  logIndex: number;
}

// An ETH quote observed in the same transaction as a token transfer.
export interface QuoteEvent {
  tx: Hex;
  kind: "curveBuy" | "curveSell" | "swap" | "weth";
  eth: bigint; // wei
  tokens?: bigint; // token amount the event claims, when it does
}

export interface TokenActivity {
  transfers: RawTransfer[];
  quotes: QuoteEvent[];
  toBlock: bigint;
}

export interface Provider {
  readonly name: "rpc" | "bitquery";
  readonly supportsProfiles: boolean;
  tokenMeta(address: Hex, hint?: { createdBlock?: bigint }): Promise<TokenMeta>;
  /** All token movement and quotes from `fromBlock` (inclusive) to the tip. */
  activity(token: TokenMeta, fromBlock: bigint): Promise<TokenActivity>;
  balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>>;
  /** Current price in ETH per whole token. */
  priceNowEth(token: TokenMeta): Promise<number>;
  /** ETH side of the curve or pool, in wei. */
  liquidityEth(token: TokenMeta): Promise<bigint>;
  stats(): { label: string; requests: number };
}

