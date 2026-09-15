// CLI command bodies. Thin: parse options, call the library, print.

export interface CliOpts {
  format: "text" | "json" | "markdown";
  output?: string;
  provider?: "rpc" | "bitquery";
  top: number;
  profiles: boolean;
}

export async function runCheck(token: string, opts: CliOpts): Promise<void> {
  const { pickProvider } = await import("../providers/rpc.ts");
  const { Cache } = await import("../cache.ts");
  const { tokenSnapshot } = await import("../read/token.ts");
  const provider = pickProvider(opts.provider);
  if (!provider.supportsProfiles) {
    console.error("note: wallet profiles are disabled in rpc mode (set BITQUERY_TOKEN to enable)");
  }
  const cache = new Cache();
  const t0 = Date.now();
  const snap = await tokenSnapshot(provider, cache, token.toLowerCase() as `0x${string}`);
  // rough dump for now; proper formatting lands with lib/format.ts
  console.log(`$${snap.meta.symbol}  ${snap.meta.address}  phase ${JSON.stringify(snap.meta.phase)}`);
  console.log(`price ${snap.priceEth} ETH  holders ${snap.holdersTotal}  usd ${snap.usdRate}`);
  for (const h of snap.holders.slice(0, opts.top)) {
    console.log(
      `${h.wallet}  ${(h.supplyShare * 100).toFixed(2)}% supply  pnl ${h.position.pnlPct?.toFixed(1)}%  (${(
        Number(h.position.pnlWei) / 1e18
      ).toFixed(4)} ETH)`,
    );
  }
  const e = snap.excluded;
  console.log(
    `excluded: dust ${e.dust}, unknown basis ${e.unknownBasis.wallets} (${(e.unknownBasis.supplyShare * 100).toFixed(1)}% supply), infra ${e.infra}`,
  );
  const s = provider.stats();
  console.log(`source ${s.label}   ${s.requests} requests   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  cache.close();
}

export async function runWallet(address: string, opts: CliOpts): Promise<void> {
  throw new Error("wallet: not implemented yet");
}

export async function runDoctor(_opts: CliOpts): Promise<void> {
  const { doctor } = await import("../doctor.ts");
  const { ok } = await doctor();
  if (!ok) process.exitCode = 1;
}

export async function runDemo(opts: CliOpts): Promise<void> {
  throw new Error("demo: not implemented yet");
}
