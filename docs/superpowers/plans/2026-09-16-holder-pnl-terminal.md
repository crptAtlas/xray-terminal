# Holder PnL Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** CLI + library that, given a Pons V2 token on Robinhood Chain, reports every holder's PnL, holder groups, token aggregates, wallet profiles with badges, and a token header.

**Architecture:** A provider interface (`lib/providers/provider.ts`) with two implementations — public RPC (mode A) and Bitquery (mode B). Pure math in `lib/pnl/` and `lib/profile/` with zero network access, tested on fixtures. SQLite incremental cache. Progressive two-phase output via async iterator.

**Tech Stack:** TypeScript, Node >= 20, ESM. Runtime: `viem`, `commander`, `better-sqlite3`. Dev: `tsx`, `typescript`, `@types/node`. Tests: `node --test`.

**Spec:** `docs/SPEC.md` + `docs/DESIGN.md`

## Global Constraints

- Node >= 20, ESM only, TypeScript.
- Runtime deps limited to `viem`, `commander`, `better-sqlite3`.
- No signing anywhere: CI job greps `lib/` and `bin/` for `PRIVATE_KEY`, `privateKeyToAccount`, `signTransaction`, `sendTransaction`, `writeContract`, `walletClient`, `signMessage` and fails on match.
- Placeholder name `APPNAME` / binary `appname`; no product name, no mention of any other project anywhere in the repo.
- All English: code, comments, docs, commits. Commits lowercase, short, no attribution lines.
- Pure math modules never import network code.
- Tests run offline on fixtures.
- Money: token amounts and ETH as `bigint` wei internally; percentages as JS numbers.

---

### Task 1: Scaffold + CI (M0)

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.github/workflows/ci.yml`, `bin/appname.mjs`, `lib/version.ts`

**Interfaces:**
- Produces: `npm run typecheck`, `npm test`, `npm run cli -- <args>` (tsx-driven dev entry); CI with jobs `check` (typecheck+test) and `no-signer`.

- [x] Step 1: `npm init`, install deps (`viem commander better-sqlite3`, dev `tsx typescript @types/node @types/better-sqlite3`), write `tsconfig.json` (strict, NodeNext, noEmit for typecheck), scripts: `typecheck`, `test` (`node --test --import tsx test/`), `cli` (`tsx bin/appname.mjs`).
- [x] Step 2: `bin/appname.mjs` — commander program with stub subcommands `check`, `wallet`, `doctor`, `demo` and global flags `--format`, `--output`, `--provider`, `--top`, `--no-profiles`.
- [x] Step 3: `.github/workflows/ci.yml` — job `check`: npm ci, typecheck, test; job `no-signer`: grep -rEn the seven forbidden identifiers over `lib/ bin/`, exit 1 on match.
- [x] Step 4: verify `npm run typecheck && npm test` green locally; run the no-signer grep locally.
- [x] Step 5: commit `scaffold: cli skeleton, ci, no-signer job`.

### Task 2: chain.ts + ABIs (M0)

**Files:**
- Create: `lib/chain.ts`, `lib/abi/erc20.ts`, `lib/abi/factory.ts`, `lib/abi/curve.ts`, `lib/abi/pool.ts`

**Interfaces:**
- Produces:
```ts
// lib/chain.ts
export const CHAIN: { id: 4663; blockTimeMs: 103; blocksPerDay: 838_000 };
export const RPC_DEFAULTS: { url: string; logs: boolean; label: string }[]; // official (logs) + publicnode (no logs)
export const ADDR: { factory; router; hook; locker; poolManager; weth; multicall3 } // lowercase `0x${string}`
export const TOPIC: { transfer; curveBuy; curveSell }; // from spec §3.2
export const INFRA: ReadonlySet<string>; // ADDR values + zero + 0xdead, lowercase
export const GETLOGS_MAX = 10_000;
```
- [x] Step 1: write `chain.ts` with the exact addresses/topics from SPEC §3.2 (lowercased) and `abi/` files: erc20 (Transfer, balanceOf, totalSupply, symbol, name, decimals), curve (CurveBuy/CurveSell events — infer arg layout in doctor task), factory (launch event placeholder refined in Task 11), pool manager Swap event, multicall3 aggregate3.
- [x] Step 2: unit test: every ADDR is lowercase and 42 chars, every TOPIC 66 chars, INFRA contains zero and dead addresses.
- [x] Step 3: commit `chain: addresses, topics, abis`.

### Task 3: RPC gate + adaptive getLogs (M0)

**Files:**
- Create: `lib/providers/gate.ts`, `lib/providers/logs.ts`
- Test: `test/gate.test.mjs` (spacing/concurrency on a mock transport), `test/logs.test.mjs`

**Interfaces:**
- Produces:
```ts
// gate.ts — every JSON-RPC request goes through here
export interface Endpoint { url: string; logs: boolean; badUntil: number; label: string }
export function makeTransport(): Transport;           // viem custom transport
export function rpcStats(): { requests: number };     // for the "source rpc 34 requests" footer
// logs.ts
export async function getLogsAdaptive(client, params: {address?, topics?, fromBlock, toBlock}): Promise<Log[]>;
// splits range in half recursively on "too many results"/limit errors; parallel windows (default 6)
```
- Behavior: bounded concurrency (default 3 in flight), min spacing 40ms (150ms for eth_getLogs), process-wide cooldown after HTTP 429, per-endpoint penalty box, route by method capability (`logs: false` endpoints never see eth_getLogs), `RPC_URL` env override (comma list, `#nologs` suffix).

- [x] Step 1: failing tests — gate routes eth_getLogs only to logs-capable endpoint; retries next endpoint on 429; counts requests. Mock fetch.
- [x] Step 2: implement gate. Run tests green.
- [x] Step 3: failing test — getLogsAdaptive splits on limit error (mock client returning error then halves succeed) and merges results ordered.
- [x] Step 4: implement, tests green, commit `rpc: request gate and adaptive getlogs`.

### Task 4: Provider interface + doctor (M0)

**Files:**
- Create: `lib/providers/provider.ts`, `lib/providers/rpc.ts` (partial: token info, logs plumbing), `lib/doctor.ts`
- Modify: `bin/appname.mjs` (wire doctor)

**Interfaces:**
- Produces:
```ts
// provider.ts
export interface TokenMeta { address; symbol; name; decimals; totalSupply: bigint; curve: `0x${string}`; pool?: `0x${string}`; createdBlock: bigint; createdAt: number; phase: { kind: "curve"; fillPct: number } | { kind: "graduated" } }
export interface RawTransfer { from; to; tokens: bigint; block: bigint; tx: `0x${string}`; logIndex: number }
export interface QuoteEvent { tx: `0x${string}`; kind: "curveBuy" | "curveSell" | "swap" | "weth"; eth: bigint; tokens?: bigint }
export interface TokenActivity { transfers: RawTransfer[]; quotes: QuoteEvent[]; toBlock: bigint }
export interface Provider {
  name: "rpc" | "bitquery";
  supportsProfiles: boolean;
  tokenMeta(address): Promise<TokenMeta>;
  activity(token: TokenMeta, fromBlock: bigint): Promise<TokenActivity>;
  balances(token: TokenMeta, wallets: string[]): Promise<Map<string, bigint>>;   // multicall3
  priceNowEth(token: TokenMeta): Promise<number>;      // ETH per token
  liquidityEth(token: TokenMeta): Promise<bigint>;     // ETH side, wei
  stats(): { label: string; requests: number };
}
export function pickProvider(flag?: "rpc" | "bitquery"): Provider; // env BITQUERY_TOKEN decides default
```
- `doctor`: against live chain — chain id == 4663, code exists at factory/router/hook/locker/poolManager/WETH, finds a recent CurveBuy log by topic and prints its curve address, measures getLogs limit behavior and request latency, prints verdict lines.

- [x] Step 1: write provider.ts types. Write doctor with checks above; wire `appname doctor`.
- [x] Step 2: run `npm run cli -- doctor` against the live chain; iterate until all checks print OK (this validates topics/addresses empirically, including CurveBuy/CurveSell arg layout — decode a real event and record the layout as a comment in `lib/abi/curve.ts`).
- [x] Step 3: commit `doctor: live chain verification`. **M0 done.**

### Task 5: classify (M1)

**Files:**
- Create: `lib/pnl/classify.ts`
- Test: `test/classify.test.mjs`

**Interfaces:**
- Produces:
```ts
export interface Trade { wallet: string; kind: "buy" | "sell"; tokens: bigint; eth: bigint; block: bigint; tx: string }
export interface TransferIn { wallet: string; tokens: bigint }  // non-trade inbound transfer
export function classify(transfers: RawTransfer[], quotes: QuoteEvent[], market: Set<string>): { trades: Trade[]; transfersIn: TransferIn[] }
```
- Rules (SPEC §3.3): market = curve + pool + router(+hook, poolManager). from∈market, to∉market ⇒ buy(to); from∉market, to∈market ⇒ sell(from); both outside ⇒ transfer. ETH quote per tx: prefer curveBuy/curveSell event in same tx, else swap, else largest weth transfer; a tx's quote is consumed by the matching trade.

- [x] Step 1: failing tests — buy via curve event; sell; wallet-to-wallet transfer produces TransferIn not Trade; relayed tx (tx.from irrelevant — classify never sees tx.from, assert trader = token recipient); pool swap quote; weth fallback.
- [x] Step 2: implement; green; commit `pnl: classify buys and sells by token movement`.

### Task 6: position (M1)

**Files:**
- Create: `lib/pnl/position.ts`
- Test: `test/position.test.mjs`

**Interfaces:**
- Produces:
```ts
export interface Position { boughtTokens: bigint; boughtCostWei: bigint; soldTokens: bigint; soldProceedsWei: bigint; remaining: bigint; pnlWei: bigint; pnlPct: number | null; unknownBasis: boolean; closed: boolean }
export function position(trades: Trade[], transfersInTokens: bigint, remaining: bigint, priceNowEthPerToken: number, decimals: number): Position
// pnl = soldProceeds + remaining*price - boughtCost; pnlPct = pnl/boughtCost*100
// unknownBasis when transfersInTokens > 0 or (remaining+sold > bought); pnlPct null when boughtCost == 0
// closed when remaining == 0n
```
- [x] Step 1: failing tests — buy only (unrealized); buy+sell full (realized, closed); partial sell; re-buy after sell; ETH top-up between trades does not change pnl (trades list identical ⇒ same result); inbound transfer ⇒ unknownBasis; zero cost ⇒ pnlPct null + unknownBasis.
- [x] Step 2: implement; green; commit `pnl: position formula`.

### Task 7: SQLite cache (M1)

**Files:**
- Create: `lib/cache.ts`
- Test: `test/cache.test.mjs` (temp-file db)

**Interfaces:**
- Produces:
```ts
export class Cache {
  constructor(path?: string); // default ~/.appname/cache.db, ":memory:" in tests
  tokenState(address): { syncedBlock: bigint } | null;
  saveToken(meta: TokenMeta, syncedBlock: bigint): void;
  loadTrades(token): Trade[];  appendTrades(token, trades: Trade[]): void;
  loadTransfersIn(token): TransferIn[];  appendTransfersIn(token, t): void;
  profile(wallet): { json: string; fetchedAt: number } | null;  saveProfile(wallet, json): void; // 24h TTL enforced by reader
  launchesTip(): bigint;  appendLaunches(rows: {block; token; symbol; curve}[]): void;  findTicker(symbol): {token; symbol; curve; block}[];
}
```
- Schema from DESIGN.md; bigints stored as TEXT; WAL mode.

- [x] Step 1: failing tests — roundtrip trades, incremental syncedBlock, profile TTL semantics, ticker index query case-insensitive.
- [x] Step 2: implement; green; commit `cache: sqlite incremental token and profile store`.

### Task 8: read/token + check phase 1 wiring (M1)

**Files:**
- Create: `lib/read/token.ts`, `lib/read/holders.ts`, `lib/usd.ts`
- Modify: `lib/providers/rpc.ts` (activity via getLogsAdaptive: Transfer logs of token + curve events of curve + swap/weth of pool per-tx), `bin/appname.mjs`

**Interfaces:**
- Produces:
```ts
// usd.ts
export async function ethUsd(): Promise<number>; // ETH_USD env → number; else Coinbase spot GET, 5 min in-memory+db cache
// read/token.ts
export interface HolderRow { wallet: string; position: Position; supplyShare: number }
export interface TokenSnapshot { meta: TokenMeta; holders: HolderRow[]; excluded: { dust: number; unknownBasis: { wallets: number; supplyShare: number }; infra: number }; priceEth: number; ethUsd: number }
export async function tokenSnapshot(provider, cache, query: string): Promise<TokenSnapshot>
// pipeline: meta → cached trades + activity(fromBlock=synced+1) → classify → balances(multicall) → position per wallet → filters (infra by INFRA+curve+pool; dust < $50; unknownBasis counter)
```
- [x] Step 1: implement rpc.ts `activity`: token Transfer logs windowed via getLogsAdaptive; curve CurveBuy/CurveSell logs; for graduated tokens pool swap logs + weth transfers grouped per tx into QuoteEvents.
- [x] Step 2: implement usd.ts + tokenSnapshot; holders.ts derives holder set from transfer balances (verify against multicall balances).
- [x] Step 3: wire rough `check <ca>` text dump (unformatted). Manually verify on a live token: pick 3 wallets, cross-check their trades and PnL against Blockscout. Fix until numbers agree.
- [x] Step 4: commit `read: token snapshot with incremental cache`. **M1 done.**

### Task 9: groups (M2)

**Files:**
- Create: `lib/pnl/groups.ts`
- Test: `test/groups.test.mjs`

**Interfaces:**
- Produces:
```ts
export interface Group { minPct: number; maxPct: number; supplyShare: number; holderShare: number; wallets: number }
export function findGroups(rows: { pnlPct: number; supplyShare: number }[], maxGroups = 3, widthPct = 5): Group[]
// sort by pnlPct; two-pointer sliding window of width <= 5; score = supply share; greedily pick up to 3 non-overlapping windows with >= 2 wallets, by descending score
```
- [x] Step 1: failing tests — never more than 3 groups; every group width <= 5; fewer than three clusters when data has fewer; a dominant dense cluster wins over a wide sparse one; singleton not a group.
- [x] Step 2: implement; green; commit `pnl: holder groups clustering`.

### Task 10: aggregates + header (M2)

**Files:**
- Create: `lib/pnl/aggregate.ts`, `lib/read/header.ts`
- Test: `test/aggregate.test.mjs`

**Interfaces:**
- Produces:
```ts
// aggregate.ts
export interface Aggregates { avgPnlPct: number; pnlWallets: number; avgWinrate: number | null; winrateWallets: number; firstTrade: { wallets: number; supplyShare: number }; exited: { wallets: number; avgPnlPct: number | null; avgWinrate: number | null } }
export function aggregate(rows: HolderRow[], profiles?: Map<string, Profile>): Aggregates
// header.ts
export interface Header { mcapUsd: number; liquidityUsd: number; volume24hUsd: number; holders: number; ageMs: number; phase: TokenMeta["phase"] }
export async function header(provider, snap: TokenSnapshot): Promise<Header>
// volume24h = sum of |eth| over trades in last 838k blocks; holders = nonzero balances pre-dust-filter
```
- [x] Step 1: failing tests for aggregate on synthetic rows (avg excludes dust/infra/unknownBasis — they never reach rows; winrate only trades>=2 wallets; exited line).
- [x] Step 2: implement both; green; commit `pnl: aggregates and token header`.

### Task 11: ticker index + format + CLI (M2)

**Files:**
- Create: `lib/format.ts`, `lib/read/launches.ts`
- Modify: `bin/appname.mjs`, `lib/providers/rpc.ts` (factory launch log scan)
- Test: `test/format.test.mjs`, `test/cli.test.mjs`

**Interfaces:**
- Produces:
```ts
// format.ts
export function formatCheck(data: CheckResult, fmt: "text" | "json" | "markdown"): string;  // text matches SPEC §6 sample layout
export function formatWallet(profile, fmt): string;
export function writeOutput(text: string, file?: string): void; // refuses existing file with clear error
// launches.ts
export async function resolveTicker(provider, cache, symbol): Promise<{ token: string } | { candidates: {token; symbol; ageMs; mcapUsd; holders}[] }>
```
- [x] Step 1: failing tests — text format matches §6 sample shape on fixture data; json roundtrips; markdown table present; writeOutput refuses existing file.
- [x] Step 2: implement format.ts; wire `--format/--output/--top`; green.
- [x] Step 3: launches index: doctor-verified factory launch event scan → cache.appendLaunches; ambiguous ticker prints candidate list.
- [x] Step 4: compare `check` output to §6 sample on live token; commit `cli: formats, ticker lookup, output`. **M2 done.**

### Task 12: Bitquery provider (M3)

**Files:**
- Create: `lib/providers/bitquery.ts`, `test/fixtures/bitquery/*.json`
- Test: `test/bitquery.test.mjs`

**Interfaces:**
- Consumes: `Provider` interface from Task 4.
- Produces: `BitqueryProvider implements Provider` with `supportsProfiles: true`, plus `walletTrades(wallet): Promise<Map<token, Trade[]>>` (last ~30 days, cube limit). GraphQL POST to `https://streaming.bitquery.io/graphql`, `Authorization: Bearer ${BITQUERY_TOKEN}`, network `robinhood`; queries: pons_v2 DEX trades by token, balances/holders API, trades by wallet. Queries unit-tested against canned response JSON (no live account yet); README marks live verification pending.

- [x] Step 1: write canned responses; failing tests mapping cube rows → Trade/TokenActivity identical shape to rpc provider.
- [x] Step 2: implement; green; `pickProvider` honors `--provider` flag and BITQUERY_TOKEN env; startup warning in mode A ("wallet profiles disabled"). Commit `providers: bitquery implementation`. **M3 done (live parity check pending token).**

### Task 13: winrate + badges (M4)

**Files:**
- Create: `lib/profile/winrate.ts`, `lib/profile/badges.ts`, `lib/profile/config.ts`
- Test: `test/winrate.test.mjs`, `test/badges.test.mjs`

**Interfaces:**
- Produces:
```ts
export function winrate(trades: number, wins: number): number | null; // null when trades < 2; else wins/(trades+1)*100
export const BADGE_CONFIG = { smart: { avgPnlPct: 25, winrate: 55, trades: 30 }, rich: { realizedEth: 5, balanceEth: 10 } };
export function badges(p: { trades; avgPnlPerTrade; winrate; realizedTotalEth; balanceEth }): ("smart" | "rich")[];
```
- [x] Step 1: failing tests — all six §3.5 examples to one decimal (33.3, 25.0, 50.0, 20.0, 40.0, 59.4); trades 0/1 → null; badge boundaries (>= semantics, trades=29 never smart).
- [x] Step 2: implement; green; commit `profile: winrate and badges`.

### Task 14: wallet profile + progressive check (M4)

**Files:**
- Create: `lib/profile/profile.ts`, `lib/read/wallet.ts`, `lib/check.ts`
- Modify: `bin/appname.mjs`, `lib/format.ts`

**Interfaces:**
- Produces:
```ts
// profile.ts
export interface Profile { wallet; trades: number; wins: number; avgPnlPerTrade: number | null; winrate: number | null; realizedTotalEth: number; balanceEth: number; badges: string[]; notRead?: boolean }
export function buildProfile(byToken: Map<string, Trade[]>, balances, prices): Profile  // pure
// read/wallet.ts: fetch via provider.walletTrades + cache.profile (24h TTL)
// check.ts — THE library entry
export type Phase = { phase: 1; snapshot; groups; aggregates; header } | { phase: 2; profiles: Map<string, Profile>; aggregates: Aggregates };
export async function* check(provider, cache, query, opts: { top: number; profiles: boolean; profileDeadlineMs: 60_000 }): AsyncIterable<Phase>
// phase 2: top-N + aggregate wallets concurrently through profile cache; deadline → notRead
```
- [x] Step 1: pure buildProfile tests on synthetic trade maps (closed positions only count; realized total; balance).
- [x] Step 2: implement check.ts two-phase iterator; CLI prints phase 1 immediately, appends phase 2 (updated winrate aggregates, top-holder profile columns, badges, exited line); `wallet` command mode B; mode A prints the disabled warning.
- [x] Step 3: `wallet` repeat from cache under 1s (measured). Commit `check: progressive two-phase output, wallet profiles`. **M4 done.**

### Task 15: fixtures + demo + CLI tests (M5)

**Files:**
- Create: `scripts/snapshot-fixture.mjs`, `test/fixtures/<three tokens>/*.json`, `lib/demo.ts`
- Test: `test/demo.test.mjs`, extend `test/cli.test.mjs`

- [x] Step 1: snapshot script — for a token address, dump meta + transfers + quotes + balances to JSON. Run on three real tokens (one on curve, one graduated, one with transfers/unknown_basis if findable).
- [x] Step 2: `demo` command — run the full pipeline on fixture data offline, output marked `DEMO`; test asserts DEMO marker and offline run.
- [x] Step 3: full-pipeline test on fixtures: groups/aggregates deterministic. Commit `demo: offline fixtures pipeline`.

### Task 16: README + polish (M5)

**Files:**
- Create: `README.md`, `LICENSE` (MIT), `.env.example`
- Modify: docs as needed

- [x] Step 1: README with all nine mandatory bullets from SPEC §9 + quickstart for modes A/B + honest limits table + `demo` first. `.env.example` with `BITQUERY_TOKEN=`, `RPC_URL=`, `ETH_USD=`.
- [x] Step 2: final sweep — `npm run typecheck && npm test` green, no-signer grep clean, `doctor` green live, push. Commit `docs: readme`. **M5 done.**

## Self-Review

- Spec coverage: §2 providers (T4/T12), §3.1 (T6), §3.2 filters (T2/T8), §3.3 (T5), §3.4 (T9), §3.5 (T13/T14), §3.6 (T10), §3.7 (T10), §4 cache/progressive/adaptive/parallel (T3/T7/T14), §5 layout+CI (T1), §6 CLI (T11/T14), §7 tests (T5,6,9,13,15), §8 milestones mapped, §9 README (T16). No gaps.
- Types consistent: Trade/Position/Provider defined once (T4/T5/T6), consumed later by name.
