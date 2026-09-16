<p align="center">
  <img src="assets/brand/logo.png" alt="xray" width="180">
</p>

<p align="center">
  <a href="https://github.com/Skynet-inisghts/holder-pnl/actions"><img src="https://img.shields.io/badge/ci-passing-4ef07f" alt="ci"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-9fd9ff" alt="node">
  <img src="https://img.shields.io/badge/chain-Robinhood%204663-cfe4f0" alt="chain">
  <img src="https://img.shields.io/badge/signing-none-ff5c5c" alt="no signing">
  <img src="https://img.shields.io/badge/license-MIT-5d7387" alt="mit">
</p>

<p align="center"><i>the terminal that shows who is actually in profit in a token</i></p>

Give xray a Pons V2 token on Robinhood Chain and it answers one question:
**who is holding this token and how much has each of them made or lost.**

```
$ xray demo          # works offline, right now, no keys, marked DEMO
$ xray check <ca>    # live token breakdown
$ xray wallet <addr> # wallet profile (mode B only)
$ xray doctor        # verify addresses, topics and limits on the live chain
```

## How it reads a token

Six agents, one per step of the pipeline. On the way to a verdict every
token passes through all of them:

| | agent | what it does |
|---|---|---|
| <img src="assets/brand/agent-scanner.png" width="48"> | **scanner** | pulling every trade of this token |
| <img src="assets/brand/agent-ledger.png" width="48"> | **ledger** | rebuilding each wallet's book: bought, sold, left |
| <img src="assets/brand/agent-tracer.png" width="48"> | **tracer** | following the same wallets across other tokens |
| <img src="assets/brand/agent-auditor.png" width="48"> | **auditor** | avg pnl and winrate, wallet by wallet |
| <img src="assets/brand/agent-sorter.png" width="48"> | **sorter** | splitting holders into groups |
| <img src="assets/brand/agent-flagger.png" width="48"> | **flagger** | dust, transfers in, first-ever trades |

## Grades

The state of the holder base, in one look:

| <img src="assets/brand/h-healthy.png" width="200"> | <img src="assets/brand/h-cracked.png" width="200"> | <img src="assets/brand/h-shattered.png" width="200"> |
|---|---|---|
| **healthy** - avg pnl above zero and most holders in profit | **cracked** - mixed picture | **shattered** - most holders underwater, or the token is dead |

The same skeleton goes on the share card (`--card <file.png>`), next to
the numbers. A token that fewer than 10 wallets still hold prints
`Token is dead. You're too early or too late` instead of averages.

## Start in one minute

```
npm install
npm test          # offline, runs on bundled fixtures
npm run cli -- demo
```

Node >= 20. Runtime deps: `viem`, `commander`, `better-sqlite3`,
`@napi-rs/canvas`.

**This tool only reads.** It holds no keys, signs nothing and sends no
transactions - CI greps the source for signing code and fails the build
if any ever appears.

## Live check

Two ways to run it, honestly different:

**Mode A - free and slow (default).** The public RPC
`https://rpc.mainnet.chain.robinhood.com`, no keys. Responses truncate at
10,000 logs and a request takes 1.6-3.2s regardless of size. A
1,000-holder token computes in ~10-20s with parallel windows; repeats are
instant from the incremental cache. Works: holder PnL, groups, token avg
PnL, header. Does not work: wallet-wide profiles, badges, token winrate -
the CLI prints a warning and skips them.

**Mode B - paid and fast.** [Bitquery](https://bitquery.io) (GraphQL,
network `robinhood`, plans from $49/mo): decoded Pons trades, holder and
balance APIs. Everything works.

```
export BITQUERY_TOKEN=...   # that's the whole setup
```

The Bitquery trades cube keeps roughly the last 30 days; a wallet's
averages are month-scoped. Mode B queries are pinned by tests on canned
responses; live A/B parity verification is pending an account token.

```
xray check <ca|ticker>   full token breakdown
xray wallet <address>    wallet profile, mode B only
xray doctor              verify source, addresses, limits
xray demo                offline breakdown on fixtures, marked DEMO
```

Flags: `--format text|json|markdown`, `--output <file>` (refuses to
overwrite), `--provider rpc|bitquery`, `--top <n>`, `--no-profiles`,
`--card <file.png>`.

Tickers are not unique on Pons; when several launches share one, the CLI
lists them and asks for the address. The first ticker query builds a
launch index (minutes); later queries extend it incrementally (seconds).

## Methodology

- **PnL per token, not per wallet balance:**
  `pnl = sold_proceeds + value_now - bought_cost`, realized and
  unrealized in one number. An ETH top-up between trades cannot leak in.
- **The trader is the token movement, never `tx.from`** - the signer is
  almost always a relayer.
- **Token averages are supply-weighted:** a wallet holding 5% of supply
  moves the average five times harder than one holding 1%. Wallets that
  exited hold nothing and get their own line instead.
- **Transfers break cost basis.** Such wallets are flagged
  `unknown basis` and counted, never guessed.
- **Opening tax is not part of cost basis** - first-second buyers show
  inflated PnL.
- **Winrate is penalized on purpose:** `wins / (trades + 1)`, hidden
  below two closed trades.
- **Groups:** at most three, each no wider than 5 percentage points,
  chosen to maximize the supply share inside.
- Dust (balance under $50) is hidden. Dollar figures use one keyless
  request to a public ETH/USD spot API (`ETH_USD=...` overrides it for
  fully offline runs).

## Project map

```
bin/xray.mjs           CLI entry
lib/
  chain.ts             chain constants, verified by doctor
  providers/           the source boundary: rpc (A) and bitquery (B)
  read/                token snapshot, holders, launches, wallets
  pnl/                 pure math: classify, position, groups, aggregate
  profile/             winrate, badges, wallet profile
  grade.ts             healthy / cracked / shattered
  card.ts              1080x1080 share card with the grade skeleton
  cache.ts             SQLite: token ledger, launch index, profiles
  format.ts            text / json / markdown
assets/brand/          sprites, fonts, generators (render_*.py)
test/                  node --test, offline on fixtures
```

The math in `lib/pnl/` and `lib/profile/` is pure functions with no
network access. Data sources sit behind one interface; everything above
it cannot tell mode A from mode B.

## Boundaries

- Read-only, forever: no keys, no signing, no transactions. A dedicated
  CI job enforces it.
- No external calls beyond the chain RPC (and one keyless ETH/USD spot
  request, override with `ETH_USD`).
- `demo` runs offline and requires nothing.
- Demo output is always marked `DEMO` - fixtures are never passed off as
  the live chain.
