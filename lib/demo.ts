import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "./chain.ts";
import type { Provider, QuoteEvent, RawTransfer, TokenActivity, TokenMeta } from "./providers/provider.ts";

/**
 * Offline provider over bundled fixture snapshots. Powers `xray demo`
 * and the full-pipeline tests. Requires nothing: no network, no keys.
 * Every output produced from it is marked DEMO.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

function load<T>(dir: string, file: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, dir, file), "utf8")) as T;
}

interface FixtureMeta extends Omit<TokenMeta, "totalSupply" | "createdBlock"> {
  totalSupply: string;
  createdBlock: string;
  priceEth: number;
  liquidityWei: string;
}

export class FixtureProvider implements Provider {
  readonly name = "rpc" as const; // fixtures are rpc-shaped snapshots
  readonly supportsProfiles = false;
  private dir: string;
  private requests = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  private metaRaw(): FixtureMeta {
    return load<FixtureMeta>(this.dir, "meta.json");
  }

  async tokenMeta(_address: Hex): Promise<TokenMeta> {
    this.requests++;
    const m = this.metaRaw();
    return {
      ...m,
      totalSupply: BigInt(m.totalSupply),
      createdBlock: BigInt(m.createdBlock),
    };
  }

  async activity(_token: TokenMeta, fromBlock: bigint): Promise<TokenActivity> {
    this.requests++;
    const transfers = load<(Omit<RawTransfer, "tokens" | "block"> & { tokens: string; block: string })[]>(
      this.dir,
      "transfers.json",
    ).map((t) => ({ ...t, tokens: BigInt(t.tokens), block: BigInt(t.block) }));
    const quotes = load<(Omit<QuoteEvent, "eth" | "tokens"> & { eth: string; tokens?: string })[]>(
      this.dir,
      "quotes.json",
    ).map((q) => ({ ...q, eth: BigInt(q.eth), tokens: q.tokens === undefined ? undefined : BigInt(q.tokens) }));
    const filtered = transfers.filter((t) => t.block >= fromBlock);
    const toBlock = transfers.reduce((m, t) => (t.block > m ? t.block : m), 0n);
    return { transfers: filtered, quotes, toBlock };
  }

  async balances(_token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>> {
    this.requests++;
    const entries = load<[string, string][]>(this.dir, "balances.json");
    const all = new Map(entries.map(([w, b]) => [w, BigInt(b)]));
    const out = new Map<string, bigint>();
    for (const w of wallets) out.set(w, all.get(w) ?? 0n);
    return out;
  }

  async priceNowEth(_token: TokenMeta): Promise<number> {
    return this.metaRaw().priceEth;
  }

  async liquidityEth(_token: TokenMeta): Promise<bigint> {
    return BigInt(this.metaRaw().liquidityWei);
  }

  stats(): { label: string; requests: number } {
    return { label: "demo fixtures", requests: this.requests };
  }
}

export const DEMO_FIXTURE = "graduated-token";
export const DEMO_ETH_USD = "2400";
