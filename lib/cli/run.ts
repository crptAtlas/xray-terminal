// CLI command bodies. Thin: parse options, call the library, print.

export interface CliOpts {
  format: "text" | "json" | "markdown";
  output?: string;
  provider?: "rpc" | "bitquery";
  top: number;
  profiles: boolean;
}

export async function runCheck(token: string, opts: CliOpts): Promise<void> {
  throw new Error("check: not implemented yet");
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
