# APPNAME

Holder PnL terminal for Pons V2 tokens on Robinhood Chain (chain id 4663).
Give it a token address and it answers one question: **who is holding this
token and how much has each of them made or lost.**

- PnL of every holder, one number each (realized + unrealized)
- token averages: avg PnL and avg winrate of its holders
- holders clustered into dense PnL groups
- per-wallet chain-wide stats: avg PnL per trade, winrate, badges
  (`[smart]`, `[rich]`)
- token header: mcap, liquidity, 24h volume, holders, age, phase

```
$ appname demo          # works offline, right now, no keys, marked DEMO
$ appname check <ca>    # live token breakdown
$ appname wallet <addr> # wallet profile (mode B only)
$ appname doctor        # verify addresses, topics and limits on the live chain
```

**This tool only reads.** It holds no keys, signs nothing and sends no
transactions - CI greps the source for signing code and fails the build if
any ever appears.

## Two ways to run it

### Mode A - free and slow (default)

Data source: the public RPC `https://rpc.mainnet.chain.robinhood.com`. No
keys, no registration. The limits are real: responses truncate at 10,000
logs and a request takes 1.6-3.2s regardless of size. A 1,000-holder token
computes in ~10-20s with parallel windows (40-70s single-threaded); repeats
are instant from the incremental cache.

Works in mode A: holder PnL per token, groups, token avg PnL, header.

Does **not** work in mode A: wallet-wide profiles (avg PnL and winrate
across all of a wallet's trades), `[smart]`/`[rich]` badges, token winrate.
Finding every trade of a wallet across the chain would mean scanning the
whole chain, so the CLI prints a warning and skips profiles.

### Mode B - paid and fast

Data source: [Bitquery](https://bitquery.io) (GraphQL, network
`robinhood`, plans from $49/mo). They index Pons: `CurveBuy`/`CurveSell`
arrive decoded, the same trades sit in the DEX cube as `pons_v2`, and
holder/balance APIs exist. Everything works in mode B.

```
export BITQUERY_TOKEN=...   # that's the whole setup
```

**30-day window:** the Bitquery trades cube keeps roughly the last 30
days; deeper history is a separate paid archive add-on. On a young chain
this barely matters, but a wallet's average PnL and winrate are computed
over its last month of trades.

**Status:** the mode B queries are written against Bitquery's documented
schema and pinned by tests on canned responses; live A/B parity
verification is pending an account token.

## Honest limitations

- **Transfers break cost basis.** If tokens arrived by transfer rather
  than purchase, the wallet's PnL cannot be computed honestly. Such
  wallets are flagged `unknown basis` and shown as a counter (wallets +
  supply share) - never guessed, never mixed into groups or averages.
- **Opening tax is not part of cost basis.** Wallets that bought in the
  first seconds of a launch paid the snipe tax; their PnL reads higher
  than their real outcome.
- **Winrate is penalized on purpose:** `winrate = wins / (trades + 1)`.
  One virtual losing trade in the denominator cuts a newcomer's
  percentage and dissolves for a veteran. Below two closed trades the
  winrate is not shown at all.
- Dust positions (balance worth under $50) are hidden and excluded from
  statistics. Dollar figures use one keyless request to a public ETH/USD
  spot API (override with `ETH_USD=...` for fully offline runs).

## Install

```
npm install
npm test            # offline, runs on bundled fixtures
npm run cli -- demo
```

Node >= 20. Dependencies: `viem`, `commander`, `better-sqlite3`.

## CLI

```
appname check <ca|ticker>   full token breakdown
appname wallet <address>    wallet profile, mode B only
appname doctor              verify source, addresses, limits
appname demo                offline breakdown on fixtures, marked DEMO
```

Flags: `--format text|json|markdown`, `--output <file>` (refuses to
overwrite), `--provider rpc|bitquery`, `--top <n>`, `--no-profiles`.

Tickers are not unique on Pons; when several launches share one, the CLI
lists them (address, launch block) and asks for the address. The first
ticker query builds a launch index (minutes); later queries extend it
incrementally (seconds).

## Library

`lib/check.ts` is the entry: an async iterator that yields phase 1
(header, holder PnL, groups, aggregates) as soon as it is ready and phase
2 (profiles, badges) when the wallet reads finish - a site or bot renders
progressively, same as the CLI. Data sources sit behind one interface
(`lib/providers/provider.ts`) with rpc and bitquery implementations; the
math in `lib/pnl/` and `lib/profile/` is pure functions covered by tests.

## Cache

SQLite at `~/.appname/cache.db`: per-token trade ledger with the last
synced block (repeats fetch only new blocks), the launch index for ticker
lookup and a global wallet-profile cache with a 24h TTL shared across
tokens.
