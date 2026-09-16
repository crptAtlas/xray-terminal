// CLI command bodies. Thin: parse options, call the library, print.

import type { CheckResult } from "../format.ts";

export interface CliOpts {
  format: "text" | "json" | "markdown";
  output?: string;
  provider?: "rpc" | "bitquery";
  top: number;
  profiles: boolean;
  card?: string;
}

async function writeCard(result: CheckResult, file: string): Promise<void> {
  const { existsSync, writeFileSync } = await import("node:fs");
  if (existsSync(file)) throw new Error(`refusing to overwrite existing file: ${file}`);
  const { renderCard, cardMood } = await import("../card.ts");
  writeFileSync(file, await renderCard(result));
  console.error(`card (${cardMood(result)}) written to ${file}`);
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

  const provider = await pickProvider(opts.provider);
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

  const { check } = await import("../check.ts");
  let result: CheckResult | null = null;
  for await (const phase of check(provider, cache, address as `0x${string}`, {
    profiles: opts.profiles,
  })) {
    const s = provider.stats();
    const source = { label: s.label, requests: s.requests, seconds: (Date.now() - t0) / 1000 };
    if (phase.phase === 1) {
      result = {
        snapshot: phase.snapshot,
        header: phase.header,
        groups: phase.groups,
        aggregates: phase.aggregates,
        top: phase.snapshot.holders.slice(0, opts.top),
        source,
      };
      // phase 1 goes to the terminal immediately; if writing to a file,
      // wait for the final phase instead of printing twice
      if (!opts.output) console.log(formatCheck(result, opts.format));
    } else {
      if (!result) continue;
      const prev: CheckResult = result;
      result = {
        ...prev,
        aggregates: phase.aggregates,
        topExtras: new Map(
          prev.top.map((t) => {
            const p = phase.profiles.get(t.wallet);
            return [
              t.wallet,
              {
                avgPnlPerTrade: p?.avgPnlPerTrade ?? null,
                winrate: p?.winrate ?? null,
                trades: p ? p.trades : null,
                badges: p?.badges ?? [],
                notRead: p?.notRead,
              },
            ];
          }),
        ),
        source,
      };
      if (!opts.output) {
        console.log("\n--- profiles ---\n");
        console.log(formatCheck(result, opts.format));
      }
    }
  }
  if (opts.output && result !== null) {
    writeOutput(formatCheck(result, opts.format), opts.output);
  }
  if (opts.card && result !== null) await writeCard(result, opts.card);
  cache.close();
}

export async function runWallet(address: string, opts: CliOpts): Promise<void> {
  const { pickProvider } = await import("../providers/rpc.ts");
  const provider = await pickProvider(opts.provider);
  if (!provider.supportsProfiles) {
    throw new Error("wallet profiles need mode B: set BITQUERY_TOKEN (plans from $49/mo at bitquery.io)");
  }
  const { BitqueryProvider } = await import("../providers/bitquery.ts");
  if (!(provider instanceof BitqueryProvider)) throw new Error("wallet profiles need the bitquery provider");
  const { Cache } = await import("../cache.ts");
  const { walletProfile } = await import("../read/wallet.ts");
  const { writeOutput } = await import("../format.ts");
  const cache = new Cache();
  const p = await walletProfile(provider, cache, address.toLowerCase());
  const text =
    opts.format === "json"
      ? JSON.stringify(p, null, 2)
      : [
          `wallet ${p.wallet}`,
          `trades   ${p.trades} closed` + (p.wins ? `   wins ${p.wins}` : ""),
          `avg pnl  ${p.avgPnlPerTrade === null ? "-" : `${p.avgPnlPerTrade >= 0 ? "+" : ""}${p.avgPnlPerTrade.toFixed(1)}%/trade`}`,
          `winrate  ${p.winrate === null ? "- (needs 2+ trades)" : `${p.winrate.toFixed(1)}%`}`,
          `realized ${p.realizedTotalEth.toFixed(4)} ETH`,
          `balance  ${p.balanceEth.toFixed(4)} ETH`,
          `badges   ${p.badges.length ? p.badges.map((b) => `[${b}]`).join("") : "none"}`,
        ].join("\n");
  writeOutput(text, opts.output);
  cache.close();
}

export async function runServe(opts: CliOpts & { port: number; demo?: boolean }): Promise<void> {
  const { startServer } = await import("../serve.ts");
  if (opts.demo) {
    const { FixtureProvider, DEMO_FIXTURE, DEMO_ETH_USD } = await import("../demo.ts");
    process.env.ETH_USD ??= DEMO_ETH_USD;
    startServer({
      port: opts.port,
      top: opts.top,
      cachePath: ":memory:",
      makeProvider: () => new FixtureProvider(DEMO_FIXTURE),
    });
  } else {
    const { pickProvider, RpcProvider, makeClient } = await import("../providers/rpc.ts");
    const { resolveTicker } = await import("../read/launches.ts");
    startServer({
      port: opts.port,
      top: opts.top,
      makeProvider: () => pickProvider(opts.provider),
      resolveQuery: async (provider, cache, q) => {
        const client = provider instanceof RpcProvider ? provider.client : makeClient();
        const matches = await resolveTicker(client, cache, q);
        if (matches.length === 0) throw new Error(`no launch found for ticker "${q}"`);
        if (matches.length > 1) {
          throw new Error(
            `ticker "${q}" matches ${matches.length} launches, use the address: ` +
              matches.map((m) => m.token).join(", "),
          );
        }
        const first = matches[0];
        if (!first) throw new Error("no match");
        return first.token;
      },
    });
  }
  console.log(`xray terminal on http://127.0.0.1:${opts.port}${opts.demo ? "  (DEMO fixtures)" : ""}`);
  await new Promise(() => {}); // run until interrupted
}

export async function runDoctor(_opts: CliOpts): Promise<void> {
  const { doctor } = await import("../doctor.ts");
  const { ok } = await doctor();
  if (!ok) process.exitCode = 1;
}

export async function runDemo(opts: CliOpts): Promise<void> {
  const { FixtureProvider, DEMO_FIXTURE, DEMO_ETH_USD } = await import("../demo.ts");
  const { Cache } = await import("../cache.ts");
  const { check } = await import("../check.ts");
  const { formatCheck, writeOutput } = await import("../format.ts");

  process.env.ETH_USD ??= DEMO_ETH_USD; // fully offline
  const provider = new FixtureProvider(DEMO_FIXTURE);
  const cache = new Cache(":memory:");
  const t0 = Date.now();
  const meta = await provider.tokenMeta("0x0" as `0x${string}`);
  for await (const phase of check(provider, cache, meta.address)) {
    if (phase.phase !== 1) continue;
    const s = provider.stats();
    writeOutput(
      formatCheck(
        {
          snapshot: phase.snapshot,
          header: phase.header,
          groups: phase.groups,
          aggregates: phase.aggregates,
          top: phase.snapshot.holders.slice(0, opts.top),
          source: { label: s.label, requests: s.requests, seconds: (Date.now() - t0) / 1000 },
          demo: true,
        },
        opts.format,
      ),
      opts.output,
    );
    if (opts.card) {
      await writeCard(
        {
          snapshot: phase.snapshot,
          header: phase.header,
          groups: phase.groups,
          aggregates: phase.aggregates,
          top: phase.snapshot.holders.slice(0, opts.top),
          source: { label: s.label, requests: s.requests, seconds: (Date.now() - t0) / 1000 },
          demo: true,
        },
        opts.card,
      );
    }
  }
  cache.close();
}
