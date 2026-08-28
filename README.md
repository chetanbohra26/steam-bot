# Steam Market Buy Order Bot

A Node.js bot to place and manage buy orders on the Steam Community Market.

## Setup

1. Install dependencies: `npm install`
2. Edit `.env` with your Steam credentials.
3. Edit `items.json` with the items you want to place orders for.
4. Run: `npm start`

## Features

- Places buy orders for a static list of items.
- Monitors prices and cancels/re-places orders if a better price is available.

## Security

- Use environment variables for credentials.
- Enable Steam Guard and use shared secret for 2FA.

## Disclaimer

Use at your own risk. Steam TOS prohibits automated tools; this may lead to bans.
