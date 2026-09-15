import { decodeEventLog } from "viem";
import { ADDR, CHAIN, TOPIC, type Hex } from "./chain.ts";
import { curveAbi } from "./abi/pons.ts";
import { makeClient } from "./providers/rpc.ts";
import { gateEndpoints, rpcStats } from "./providers/gate.ts";
import { getLogsAdaptive } from "./providers/logs.ts";

// Verifies every hardcoded address and topic against the live chain instead
// of taking them on faith: chain id, bytecode at each contract, a real
// CurveBuy decoded from a recent block, and the practical getLogs limits.

interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

export async function doctor(): Promise<{ checks: Check[]; ok: boolean }> {
  const client = makeClient();
  const checks: Check[] = [];
  const push = (label: string, ok: boolean, detail: string) => {
    checks.push({ label, ok, detail });
    console.log(`${ok ? " ok " : "FAIL"}  ${label.padEnd(22)} ${detail}`);
  };

  console.log(`endpoints: ${gateEndpoints().map((e) => e.label).join(", ")}`);

  const t0 = Date.now();
  const chainId = await client.getChainId();
  push("chain id", chainId === CHAIN.id, `${chainId} (${Date.now() - t0}ms first request)`);

  const latest = await client.getBlockNumber();
  push("latest block", latest > 0n, latest.toString());

  for (const [name, addr] of Object.entries(ADDR)) {
    const code = await client.getCode({ address: addr as Hex });
    push(`code at ${name}`, !!code && code !== "0x", addr);
  }

  // A real CurveBuy from the recent chain proves the topic and arg layout.
  const window = 3_000n;
  const from = latest > window ? latest - window : 0n;
  const t1 = Date.now();
  const logs = await getLogsAdaptive(client, {
    topics: [[TOPIC.curveBuy as Hex, TOPIC.curveSell as Hex]],
    fromBlock: from,
    toBlock: latest,
  }, { parallel: 1 });
  const dt = Date.now() - t1;
  push("recent curve events", logs.length > 0, `${logs.length} in last ${window} blocks (${dt}ms)`);

  const sample = logs[logs.length - 1];
  if (sample) {
    try {
      const decoded = decodeEventLog({
        abi: curveAbi,
        topics: sample.topics as [Hex, ...Hex[]],
        data: sample.data,
      });
      const args = decoded.args as unknown as Record<string, bigint>;
      const amount = decoded.eventName === "CurveBuy" ? args.quoteIn : args.quoteOut;
      push(
        "decode curve event",
        amount !== undefined,
        `${decoded.eventName} on ${sample.address} quote ${amount} wei`,
      );
    } catch (err) {
      push("decode curve event", false, err instanceof Error ? err.message : String(err));
    }
  }

  push(
    "getlogs pacing",
    true,
    `~${Math.round(dt / Math.max(1, Math.ceil(Number(window) / 3000)))}ms per window; response cap 10000 logs`,
  );

  const ok = checks.every((c) => c.ok);
  console.log(ok ? "\nall green" : "\nFAILURES above");
  console.log(`source rpc   ${rpcStats().requests} requests`);
  return { checks, ok };
}
