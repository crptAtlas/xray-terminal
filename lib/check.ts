import type { Cache } from "./cache.ts";
import { aggregate, type Aggregates } from "./pnl/aggregate.ts";
import { findGroups, type Group } from "./pnl/groups.ts";
import type { Profile } from "./profile/profile.ts";
import type { Hex } from "./chain.ts";
import type { Provider } from "./providers/provider.ts";
import { header, type Header } from "./read/header.ts";
import { tokenSnapshot, type TokenSnapshot } from "./read/token.ts";

/**
 * The library entry: progressive two-phase check (spec 4.1). Phase 1 —
 * header, holder PnL, groups, aggregates — yields as soon as it is ready.
 * Phase 2 — wallet profiles and badges (mode B only) — follows, under a
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
}

export async function* check(
  provider: Provider,
  cache: Cache,
  address: Hex,
  opts: CheckOpts = {},
): AsyncGenerator<CheckPhase> {
  const snapshot = await tokenSnapshot(provider, cache, address);
  const hdr = await header(provider, snapshot);
  const groups = findGroups(
    snapshot.holders
      .filter((h) => h.position.pnlPct !== null)
      .map((h) => ({ pnlPct: h.position.pnlPct as number, supplyShare: h.supplyShare })),
  );
  yield { phase: 1, snapshot, header: hdr, groups, aggregates: aggregate(snapshot.holders) };

  if (opts.profiles === false || !provider.supportsProfiles) return;

  const { walletProfilesWithDeadline } = await import("./read/wallet.ts");
  const { BitqueryProvider } = await import("./providers/bitquery.ts");
  if (!(provider instanceof BitqueryProvider)) return;
  const wallets = snapshot.holders.map((h) => h.wallet);
  const profiles = await walletProfilesWithDeadline(
    provider,
    cache,
    wallets,
    opts.profileDeadlineMs ?? 60_000,
  );
  yield { phase: 2, profiles, aggregates: aggregate(snapshot.holders, profiles) };
}
