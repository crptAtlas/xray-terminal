// CLI command bodies. Thin: parse options, call the library, print.

export interface CliOpts {
  format: "text" | "json" | "markdown";
  output?: string;
  provider?: "rpc" | "bitquery";
  top: number;
  profiles: boolean;
}

export async function runCheck(token: string, opts: CliOpts): Promise<void> {
  const { pickProvider, RpcProvider } = await import("../providers/rpc.ts");
  const { Cache } = await import("../cache.ts");
  const { tokenSnapshot } = await import("../read/token.ts");
  const { header } = await import("../read/header.ts");
  const { findGroups } = await import("../pnl/groups.ts");
  const { aggregate } = await import("../pnl/aggregate.ts");
  const { formatCheck, writeOutput, fmtAge } = await import("../format.ts");
  const { resolveTicker, looksLikeAddress } = await import("../read/launches.ts");

  const provider = pickProvider(opts.provider);
  if (!provider.supportsProfiles && opts.profiles) {
    console.error("note: wallet profiles are disabled in rpc mode (set BITQUERY_TOKEN to enable)");
  }
  const cache = new Cache();
  const t0 = Date.now();

  let address = token.toLowerCase();
  if (!looksLikeAddress(address)) {
    const client = provider instanceof RpcProvider ? provider.client : (await import("../providers/rpc.ts")).makeClient();
    const matches = await resolveTicker(client, cache, token);
    if (matches.length === 0) throw new Error(`no launch found for ticker "${token}"`);
    if (matches.length > 1) {
      console.log(`ticker "${token}" matches ${matches.length} launches; specify the address:`);
      for (const m of matches) {
        console.log(`  ${m.token}   $${m.symbol}   launched at block ${m.block}`);
      }
      cache.close();
      return;
    }
    address = matches[0]!.token;
  }

  const snap = await tokenSnapshot(provider, cache, address as `0x${string}`);
  const [hdr] = await Promise.all([header(provider, snap)]);
  const groups = findGroups(
    snap.holders
      .filter((h) => h.position.pnlPct !== null)
      .map((h) => ({ pnlPct: h.position.pnlPct as number, supplyShare: h.supplyShare })),
  );
  const aggs = aggregate(snap.holders);
  const s = provider.stats();
  const result = {
    snapshot: snap,
    header: hdr,
    groups,
    aggregates: aggs,
    top: snap.holders.slice(0, opts.top),
    source: { label: s.label, requests: s.requests, seconds: (Date.now() - t0) / 1000 },
  };
  writeOutput(formatCheck(result, opts.format), opts.output);
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
