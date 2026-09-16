# SPEC: holder PnL terminal (Robinhood Chain)

Project name, ticker, branding, images and animations are intentionally absent
from this document. `APPNAME` is used as a placeholder wherever a name is
required in code.

Chain: Robinhood Chain, chain id 4663, Arbitrum Orbit, ~0.1s blocks,
~838,000 blocks per day. Launchpad: Pons V2.

---

## 1. What we are building

A CLI tool plus a library that, given a token address, answers one question:
**who is holding this token and how much has each of them made or lost**.

Output:

- PnL of every holder for this token, as a single number
- average PnL and average winrate of the holders; these double as the
  token's PnL and winrate
- holders broken into groups by PnL
- for each holder, their overall average PnL and winrate across all of
  their trades on the chain
- wallet badges: smart and rich
- token header: mcap, liquidity, 24h volume, holder count, age, phase

A website, bot and cards are out of scope for this spec. The library is
written so they can be added on top without rework.

---

## 2. Two ways to deploy

This is the key architectural decision and it must be visible to the user
in the README.

**Mode A, free and slow.** Data source: the public RPC
`https://rpc.mainnet.chain.robinhood.com`. No keys, no registration. It
works, but the limits are harsh: responses truncate at 10,000 logs; a
request takes 1.6-3.2 seconds regardless of size. A 1,000-holder token
takes 40-70 seconds single-threaded, 10-20 seconds with parallel windows.
Wallet profiles are unavailable in this mode: finding every trade of an
address across the chain would require scanning the whole chain.

Works in mode A: holder PnL per token, groups, token average PnL, header.
Does not work: wallet-wide average PnL and winrate, smart and rich badges,
token winrate.

**Mode B, paid and fast.** Source: Bitquery, GraphQL endpoint
`https://streaming.bitquery.io/graphql`, network `robinhood`. Plans start
at $49/month. They index Pons: `CurveBuy` and `CurveSell` events arrive
decoded, the same trades are available in the DEX trades cube as
`pons_v2` with USD prices and there are separate holder and balance
APIs.

Works in mode B: everything.

Important limitation, stated explicitly in the README: the trades cube
keeps roughly the last 30 days. Deeper history requires a separate paid
archive add-on. On a young chain this barely matters, but for a wallet it
means its average PnL is computed over one month of trades.

**Code requirement:** the data source is an interface with two
implementations. Everything above it is source-agnostic.

```
lib/providers/
  provider.ts        interface
  rpc.ts             implementation A
  bitquery.ts        implementation B
```

Source selection: environment variable. No `BITQUERY_TOKEN` means mode A,
and the CLI prints a startup warning that wallet profiles are disabled.

---

## 3. Formulas

This is the core. Everything lives in `lib/pnl/` and `lib/profile/`:
pure functions with no network access, covered by tests on fixtures.

### 3.1 Wallet PnL for a specific token

Computed per token, not per wallet balance; otherwise a wallet top-up
between trades would count as profit.

```
bought_tokens     total tokens bought
bought_cost       total ETH spent on those buys
sold_tokens       total tokens sold
sold_proceeds     total ETH received
remaining         current balance
price_now         current token price
value_now         remaining * price_now

pnl     = sold_proceeds + value_now - bought_cost
pnl_pct = pnl / bought_cost * 100
```

One number, realized and unrealized together.

Opening tax and fees are **not** included in cost basis.

Both curve trades and post-graduation pool trades count.

**Transfers.** If tokens arrived via transfer rather than purchase,
`bought_cost` does not cover them and PnL inflates. Such a wallet is
flagged `unknown_basis`, excluded from groups and averages and shown as
a counter: how many such wallets and how much supply they hold.

### 3.2 Who counts as a holder

Excluded:

- infrastructure: the token's curve, the pool, the locker, routers, the
  deployer, the creator-fee recipient, the zero address, the burn address
- dust: remaining balance worth less than $50 at the current price. Such
  wallets are not shown and not counted in statistics
- `unknown_basis`: counter only

Pons V2 addresses:

```
factory          0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e
router           0xe33e9e479df8802cb0866d5d05258bec4cf62948
hook             0xe5e702641ea86f4ae6cc3cdaed2b886f976be044
locker           0x267444d099b10fb5ed7c3cc7b7c767adca574952
v4 pool manager  0x8366a39cc670b4001a1121b8f6a443a643e40951
WETH             0x0bd7d308f8e1639fab988df18a8011f41eacad73
curve            its own contract per token
```

Topics:

```
Transfer   0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
CurveBuy   0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455
CurveSell  0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df
```

All addresses and topics are verified by the `doctor` command against the
live chain, never taken on faith.

### 3.3 Detecting buys and sells

**A trap to avoid from day one:** the transaction signer is almost always
a relayer, so the trader must never be identified via `tx.from`. The
trader is identified by token movement.

Rule: let `market` = the token's curve plus the pool plus the routers.

- token moved from `market` to a non-`market` address: a buy; the buyer
  is the recipient
- token moved from a non-`market` address into `market`: a sell; the
  seller is the sender
- both sides outside `market`: a transfer, not a trade

The ETH amount comes from the `CurveBuy` / `CurveSell` event for the
curve and from the Uniswap v4 swap event for the pool. In the v4 swap,
match the token side to the transfer amount and take the opposite side as
the quote. Fallback if the swap does not decode: the largest WETH
transfer in the same transaction.

### 3.4 Groups

Holders are split into groups by `pnl_pct`.

Requirement: **at most three groups per token, group width at most 5
percentage points**.

Algorithm:

1. sort holders by `pnl_pct`
2. find the three densest clusters no wider than 5 points, maximizing
   the share of supply inside the cluster
3. for each group output: PnL range, share of supply, share of holders,
   wallet count

Example output:

```
avg pnl +40%   avg winrate 65%
group 1   +12..17%   holds 15% of supply   58 wallets
group 2   -60..-65%  holds 11% of supply   34 wallets
group 3   +40..45%   holds  8% of supply   21 wallets
```

If there are fewer than three dense clusters, output as many as exist.
Holders outside groups stay ungrouped but still count toward averages.

### 3.5 Wallet profile (mode B only)

Take all of the wallet's trades across all tokens. A position in one
token is computed by formula 3.1. A position is closed when the remaining
balance is zero.

```
trades              number of closed positions
avg_pnl_per_trade   average pnl_pct over closed positions
winrate             by the formula below
realized_total      total realized profit in ETH
balance             wallet value: ETH plus tokens
```

**Winrate formula.** One virtual losing trade is added to the
denominator:

```
winrate = wins / (trades + 1)
```

Sanity checks:

```
trades=2   wins=1  ->  33%
trades=3   wins=1  ->  25%
trades=3   wins=2  ->  50%
trades=4   wins=1  ->  20%
trades=4   wins=2  ->  40%
trades=100 wins=60 ->  59.4%
```

It cuts a newcomer's percentage; it dissolves for a veteran.

**Rules by trade count:**

- `trades == 0`, this token is the wallet's first trade: PnL is computed
  and included in the token's average PnL; winrate is not computed and
  not included in the token's winrate; no badge possible; the summary
  shows a separate line "how many such wallets and how much supply they
  hold"
- `trades == 1`: PnL computed, winrate not shown, excluded from the
  token's winrate, no badge possible
- `trades >= 2`: winrate by the formula, included in aggregates
- `trades >= 30`: eligible for the smart badge

Badge thresholds live in config:

```
smart:  avg_pnl_per_trade >= 25  and  winrate >= 55  and  trades >= 30
rich:   realized_total >= 5 ETH  or   balance >= 10 ETH
```

### 3.6 Token aggregates

```
avg_pnl      supply-weighted mean pnl_pct over all current holders
             except dust, infra and unknown_basis
avg_winrate  supply-weighted mean winrate over current holders
             with trades >= 2
```

**Supply weighting.** A holder's contribution is proportional to the
share of supply they hold: a wallet with +15% PnL holding 1% of supply
and a wallet with -50% holding 5% average to (15*1 - 50*5) / 6 = -39%,
not to -17.5%. Exited wallets (share 0) do not steer the current
averages; they appear only in the `exited` line, which stays a plain
mean.

Next to `avg_winrate`, always print how many wallets it was computed
over.

Additionally: how many wallets exited completely, plus their average PnL
and winrate over their full history, as one line.

### 3.7 Header

```
mcap        supply * price_now
liquidity   ETH side of the pool or curve, times two, in dollars
volume24h   total trade volume over the last 24 hours
holders     everyone with a nonzero balance, before the dust filter
age         time since launch
phase       on the curve with fill percentage, or graduated
```

---

## 4. Performance and cache

**Measured facts for the public RPC:** response limit 10,000 logs; a
request answers in 1.6-3.2 seconds almost regardless of size; 0.103s
blocks; ~838,000 blocks/day; ~2,481 curve events per 2,000 blocks
chain-wide, i.e. on the order of a million trades per day.

**Requirements:**

1. **Progressive output.** Do not wait for the full computation. Token
   PnL and groups are computed first and returned immediately. Wallet
   profiles and badges are fetched afterwards and appended. In the CLI
   this is two output phases; in the library, an async iterator or a
   callback.

2. **Incremental token cache.** SQLite. Store the block up to which a
   token has been processed. On a repeat request, fetch only new blocks.
   A repeat must be instant.

3. **Global wallet-profile cache.** Keyed by address, 24h TTL, shared
   across all tokens. The same whale sits in dozens of tokens, so the
   cache pays for itself quickly and "first runs" speed up over time on
   their own.

4. **Parallelism with a deadline.** Log windows and profiles are read
   concurrently. A hard deadline on the profile phase: whoever misses it
   is marked `not read` instead of blocking the response.

5. **Adaptive getLogs window.** If the node complains about the range
   size, the window is split in half recursively.

6. **Request coalescing.** Multiple reads combined into one HTTP request
   where the node allows it (multicall for balances); otherwise single
   requests through a rate-aware gate.

Expected time for a 1,000-holder token:

```
mode A, cold:    40-70s single-threaded, 10-20s parallel
mode A, repeat:  instant from cache plus catch-up of new blocks
mode B, cold:    5-15s per token, plus 30-90s for profiles the first time
mode B, repeat:  seconds
```

---

## 5. Repository layout

```
bin/APPNAME.mjs             CLI entry point
lib/
  chain.ts                  chain definition, addresses, topics
  abi/                      factory, curve, pool, erc20
  providers/
    provider.ts             source interface
    rpc.ts                  public RPC
    bitquery.ts             Bitquery
  read/
    token.ts                token trades, balances, price, volume
    wallet.ts               wallet trades across all tokens
    holders.ts              holder list
  pnl/
    position.ts             formula 3.1
    classify.ts             buy/sell detection, 3.3
    groups.ts               clustering, 3.4
    aggregate.ts            aggregates, 3.6
  profile/
    profile.ts              wallet profile, 3.5
    winrate.ts              winrate formula
    badges.ts               thresholds, config
  cache.ts                  SQLite
  format.ts                 text, json, markdown output
test/
  fixtures/                 log snapshots of three real tokens
  *.test.mjs
docs/
```

TypeScript, Node 20+, ESM. Minimal dependencies: `viem`, `commander`, an
SQLite driver. Tests on `node --test`, no frameworks.

**Prohibition:** the repository contains no private keys, no signing, no
transaction sending - ever. A dedicated CI job greps `lib/` and `bin/`
for `PRIVATE_KEY`, `privateKeyToAccount`, `signTransaction`,
`sendTransaction`, `writeContract`, `walletClient`, `signMessage` and
fails the build on a match.

---

## 6. CLI

```
APPNAME check <ca|ticker>     full token breakdown
APPNAME wallet <address>      wallet profile, mode B only
APPNAME doctor                verify source, addresses, limits
APPNAME demo                  breakdown on fixtures, offline, marked DEMO
```

Flags: `--format text|json|markdown`, `--output <file>`,
`--provider rpc|bitquery`, `--top <n>`, `--no-profiles`. Export refuses
to overwrite an existing file.

Tickers are not unique. If several launches share a ticker, print a list
with age, mcap and holder count and ask for the address.

`check` output format:

```
$SYMBOL  0x...  age 3h 12m  phase curve 74%
mcap $1.2M   liquidity $340k   volume 24h $890k   holders 1 043

avg pnl  +40%        across 1 002 wallets
winrate   65%        across 784 wallets with 2+ trades

group 1   +12..17%   15% of supply   58 wallets
group 2   -60..-65%  11% of supply   34 wallets
group 3   +40..45%    8% of supply   21 wallets

top holders
  #1  0x1234..cdef   4.2% supply   pnl +180%   avg +34%/trade   61% wr   128 trades   [smart][rich]
  ...

exited      340 wallets, avg pnl +22%, avg winrate 58%
first trade  91 wallets hold 6.1% of supply
excluded    dust 412 wallets, unknown basis 14 wallets (3.1% supply), infra 6 addresses

source rpc   34 requests   18.2s
```

---

## 7. Tests

- `pnl/position`: buy, sell, partial sell, re-buy, a wallet top-up
  between trades does not affect PnL, a transfer flags `unknown_basis`
- `pnl/classify`: buy, sell, wallet-to-wallet transfer, relayed
  transaction
- `pnl/groups`: at most three groups, width at most 5 points, fewer than
  three clusters
- `profile/winrate`: all six examples from 3.5 match to one decimal
- `profile/badges`: threshold boundaries
- fixtures: three real tokens, log snapshots in the repo, tests run
  offline
- CLI: output formats, refusal to overwrite a file

---

## 8. Milestones

**M0.** Skeleton, `chain.ts`, provider interface, implementation A,
`doctor`, CI with the no-signing check. Done when `doctor` against the
live chain prints addresses and limits and everything is green.

**M1.** Token trade reading, classification, PnL formula, filters,
cache. Done when `check` on a live token matches a manual Blockscout
check on several wallets.

**M2.** Groups, aggregates, header, output formats. Done when the output
matches the sample in section 6.

**M3.** Implementation B on Bitquery, provider switching. Done when
`check` on the same token via A and via B produces the same numbers.

**M4.** Wallet profiles, winrate, badges, profile cache, progressive
output. Done when `wallet` on a known active wallet answers in under a
second from cache.

**M5.** Fixtures, `demo`, README, docs, repository polish.

---

## 9. README: mandatory content

- the two deployment modes, A and B, with an honest description of what
  A cannot do
- the 30-day window of the trades cube and what it means for wallets
- transfers break cost basis; such wallets are flagged, not guessed
- opening tax is not part of cost basis; first-second buyers show
  inflated PnL
- winrate is hidden at one trade and penalized from two trades up
- the tool only reads; it never touches keys and never signs anything
- the `demo` command works offline and requires nothing
