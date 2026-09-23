// Chain constants for Robinhood Chain (Arbitrum Orbit) and the Pons V2
// launchpad. Every address and topic here is verified by `xray doctor`
// against the live chain; nothing is taken on faith.

export type Hex = `0x${string}`;

export const CHAIN = {
  id: 4663,
  name: "Robinhood Chain",
  blockTimeMs: 103,
  blocksPerDay: 838_000n,
} as const;

// The official endpoint is the only one that serves eth_getLogs, but it
// rate-limits aggressively. publicnode is fast for state reads and refuses
// logs. RPC_URL env (comma-separated, "#nologs" suffix) overrides this list.
export const RPC_DEFAULTS: { url: string; logs: boolean; label: string }[] = [
  { url: "https://robinhood-rpc.publicnode.com", logs: false, label: "publicnode" },
  { url: "https://rpc.mainnet.chain.robinhood.com", logs: true, label: "official" },
];

export const ADDR = {
  factory: "0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e",
  router: "0xe33e9e479df8802cb0866d5d05258bec4cf62948",
  hook: "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044",
  locker: "0x267444d099b10fb5ed7c3cc7b7c767adca574952",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  multicall3: "0xca11bde05977b3631167028862be2a173976ca11",
} as const satisfies Record<string, Hex>;

export const ZERO: Hex = "0x0000000000000000000000000000000000000000";
export const DEAD: Hex = "0x000000000000000000000000000000000000dead";

export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  curveBuy: "0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455",
  curveSell: "0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df",
} as const satisfies Record<string, Hex>;

// Fixed infrastructure addresses. The per-token curve and pool are added at
// runtime when building the exclusion set for a specific token.
export const INFRA: ReadonlySet<string> = new Set([
  ADDR.factory,
  ADDR.router,
  ADDR.hook,
  ADDR.locker,
  ADDR.poolManager,
  ZERO,
  DEAD,
]);

// The public RPC truncates responses at this many logs.
export const GETLOGS_MAX = 10_000;

/** Block explorer for this chain: one place, so a link is never wrong
 * in one corner of the site and right in another. */
export const EXPLORER = "https://robinhoodchain.blockscout.com";

export const DUST_USD = 50;

// Two in five launches are paired against a stock or a stablecoin rather
// than ETH, and their prices are quoted in that pair: there is no dollar
// value to compare against. A share of supply stands in - a millionth of
// the float is dust in any currency.
export const DUST_SUPPLY_SHARE = 1e-6;
