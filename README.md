# Steam Market Buy Order Bot

A Node.js bot that places lowballed buy orders across liquid Counter-Strike 2 weapon skins, aiming for opportunistic fills to flip — not a "fair price" bot.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in your Steam username and a **base64-encoded** password (see the comment in `.env.example` for how to generate it — this is obfuscation, not real encryption, but avoids the literal password sitting as plaintext).
3. Run `npm run pick-items` to build the initial item pool (see below — this takes a while).

## Scripts

- `npm run pick-items` — scans the market for liquid weapon skins and ranks them by real trade volume ("better horses to bet on"), writing the result to `items.json`. **Slow** (15-20+ minutes) since it respects Steam's `priceoverview` rate limit. Only needs to run occasionally — see Cadence below.
- `npm run up` — logs in and places buy orders for the top `LIMIT` (currently 200) items in the pool that don't already have one, at `DISCOUNT_FACTOR` (currently 60%) of the current lowest price. Refreshes price/volume in `items.json` and logs every fetch to `priceHistory.jsonl` as it goes.
- `npm run down` — cancels all active buy orders and resets the placed-orders tracking.
- `npm run dry-run` — shows what `up` would place and the total capital commitment, using cached prices only (no live API calls, instant).

## Operational cadence

- **Weekly**: `npm run down` then `npm run up` — refreshes the active ~200 orders against current prices. Cancel-then-replace resets Steam's price/time queue priority, so this shouldn't be run more often than needed.
- **Monthly**: `npm run pick-items` — re-scans and re-ranks the full item pool. `up` only ever refreshes whichever items it actually selects each run, so anything sitting deeper in the pool stays as stale as the last full scan; this is what catches that drift.
- **Never run `pick-items` and `up`/`down` on the same day.** Each script paces its own requests safely on its own, but Steam's IP rate limit appears to be shared across all `steamcommunity.com` market endpoints (`priceoverview`, `createbuyorder`, `mylistings`, `search/render`) rather than siloed per-endpoint — hit this on 2026-09-27 when a `pick-items` run got banned mid-run despite pacing under ~13/min itself, because two `up` runs earlier that day had already used IP budget. One heavy script per day, full stop.

## How it works

1. `selectPilotItems.js` finds liquid weapon skins (excluding knives/gloves/cases/stickers) above a price floor, then ranks them by real recent sales volume (not just listing count, which favors oversupplied-but-unwanted items) — the goal is maximizing fill probability, not payoff size per fill.
2. `index.js` takes the top unplaced items from that ranked pool and places a buy order for each at a fixed discount off the current lowest price, with a hard safety guard that refuses any order that isn't strictly below the live lowest price.
3. `cancelAllBuyOrders.js` cancels everything in one pass when you want to refresh.

## Security

- Credentials load from `.env` (gitignored); the password is base64-encoded, not plaintext.
- Steam Guard 2FA is entered interactively at login — there's no stored TOTP secret.

## Disclaimer

Use at your own risk. Steam TOS prohibits automated market tools; this may lead to bans.
