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
  const { RpcProvider } = await import("../providers/rpc.ts");
  const provider = new RpcProvider();
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

export async function runIndex(_opts: CliOpts): Promise<void> {
  const { makeClient } = await import("../providers/rpc.ts");
  const { Cache } = await import("../cache.ts");
  const { backfillTradeIndex, tradeIndexDepthDays } = await import("../read/indexer.ts");
  const { syncLaunches } = await import("../read/launches.ts");
  const client = makeClient();
  const cache = new Cache();
  const t0 = Date.now();
  console.error("syncing the launch index (curve -> token map)...");
  for (;;) {
    try {
      await syncLaunches(client, cache);
      break;
    } catch (err) {
      console.error(`launch sync: ${err instanceof Error ? err.message.slice(0, 80) : err}; cooling off 90s`);
      await new Promise((r) => setTimeout(r, 90_000));
    }
  }
  // XRAY_INDEX_LANES splits the work across machines: one digs curve,
  // another digs v4 from a different IP, rows merge by primary key
  const lanes = (process.env.XRAY_INDEX_LANES ?? "v4,curve")
    .split(",")
    .map((l) => l.trim())
    .filter((l): l is "curve" | "v4" => l === "curve" || l === "v4");
  console.error(`building the chain-wide trade index (lanes: ${lanes.join(" + ")}; resumable; ctrl-c any time)...`);
  // alternate lanes in one-minute slices so both histories deepen together;
  // the freshest blocks land first in each lane
  const done: Record<string, boolean> = { curve: !lanes.includes("curve"), v4: !lanes.includes("v4") };
  let rows = 0;
  while (!done.curve || !done.v4) {
    for (const lane of lanes) {
      if (done[lane]) continue;
      let res;
      try {
        res = await backfillTradeIndex(client, cache, { lane, budgetMs: 60_000 });
      } catch (err) {
        // any lane error (tail sync included) cools off instead of killing
        // hours of unattended progress
        console.error(`\n${lane} lane: ${err instanceof Error ? err.message.slice(0, 80) : err}; cooling off 90s`);
        await new Promise((r) => setTimeout(r, 90_000));
        continue;
      }
      rows += res.rows;
      done[lane] = res.done;
      const dc = tradeIndexDepthDays(cache, "curve");
      const dv = tradeIndexDepthDays(cache, "v4");
      process.stderr.write(
        `\r  curve ${dc === null ? "?" : dc.toFixed(1)}d${done.curve ? " done" : ""}   v4 ${dv === null ? "?" : dv.toFixed(1)}d${done.v4 ? " done" : ""}   rows +${rows}   ${((Date.now() - t0) / 1000).toFixed(0)}s   `,
      );
    }
  }
  process.stderr.write("\n");
  console.error("index lanes complete");
  // follow mode: the backfill is done for good, so this process becomes
  // the chain follower - every new block lands in the index within
  // seconds and scans never pay a catch-up cost
  console.error("following the chain head (tail sync every 30s; ctrl-c to stop)...");
  const { syncTradeIndexTail } = await import("../read/indexer.ts");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      await syncTradeIndexTail(client, cache, "curve");
      await syncTradeIndexTail(client, cache, "v4");
    } catch (err) {
      console.error(`tail sync: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
    await sleep(30_000);
  }
}

export async function runFollow(_opts: CliOpts): Promise<void> {
  const { makeClient } = await import("../providers/rpc.ts");
  const { Cache } = await import("../cache.ts");
  const { syncTradeIndexTail } = await import("../read/indexer.ts");
  const client = makeClient();
  const cache = new Cache();
  console.error("following the chain head (tail sync every 30s; ctrl-c to stop)...");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    try {
      await syncTradeIndexTail(client, cache, "curve");
      await syncTradeIndexTail(client, cache, "v4");
    } catch (err) {
      console.error(`tail sync: ${err instanceof Error ? err.message.slice(0, 80) : err}`);
    }
    await sleep(30_000);
  }
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
