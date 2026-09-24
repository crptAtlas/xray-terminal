# Design decisions

Decisions made on top of `SPEC.md` where the spec is silent or collides
with measured chain behavior. Everything else follows the spec verbatim.

## Repository

- Private repo, placeholder name `xray` throughout code and CLI per
  the spec; the binary is `xray` until the product name lands. A
  single rename commit swaps it later.
- Language: code, comments, docs, commits - English.
- Stack: TypeScript, Node >= 20, ESM. Runtime deps: `viem`, `commander`,
  `better-sqlite3`, `@napi-rs/canvas` (share cards). Dev deps: `tsx`, `typescript`, `@types/node`,
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

## ETH/USD rate

The chain has no reliable on-chain USD oracle. Dollar figures (dust
filter, mcap, liquidity, volume) use one keyless GET to the Coinbase
spot API (`api.coinbase.com/v2/prices/ETH-USD/spot`), cached for 5
minutes. `ETH_USD` env var overrides it (also the offline/demo path).
This is the only external source besides the RPC and is stated in the
README.

## Ticker lookup

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
chain_trades(block, log_index PK, wallet, curve, token, kind, tokens, eth)
                                          the chain-wide trade index
wallet_positions(wallet, market PK, buy_tokens, buy_eth, sell_tokens,
                 sell_eth, trades, last_price, last_block)
                                          every trade folded into sums
launches(block, token, symbol, curve)     ticker index
curve_tokens(curve PK, token)             curve to token map
profiles(wallet PK, json, fetched_at)     global, 24h TTL, carries a ledger
```

Token repeat = read trades from SQLite + getLogs from `synced_block + 1`.

## The trade index

Two lanes fill `chain_trades`, each with its own span in `meta`:

- **curve** - `CurveBuy` and `CurveSell` over the whole chain, trader
  from the indexed topic.
- **v4** - post-graduation pool trades. The `Swap` event names no
  trader, so the trader comes from the token transfer between the wallet
  and the pool manager in the same transaction and the quote from the
  swap's other side. One swap serves both legs of an exchange, a trade
  can hop several pools and the protocol takes a leg of its own, so
  sides are claimed one at a time: exact leg matches first, then groups
  that include the fee leg, then a near match for cuts taken off the
  incoming side.

`xray index` backfills a lane (resumable, adaptive window under the
node's 10k-log cap), `xray follow` keeps both at the head, `repair-v4`
re-decodes a range in place after a decoder fix. A digger yields the
node to visitor scans through a flag file (`lib/scanflag.ts`) - the
node serves one IP strictly in order, so a backfill would otherwise put
every scan behind it.

## Folded positions

A position is four sums and a last price, never the trades that made
them, so every trade is folded into `wallet_positions` as it is indexed:
one row per wallet and market, where a market is the token for pool
trades and the curve for pre-graduation ones. Both reads that matter go
through it - a wallet's whole record for a profile, and every wallet's
record of one token for a scan - which is thirty thousand rows where the
raw trades run to a quarter of a million. `scripts/build-positions.mts`
folds an index that predates the table and hands over to the follower
when it reaches the tip; `scripts/verify-positions.mts` checks a token's
folded rows against its trades, wallet by wallet.

Raw trades stay for the window that needs trade by trade detail: the
last day, which is where 24h volume and the market price come from.

## Wallet ledger

A profile is not a replay. Per token the ledger keeps bought tokens,
bought cost, sold tokens, sold proceeds and the last price, plus the
block the wallet is synced to. New trades are added to those sums, so a
repeat scan folds only what happened since. Positions, closed trades,
avg pnl per trade and winrate derive from the sums.

## CI

GitHub Actions: `typecheck`, `test` and `no-signer` - greps `lib/` and
`bin/` for `PRIVATE_KEY`, `privateKeyToAccount`, `signTransaction`,
`sendTransaction`, `writeContract`, `walletClient`, `signMessage`; any
match fails the build.
