#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("xray")
  .description("holder PnL terminal for Pons V2 tokens on Robinhood Chain (read-only)")
  .version("0.1.0")
  .option("--format <fmt>", "output format: text | json | markdown", "text")
  .option("--output <file>", "write output to a file (refuses to overwrite)")
  .option("--provider <name>", "data source: rpc | bitquery")
  .option("--top <n>", "top holders to show", (v) => parseInt(v, 10), 10)
  .option("--card <file>", "also render a 1080x1080 share card PNG (green/yellow/red by token state)")
  .option("--no-profiles", "skip the wallet profile phase");

program
  .command("check")
  .argument("<token>", "token contract address or ticker")
  .description("full token breakdown: holder PnL, groups, aggregates, header")
  .action(async (token) => {
    const { runCheck } = await import("../lib/cli/run.ts");
    await runCheck(token, program.opts());
  });

program
  .command("wallet")
  .argument("<address>", "wallet address")
  .description("wallet profile across all tokens (full chain history, public RPC)")
  .action(async (address) => {
    const { runWallet } = await import("../lib/cli/run.ts");
    await runWallet(address, program.opts());
  });

program
  .command("index")
  .description("build/extend the local chain-wide trade index (one-time backfill, resumable)")
  .action(async () => {
    const { runIndex } = await import("../lib/cli/run.ts");
    await runIndex(program.opts());
  });

program
  .command("repair-v4")
  .description("re-decode v4 buys that carried a hook fee leg (narrow, resumable)")
  .action(async () => {
    const { runRepairV4 } = await import("../lib/cli/run.ts");
    await runRepairV4(program.opts());
  });

program
  .command("follow")
  .description("follow the chain head: light tail sync of both index lanes, forever")
  .action(async () => {
    const { runFollow } = await import("../lib/cli/run.ts");
    await runFollow(program.opts());
  });

program
  .command("doctor")
  .description("verify data source, addresses, topics and limits against the live chain")
  .action(async () => {
    const { runDoctor } = await import("../lib/cli/run.ts");
    await runDoctor(program.opts());
  });

program
  .command("demo")
  .description("offline breakdown on bundled fixtures, output marked DEMO")
  .action(async () => {
    const { runDemo } = await import("../lib/cli/run.ts");
    await runDemo(program.opts());
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

