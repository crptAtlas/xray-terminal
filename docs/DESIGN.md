# Design decisions

Decisions made on top of `SPEC.md` where the spec is silent or collides
with measured chain behavior. Everything else follows the spec verbatim.

## Repository

- Private repo, placeholder name `APPNAME` throughout code and CLI per
  the spec; the binary is `appname` until the product name lands. A
  single rename commit swaps it later.
- Language: code, comments, docs, commits - English.
- Stack: TypeScript, Node >= 20, ESM. Runtime deps: `viem`, `commander`,
  `better-sqlite3`. Dev deps: `tsx`, `typescript`, `@types/node`,
  `@types/better-sqlite3`. Tests: `node --test`, no frameworks.

## RPC behavior (measured, not assumed)

The official RPC (`rpc.mainnet.chain.robinhood.com`) rate-limits above
roughly eight concurrent calls (HTTP 429), meters `eth_getLogs` more
tightly than `eth_call` and dislikes JSON-RPC batching. Therefore:

- All requests go through a single gate: bounded concurrency, minimum
  spacing (tighter for `eth_getLogs`), process-wide cooldown after a
  429, per-endpoint penalty box.
- Spec §4.6 "batch JSON-RPC" is implemented as **multicall3**
  (`0xcA11bde05977b3631167028862bE2a173976CA11`) for balance reads, not
  as raw JSON-RPC batches.
- A second endpoint, `https://robinhood-rpc.publicnode.com`, serves
  state reads (`eth_call`, `eth_getBalance`); it refuses `eth_getLogs`,
  so log reads stay on the official endpoint. `RPC_URL` (comma-separated
  list, `#nologs` suffix supported) overrides the defaults.

## ETH/USD rate (mode A)

The chain has no reliable on-chain USD oracle. Dollar figures (dust
filter, mcap, liquidity, volume) use one keyless GET to the Coinbase
spot API (`api.coinbase.com/v2/prices/ETH-USD/spot`), cached for 5
minutes. `ETH_USD` env var overrides it (also the offline/demo path).
This is the only external source besides the RPC and is stated in the
README.

## Ticker lookup (mode A)

An incremental SQLite index of factory launches (block, token address,
symbol, curve address). The first ticker query builds it; later queries
extend it from the last indexed block. Address queries never touch it.

## Definitions the spec leaves open

- **win**: a closed position (remaining == 0) with `pnl > 0`.
- **Group clustering**: sort holders by `pnl_pct`; slide a window of
  width <= 5 percentage points; score each window by supply share held;
  pick up to three non-overlapping windows greedily by score. A window
  is a "dense cluster" only if it holds >= 2 wallets.
- **Zero-cost guard**: `pnl_pct` is undefined when `bought_cost == 0`;
  such wallets are exactly the `unknown_basis` set (bought nothing but
  hold tokens).
- **Progressive output**: the library exposes
  `check(token): AsyncIterable<Phase>` yielding `phase 1` (header,
  positions, groups, aggregates) then `phase 2` (profiles, badges,
  exited stats). The CLI prints phase 1 immediately and appends phase 2.
  Profile phase deadline: 60s default, `--no-profiles` skips it;
  wallets that miss the deadline are marked `not read`.

## Cache schema (SQLite, one file)

```
meta(key, value)                          schema version
tokens(address PK, symbol, curve, created_block, synced_block, ...)
trades(token, wallet, block, kind, tokens, eth, tx)   raw classified trades
launches(block, token, symbol, curve)     ticker index
profiles(wallet PK, json, fetched_at)     global, 24h TTL
```

Token repeat = read trades from SQLite + getLogs from `synced_block + 1`.

## Bitquery (mode B)

Written against Bitquery's documented EAP schema for network `robinhood`
(`streaming.bitquery.io/graphql`, Bearer token from `BITQUERY_TOKEN`).
No live account exists yet, so mode B ships behind the same provider
interface with its queries unit-tested on canned responses; the README
marks live verification of mode B as pending. No token in the repo,
ever; env only.

## CI

GitHub Actions: `typecheck`, `test` and `no-signer` - greps `lib/` and
`bin/` for `PRIVATE_KEY`, `privateKeyToAccount`, `signTransaction`,
`sendTransaction`, `writeContract`, `walletClient`, `signMessage`; any
match fails the build.
