#!/usr/bin/env node
import { Command } from "commander";

const program = new Command();

program
  .name("appname")
  .description("holder PnL terminal for Pons V2 tokens on Robinhood Chain (read-only)")
  .version("0.1.0")
  .option("--format <fmt>", "output format: text | json | markdown", "text")
  .option("--output <file>", "write output to a file (refuses to overwrite)")
  .option("--provider <name>", "data source: rpc | bitquery")
  .option("--top <n>", "top holders to show", (v) => parseInt(v, 10), 10)
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
  .description("wallet profile across all tokens (requires BITQUERY_TOKEN)")
  .action(async (address) => {
    const { runWallet } = await import("../lib/cli/run.ts");
    await runWallet(address, program.opts());
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
