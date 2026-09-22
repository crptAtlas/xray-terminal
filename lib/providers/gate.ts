import { custom, type Transport } from "viem";
import { RPC_DEFAULTS } from "../chain.ts";
import { touchScan } from "../scanflag.ts";

/**
 * Every JSON-RPC request goes through this gate.
 *
 * The public endpoints behave differently: the official Robinhood RPC
 * answers HTTP 429 above roughly eight concurrent calls, meters
 * eth_getLogs much more tightly than eth_call and dislikes JSON-RPC
 * batching; publicnode is fast for state reads but refuses eth_getLogs.
 *
 * So: single requests (no batching), bounded concurrency, minimum spacing
 * (tighter for eth_getLogs), a process-wide cooldown after a 429, a penalty
 * box per endpoint and routing by method capability. Set RPC_URL to a
 * comma-separated list to replace the defaults ("#nologs" suffix marks an
 * endpoint that cannot serve eth_getLogs).
 */

export interface Endpoint {
  url: string;
  logs: boolean;
  badUntil: number;
  label: string;
}

function parseEndpoints(): Endpoint[] {
  const raw = process.env.RPC_URL?.trim();
  if (!raw) return RPC_DEFAULTS.map((e) => ({ ...e, badUntil: 0 }));
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((u) => {
      const noLogs = u.endsWith("#nologs");
      const url = noLogs ? u.slice(0, -"#nologs".length) : u;
      const known = RPC_DEFAULTS.find((d) => d.url === url);
      return {
        url,
        logs: known ? known.logs : !noLogs,
        badUntil: 0,
        label: known?.label ?? new URL(url).hostname,
      };
    });
}

const inFlightMax = Number(process.env.RPC_IN_FLIGHT ?? 3);
const spacingMs = Number(process.env.RPC_SPACING_MS ?? 40);
const logsSpacingMs = Number(process.env.RPC_LOGS_SPACING_MS ?? 150);
const cooldownMs = Number(process.env.RPC_COOLDOWN_MS ?? 4000);
const penaltyMs = Number(process.env.RPC_PENALTY_MS ?? 15_000);

interface GateState {
  endpoints: Endpoint[];
  active: number;
  lastSent: number;
  lastLogsSent: number;
  coolUntil: number;
  requests: number;
  queue: (() => void)[];
  fetchImpl: typeof fetch;
}

function newState(fetchImpl: typeof fetch, endpoints?: Endpoint[]): GateState {
  return {
    endpoints: endpoints ?? parseEndpoints(),
    active: 0,
    lastSent: 0,
    lastLogsSent: 0,
    coolUntil: 0,
    requests: 0,
    queue: [],
    fetchImpl,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquire(st: GateState): Promise<void> {
  if (st.active < inFlightMax) {
    st.active++;
    return;
  }
  await new Promise<void>((resolve) => st.queue.push(resolve));
  st.active++;
}

function release(st: GateState): void {
  st.active--;
  st.queue.shift()?.();
}

async function pace(st: GateState, isLogs: boolean): Promise<void> {
  for (;;) {
    const now = Date.now();
    const wait = Math.max(
      st.coolUntil - now,
      st.lastSent + spacingMs - now,
      isLogs ? st.lastLogsSent + logsSpacingMs - now : 0,
    );
    if (wait <= 0) break;
    await sleep(wait);
  }
  st.lastSent = Date.now();
  if (isLogs) st.lastLogsSent = st.lastSent;
}

async function send(st: GateState, method: string, params: unknown): Promise<unknown> {
  const isLogs = method === "eth_getLogs";
  // the site marks the node busy on every call it makes, so a digger on
  // the same host stays out of the queue for as long as a scan runs
  if (process.env.XRAY_TOUCH_SCAN) touchScan();
  await acquire(st);
  try {
    let lastErr: Error = new Error("no endpoint available");
    for (let attempt = 0; attempt < 4; attempt++) {
      const now = Date.now();
      const candidates = st.endpoints.filter((e) => (!isLogs || e.logs) && e.badUntil <= now);
      const ep = candidates[0] ?? st.endpoints.find((e) => !isLogs || e.logs);
      if (!ep) throw new Error(`no endpoint supports ${method}`);
      await pace(st, isLogs);
      st.requests++;
      let res: Response;
      try {
        res = await st.fetchImpl(ep.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
      } catch (err) {
        ep.badUntil = Date.now() + penaltyMs;
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }
      if (res.status === 429) {
        st.coolUntil = Date.now() + cooldownMs;
        ep.badUntil = Date.now() + penaltyMs;
        lastErr = new Error(`429 from ${ep.label}`);
        continue;
      }
      if (!res.ok) {
        ep.badUntil = Date.now() + penaltyMs;
        lastErr = new Error(`http ${res.status} from ${ep.label}`);
        continue;
      }
      const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
      if (body.error) {
        // JSON-RPC level errors (bad range, limits) belong to the caller -
        // adaptive windowing reacts to them. Do not penalize the endpoint.
        const err = new Error(body.error.message) as Error & { code?: number };
        err.code = body.error.code;
        throw err;
      }
      return body.result;
    }
    throw lastErr;
  } finally {
    release(st);
  }
}

let globalState: GateState | null = null;

function state(): GateState {
  if (!globalState) globalState = newState(fetch);
  return globalState;
}

/** viem transport backed by the gate. */
export function makeTransport(): Transport {
  return custom({
    request: ({ method, params }) => send(state(), method, params),
  });
}

export function rpcStats(): { requests: number } {
  return { requests: globalState?.requests ?? 0 };
}

export function gateEndpoints(): Endpoint[] {
  return state().endpoints;
}

/** Test hook: isolated gate over a mock fetch. */
export function makeGateForTest(fetchImpl: typeof fetch, endpoints: Endpoint[]) {
  const st = newState(fetchImpl, endpoints);
  return {
    request: (method: string, params: unknown) => send(st, method, params),
    stats: () => ({ requests: st.requests }),
  };
}
