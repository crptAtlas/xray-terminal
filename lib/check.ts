import type { Cache } from "./cache.ts";
import { aggregate, type Aggregates } from "./pnl/aggregate.ts";
import { findGroups, type Group } from "./pnl/groups.ts";
import type { Profile } from "./profile/profile.ts";
import type { Hex } from "./chain.ts";
import type { Provider } from "./providers/provider.ts";
import { header, type Header } from "./read/header.ts";
import { tokenSnapshot, type TokenSnapshot } from "./read/token.ts";
import type { StageReporter } from "./stages.ts";

/**
 * The library entry: progressive two-phase check (spec 4.1). Phase 1 -
 * header, holder PnL, groups, aggregates - yields as soon as it is ready.
 * Phase 2 - wallet profiles and badges (mode B only) - follows, under a
 * hard deadline; wallets that miss it come back marked notRead. Surfaces
 * (CLI today, a site or bot later) consume the same iterator.
 */

export interface PhaseOne {
  phase: 1;
  snapshot: TokenSnapshot;
  header: Header;
  groups: Group[];
  aggregates: Aggregates;
}

export interface PhaseTwo {
  phase: 2;
  profiles: Map<string, Profile>;
  aggregates: Aggregates; // recomputed with winrate/firstTrade filled in
}

export type CheckPhase = PhaseOne | PhaseTwo;

export interface CheckOpts {
  profiles?: boolean;
  profileDeadlineMs?: number;
  /** Profile at most this many top holders (default: all). */
  profileLimit?: number;
  onStage?: StageReporter;
}

export async function* check(
  provider: Provider,
  cache: Cache,
  address: Hex,
  opts: CheckOpts = {},
): AsyncGenerator<CheckPhase> {
  const onStage: StageReporter = opts.onStage ?? (() => {});
  const snapshot = await tokenSnapshot(provider, cache, address, onStage);
  const hdr = await header(provider, snapshot);
  onStage({ agent: "sorter", status: "start" });
  const groups = findGroups(
    snapshot.holders
      .filter((h) => !h.excluded && h.position.pnlPct !== null)
      .map((h) => ({ pnlPct: h.position.pnlPct as number, supplyShare: h.supplyShare })),
  );
  onStage({ agent: "sorter", status: "done", detail: `${groups.length} groups` });
  onStage({ agent: "auditor", status: "start" });
  const aggregates = aggregate(snapshot.holders);
  onStage({
    agent: "auditor",
    status: "done",
    detail: aggregates.avgPnlPct === null ? "no averages" : `avg ${aggregates.avgPnlPct >= 0 ? "+" : ""}${aggregates.avgPnlPct.toFixed(0)}%`,
  });
  yield { phase: 1, snapshot, header: hdr, groups, aggregates };

  if (opts.profiles === false) return;

  const { walletProfilesBatch } = await import("./read/wallet.ts");
  const { RpcProvider } = await import("./providers/rpc.ts");
  const rpc =
    provider instanceof RpcProvider
      ? provider
      : (provider as { rpc?: InstanceType<typeof RpcProvider> }).rpc;
  if (!rpc) {
    onStage({ agent: "tracer", status: "skip", detail: "no rpc source" });
    return;
  }
  const wallets = snapshot.holders.slice(0, opts.profileLimit ?? 1000).map((h) => h.wallet);
  onStage({ agent: "tracer", status: "start" });
  // the scanned token itself is excluded from every profile: insiders of
  // this launch must not decorate their stats with it.
  // Profiles arrive in chunks so the page fills in as they land instead
  // of waiting for the last wallet of a thousand.
  const CHUNK = 250;
  const deadline = Date.now() + (opts.profileDeadlineMs ?? 60_000);
  const profiles = new Map<string, Profile>();
  for (let i = 0; i < wallets.length; i += CHUNK) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const slice = wallets.slice(i, i + CHUNK);
    const part = await walletProfilesBatch(rpc, cache, slice, left, snapshot.meta.address);
    for (const [w, p] of part) profiles.set(w, p);
    const read = [...profiles.values()].filter((p) => !p.notRead).length;
    // stages report progress; the result itself lands once, complete
    if (i + CHUNK < wallets.length && Date.now() < deadline) {
      onStage({ agent: "tracer", status: "start", detail: `${read} of ${wallets.length} wallets` });
    }
  }
  onStage({ agent: "tracer", status: "done", detail: `${profiles.size} wallets traced` });
  yield { phase: 2, profiles, aggregates: aggregate(snapshot.holders, profiles) };
}
