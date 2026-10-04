# Steam Market Buy Order Bot

A Node.js bot that places lowballed buy orders across liquid Counter-Strike 2 weapon skins, aiming for opportunistic fills to flip — not a "fair price" bot.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in your Steam username and a **base64-encoded** password (see the comment in `.env.example` for how to generate it — this is obfuscation, not real encryption, but avoids the literal password sitting as plaintext).
3. Run `npm run pick-items` to build the initial item pool (see below — this takes a while).

## Scripts

- `npm run pick-items` — full refresh: scans the market for liquid weapon skins and ranks them by real trade volume ("better horses to bet on"), rebuilding `items.json` from scratch. **Slow** (~90 minutes for ~750 candidates at the current 7s pacing; stage 2 prints an upfront estimate, then one log line per item with price, change vs. the pool's cached price, median price, volume and a live ETA) and the heaviest script — hundreds of `priceoverview` calls. Rediscovers candidates and re-ranks by volume; see Cadence below. If Steam rate-limits it, it stops on the first error, saves progress to `pickItemsCache.json`, leaves `items.json` untouched, and exits with code 1 — re-run after the ban clears (hours) to resume.
- `npm run pick-items-priceonly` (`--price-only`) — fast, cheap price refresh: re-scans just stage 1 (~1 minute, ~12 requests) and updates `items.json`'s cached prices for whatever's already in the pool, leaving volume untouched. Also writes `buyOrderAdjustments.json`, flagging any **active** buy order whose reference price moved 20%+ since the order was computed, with a suggested new bid — doesn't touch any order itself.
- `npm run up` — logs in and places buy orders for the top `LIMIT` items in the pool that don't already have one, fetching a live price per item and bidding `DISCOUNT_FACTOR` (currently 60%) of it. Refreshes price/volume in `items.json` and logs every fetch to `priceHistory.jsonl` as it goes.
- `npm run up-noprice` (`--cached`) — same placement logic as `up`, but uses `items.json`'s already-cached prices instead of live fetches. No `priceoverview` calls at all — ideal right after a `pick-items`/`pick-items-priceonly` run whose data is already fresh.
- `npm run down` — cancels all active buy orders (batched, paced conservatively) and, once verified empty, resets the placed-orders tracking.
- `npm run dry-run` — shows what `up` would place and the total capital commitment, using cached prices only (no live API calls, instant).

## Operational cadence

- **Nightly**: `npm run pick-items-priceonly` — cheap enough to run every night; catches fast price moves (e.g. a new-release skin crashing 30-50%+ in days) between full refreshes, and flags active orders worth reconsidering via `buyOrderAdjustments.json`.
- **Weekly**: `npm run down` then `npm run up` (or `up-noprice` if prices are already fresh that day) — refreshes active orders against current prices. Cancel-then-replace resets Steam's price/time queue priority, so this shouldn't be run more often than needed.
- **Weekly**: `npm run pick-items` — full rediscovery/re-ranking, to catch new product releases entering the liquid pool. **Must be on a different day than the `down`/`up` cadence above** (see rule below) — e.g. full `pick-items` early in the week, `down`/`up` later in the week.
- **Never run full `pick-items` and a live `up`/`down` on the same day.** Each script paces its own requests safely on its own, but Steam's IP rate limit appears to be shared across all `steamcommunity.com` market endpoints (`priceoverview`, `createbuyorder`, `mylistings`, `search/render`) rather than siloed per-endpoint — hit this on 2026-09-27 when a `pick-items` run got banned mid-run despite pacing under ~13/min itself, because two `up` runs earlier that day had already used IP budget. `pick-items-priceonly` is cheap enough (~12 requests) that it's fine on the same day as anything else, including full `pick-items` or a live `up`/`down` — just don't run it concurrently with another script that's also mid-run (same-IP collision, not a same-day one).
- **Keep `priceoverview` under ~500 calls per hour.** A second ban (2026-10-03) hit at ~585 calls in ~62 minutes, even with nothing else running that day, while 535 calls in ~56 minutes (2026-09-28) was fine — so the limit looks like a per-hour count, not a per-minute rate. Pick-items stage 2 is paced at 7s (~490 calls/hour) for that reason. This is inferred from a few runs, not documented by Valve.

## How it works

1. `selectPilotItems.js` finds liquid weapon skins (excluding knives/gloves/cases/stickers) above a price floor, then ranks them by real recent sales volume (not just listing count, which favors oversupplied-but-unwanted items) — the goal is maximizing fill probability, not payoff size per fill.
2. `index.js` takes the top unplaced items from that ranked pool and places a buy order for each at a fixed discount off the current lowest price, with a hard safety guard that refuses any order that isn't strictly below the live lowest price.
3. `cancelAllBuyOrders.js` cancels everything in one pass when you want to refresh.

## Security

- Credentials load from `.env` (gitignored); the password is base64-encoded, not plaintext.
- Steam Guard 2FA is entered interactively at login — there's no stored TOTP secret.

## Disclaimer

Use at your own risk. Steam TOS prohibits automated market tools; this may lead to bans.
