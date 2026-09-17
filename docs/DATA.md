# Data layer: measured facts

Results of the trial checklist from the data-layer plan, measured against
the live chain and the live Bitquery API. Date of measurement:
**2026-09-17**. Numbers drift; re-measure before trusting them a month on.

## 1. Coverage

- Network `robinhood` exists and is fresh (head lag observed: seconds).
- The `realtime` dataset reached back ~4.3 days at measurement time
  (oldest trade row: 2026-09-13). The 30-day figure from early planning
  was wrong for this plan tier; deeper history is the paid `archive`
  add-on (`combined` dataset - refused on the current plan).
- **Wallet histories do not need Bitquery at all.** The curve events
  index the real trader in their topics (`CurveBuy` topic2 = recipient,
  `CurveSell` topic1 = seller), and the public RPC serves logs from
  genesis. A local chain-wide trade index (`xray index`, resumable
  backfill into SQLite) makes every wallet's full history a local
  SELECT; a cheap tail sync before each scan keeps it at the head.
  Post-graduation v4 swaps carry no trader topic and are not part of
  profiles - the curve is where meme life happens.
- Node limits worth knowing: batched topic-alternative queries over the
  full range are unreliable above ~25-50 wallets (the node masks its
  log-query timeout as "Missing or invalid parameters"), which is why
  the index exists; narrow windows without an address filter answer
  consistently.
- Pons is indexed: protocol `pons_v2` (curve trades) and `uniswap_v4`
  (post-graduation) both appear in `DEXTradeByTokens` with native-ETH
  sides and USD prices. Token-paired launches (e.g. GOOGL pairs) appear
  with the pair token as the side; our ETH-based scan skips those.
- The opening tax is not a field in the trade cubes; the RPC path reads
  it from the `CurveBuy` event where needed.

## 2. Schema (as verified, not as documented)

- There is no `DEXTrades.Trade.Currency`; the per-token cube is
  `DEXTradeByTokens` with `Trade.Currency` + `Trade.Side`.
- `Transfers` carries `Transfer { Amount Sender Receiver Currency }`,
  filterable by `any: [{Sender in}, {Receiver in}]` - batching works.
- `BalanceUpdates` with `sum(of: BalanceUpdate_Amount)` gives balances;
  verified against on-chain multicall: exact for wallets, the pool
  manager lags by seconds.
- Pagination: `limit {count}` up to 25 000 plus `Block: {Number: {gt}}`
  cursor. `offset` is not used.
- Every query the code sends lives in `lib/providers/bitquery.ts` and is
  written against these verified shapes.

## 3. Trader attribution - the critical check

`Trade.Buyer` / `Trade.Seller` in the cubes are pool contracts and
relayers on this chain, NOT the trader. Attribution therefore never uses
them: the trader is derived from token `Transfers` (the same rule the
RPC engine uses), with the trade cubes joined per transaction only for
the ETH quote. Verified on live relayed buys: 3/3 transactions name the
same buyer through both channels.

## 4. Convergence (mode A vs mode B on one token)

Full replay of a live ~2 300-wallet token through both channels:

- wallets discovered: identical (2 303 = 2 303)
- wallet books equal within 0.1%: **2 256 / 2 303 (98.0%)**
- cost basis: exact after stripping `fee + tax` from `CurveBuy.quoteIn`
  (spec 3.1 says fees are not part of cost basis; the cubes report the
  clean amount, the RPC path now subtracts the event's fee fields)
- known remaining delta: curve-sell proceeds - the cube reports the
  swap amount before the protocol fee (~1-2% above the `quoteOut` the
  seller actually received; the cube has no fee field to subtract). The
  RPC channel is the accurate one here.
- edge wallets that differ (mint address, the deployer's launch buy that
  the cube does not index as a trade) are already excluded by the infra
  and unknown-basis filters, so they never reach the stats.

## 5. Cost in points

Requests per operation (measured):

- fast token scan (phase 1): 3-6 Bitquery requests + ~10 cheap RPC calls
- top-1000 profile phase, batched: ~10-60 requests depending on cache
  (100 wallets per transfer batch, 400 tx hashes per quote chunk)
- single wallet page: 2-4 requests

Points per request depend on returned rows; read the exact spend from
the Bitquery dashboard after a day of traffic (this needs the account
owner). Free-plan observation: the daily allowance died after roughly a
few hundred requests of mixed size.

## 6. Speed (measured)

```
cold scan, small token (~170 holders)      ~5 s to phase 1
cold scan, large token (47k trades)        ~14 s to phase 1
repeat scan                                1-3 s (incremental cache)
single wallet history                      0.6-3.5 s (direct topic query)
profile phase with the local trade index   seconds for the top 1000: one
                                           tail sync + local SELECTs +
                                           one balance multicall
profile phase without the index            direct topic queries, 25
                                           wallets per batch, flaky above
                                           that; the 24h cache fills in
                                           across repeat scans
index backfill (one-time, resumable)       windows of 40k blocks, 3 in
                                           flight; grows through empty
                                           pre-launchpad ranges
```

## 7. Limits and the queue

- Free plan: on the order of 10 requests/minute, then HTTP 429; the
  hourly/daily allowance can run out entirely.
- The client throttle (lib/providers/bitquery.ts): full speed until the
  first 429, then a process-wide queue with `BITQUERY_SPACING_MS`
  spacing (default 6500) for a 120 s cooldown; 429 retries with
  exponential backoff (4 attempts), 5xx retries (3 attempts).
- The profile phase fails fast after two consecutive dead batches and
  lets the cache finish the job on later scans; the UI says
  `wallet profiles unavailable - rate-limited` instead of showing zeros.

## Division of labor (unchanged from the plan)

Bitquery supplies raw material only: who, when, which token, which
direction, how much ETH, how many tokens, who holds how much. Every
formula - pnl, closed positions, winrate `wins/(trades+1)`, dust and
unknown-basis filters, bands, badges, grades, the insider exclusion
(the scanned token never feeds its own holders' shown stats; badges
still judge the full record) - is computed by our code and covered by
tests, so the provider can be swapped without touching the product.
