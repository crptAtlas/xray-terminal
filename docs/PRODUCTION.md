# Production wiring

How the shipped pieces become one live product, and what is needed from
the owner at each step. The engine (lib/) is done and chain-verified; the
site (app/) runs on design fixtures; this file is the bridge.

## The data path when everything is live

```
browser → /api/scan?token=0x…            (Next route, Vercel)
            └─ engine check() iterator   (lib/check.ts)
                 ├─ mode A: public RPC   (holders, pnl, bands, header, card)
                 └─ mode B: Bitquery     (adds: winrate, badges, wallet profiles)
```

1. `/api/scan` resolves the query (address directly; ticker via the
   launch index), then drives `check()` and streams stage events - the
   agent row on the site lights up from real engine stages, exactly like
   the CLI does today.
2. Phase 1 fills the token header, avg pnl, the pnl bands (the engine's
   `findGroups`: at most three, five points wide, supply-weighted - the
   same rule the design shows) and the holders table.
3. Phase 2 (mode B only) fills avg winrate, per-wallet profile columns
   and the SMART / RICH badges, under the profile deadline; wallets that
   miss it come back `not read`.
4. `/api/card` renders the same share card server-side with
   `@napi-rs/canvas` for OG unfurls on X and Telegram.
5. `/api/wallet` is the same story for one wallet (mode B only).

Vercel note: the engine's SQLite cache is per-instance and ephemeral
there. It still works (each warm lambda keeps its cache), but the
launch-ticker index and profile cache want a persistent volume
eventually - either a small VPS running `next start`, or a hosted
SQLite/libSQL. Not a launch blocker; addresses work without any cache.

## Badge and grade definitions (the engine's, already implemented)

- **SMART**: chain-wide record, mode B data: `trades >= 30` closed
  positions and `avg_pnl_per_trade >= +25%` and `winrate >= 55%`
  (winrate = wins / (trades + 1)). Thresholds in `lib/profile/badges.ts`.
- **RICH**: `realized profit >= 5 ETH` total, or current wallet value
  `>= 10 ETH` (ETH + open positions at last trade price).
- **WHALE** (site fixture rule, to be kept when wiring): holds `>= 1%`
  of supply.
- **Grade**: healthy = supply-weighted avg pnl above zero and most
  current holders in profit; shattered = most underwater or the token is
  dead (under 10 current holders); cracked = the middle.
  Thresholds in `lib/grade.ts`.

## What the owner needs to provide

| # | Item | Unlocks | Where it goes |
|---|---|---|---|
| 1 | `BITQUERY_TOKEN` (plan from $49/mo, bitquery.io) | winrate, SMART/RICH badges, wallet page, tracer stage - everything mode B | Vercel env var + `.env` locally |
| 2 | Domain (e.g. buy the one you want, point it at Vercel) | real URL instead of xray-xi-puce.vercel.app, OG links | Vercel → Domains |
| 3 | Official $XRAY CA + pool address | OFFICIAL CA section, GeckoTerminal chart embed | `components/ca-block.tsx`, `CHART_URL` in `app/page.tsx` |
| 4 | X / Telegram / public GitHub links | header and footer links | `components/header.tsx`, `components/footer.tsx` |
| 5 | (optional) Telegram bot token from @BotFather | the Telegram bot | bot host env |
| 6 | (optional) a small VPS or hosted SQLite | persistent cache, instant repeats for everyone | replaces Vercel functions for /api |

Nothing else. No keys, no signer, nothing that can spend.

## Telegram bot (when wanted)

Same shape as the other terminals: the bot holds zero logic. It calls
the engine's local JSON API and formats the answer.

- `/check <ca|ticker>` - runs a scan, replies with the share card PNG
  and the text verdict (avg pnl, bands, grade), buttons: open in
  terminal, recheck.
- `/wallet <address>` - mode B profile: avg pnl / trade, winrate,
  closed trades, badges.
- `/watch <ca>` - re-checks every N minutes, messages when the grade
  changes band.
- Deployment: `xray serve`-style local API + a python aiogram 3 process
  next to it; one docker-compose on the same VPS as the cache.

Needed to build it: nothing beyond items 1 and 5 above.

## Remaining site milestones (design prompt)

- M3: `/api/card` OG route (server canvas) + `generateMetadata` on
  `/terminal?token=…`.
- M4: home page walk-and-talk agent animation (`spawn()` port).
- M5: `/holders` page.
- M6: mobile pass, `prefers-reduced-motion`, metadata, domain.
- Engine wiring: swap fixture routes for `check()` (this file, top).
