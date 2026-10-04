const fs = require('fs');
const { login, community } = require('./auth');
const { getPriceOverview, createBuyOrder } = require('./market');
const allItems = require('./items.json');

const LIMIT = 500; // pool currently has 365 qualified items (below this), so this effectively uses the whole pool; the run's own headroom-tracking will gracefully skip whatever doesn't fit the 10x-wallet budget
// Fraction of the current lowest price to bid. Lower = bigger safety cushion against
// price drift while an order sits unrefreshed between down/up cycles, but also lower
// fill probability (price has to drop further to reach the bid). 0.60 assumes roughly
// a weekly refresh cadence — revisit once real week-over-week drift data (from the
// price-cache refresh below) shows whether this cushion is over/under-sized.
const DISCOUNT_FACTOR = 0.60;
const PLACED_ORDERS_FILE = './placedOrders.json';
const PRICE_HISTORY_FILE = './priceHistory.jsonl';
// --cached: skip the live priceoverview fetch per item and buy off items.json's cached
// price/volume instead. Useful right after a pick-items run, whose data is already
// fresh — avoids stacking hundreds more priceoverview calls on the same IP the same day
// on top of what pick-items just made. createBuyOrder itself still hits the API per
// item, so pacing between items is unchanged either way.
const USE_CACHED_PRICES = process.argv.includes('--cached');

function loadPlacedOrders() {
	if (!fs.existsSync(PLACED_ORDERS_FILE)) return new Set();
	try {
		return new Set(JSON.parse(fs.readFileSync(PLACED_ORDERS_FILE, 'utf8')));
	} catch {
		return new Set();
	}
}

function savePlacedOrders(set) {
	fs.writeFileSync(PLACED_ORDERS_FILE, JSON.stringify([...set], null, '\t'));
}

function saveItemsPool() {
	fs.writeFileSync('./items.json', JSON.stringify(allItems, null, '\t') + '\n');
}

// Steam enforces a hard cap on total active buy-order value: 10x current wallet
// balance (confirmed verbatim in its own rejection message). Once we've hit that
// ceiling once, this extracts the exact current total and cap so we can skip further
// items that clearly won't fit, instead of wasting an attempt (and rate-limit budget)
// on each one to find out.
function parseWalletCeilingError(message) {
	const match = message.match(/currently have ₹\s*([\d,]+\.\d+) of active orders and you can have at most ₹\s*([\d,]+\.\d+)/);
	if (!match) return null;
	const current = parseFloat(match[1].replace(/,/g, ''));
	const ceiling = parseFloat(match[2].replace(/,/g, ''));
	return { currentPaise: Math.round(current * 100), ceilingPaise: Math.round(ceiling * 100) };
}

// Append-only log of every live price+volume fetch, one JSON object per line (JSON
// Lines) — unlike items.json's fields, which just get overwritten, this keeps every
// past value so week-over-week drift can actually be measured later instead of guessed at.
function appendPriceHistory(item, pricePaise, volume) {
	const record = { ts: new Date().toISOString(), market_hash_name: item.market_hash_name, price_paise: pricePaise, volume };
	fs.appendFileSync(PRICE_HISTORY_FILE, JSON.stringify(record) + '\n');
}

// items.json is a broader pool (currently up to 1000), already ranked by real trade
// volume (highest first) by selectPilotItems.js — the "better horses to bet on"
// ranking. Each run places orders for the LIMIT highest-ranked ones NOT already placed
// by a previous run, preserving that rank order, rather than re-sorting by price:
// fill-probability is the priority here, not affordability.
const placedOrders = loadPlacedOrders();
const items = allItems.filter((item) => !placedOrders.has(item.market_hash_name)).slice(0, LIMIT);

async function processItem(item) {
	let lowestPriceInSmallestUnit, volume;

	if (USE_CACHED_PRICES) {
		if (!Number.isFinite(item.price_paise) || item.price_paise <= 0) {
			console.error(`Skipping ${item.name}: no usable cached price.`);
			return false;
		}
		lowestPriceInSmallestUnit = item.price_paise;
		volume = item.volume ?? 0;
		console.log(`[${item.name}] (cached — no live fetch)`);
		console.log(`  Cached lowest price: ₹${(lowestPriceInSmallestUnit / 100).toFixed(2)}`);
		console.log(`  Volume: ${volume}`);
	} else {
		const data = await getPriceOverview(item.appid, item.market_hash_name);
		if (!data.success) {
			console.error(`Failed to get price for ${item.name}`);
			return false;
		}

		const lowestPrice = parseFloat(data.lowest_price.replace(/[^0-9.]/g, ''));
		const symbol = data.lowest_price.replace(/[\d\s.,]/g, '').trim();
		volume = data.volume ? parseInt(String(data.volume).replace(/,/g, ''), 10) : 0;
		lowestPriceInSmallestUnit = Math.round(lowestPrice * 100);

		console.log(`[${item.name}]`);
		console.log(`  Lowest price: ${symbol}${lowestPrice.toFixed(2)}`);
		console.log(`  Volume: ${volume}`);

		// Log this fetch to history (every time, not just on change, so the series reflects
		// actual sampling points), and refresh the pool's cached price/volume so items.json
		// stays current from real usage instead of only from whenever pick-items last ran.
		appendPriceHistory(item, lowestPriceInSmallestUnit, volume);
		if (item.price_paise !== lowestPriceInSmallestUnit || item.volume !== volume) {
			item.price_paise = lowestPriceInSmallestUnit;
			item.volume = volume;
			saveItemsPool();
		}
	}

	const priceInSmallestUnit = Math.floor(lowestPriceInSmallestUnit * DISCOUNT_FACTOR);
	console.log(`  Buy order at: ₹${(priceInSmallestUnit / 100).toFixed(2)}`);

	// Hard safety check: never let a malformed price, a rounding edge case, or a
	// future change to the discount math result in an order at or above the
	// current lowest listing — this bot only lowballs, never buys at market price.
	if (!Number.isFinite(priceInSmallestUnit) || priceInSmallestUnit <= 0 || priceInSmallestUnit >= lowestPriceInSmallestUnit) {
		console.error(`  Refusing to place order: computed price (${priceInSmallestUnit}) is not a valid lowball below the lowest listing (${lowestPriceInSmallestUnit}).`);
		return false;
	}

	console.log(`  Sending price_total: ${priceInSmallestUnit}`);
	await createBuyOrder(community, item.appid, item.market_hash_name, priceInSmallestUnit, item.quantity);
	return priceInSmallestUnit;
}

async function startBot() {
	await login();
	console.log(`Pool: ${allItems.length} item(s), ${placedOrders.size} already placed. Processing the top ${items.length} unplaced by trade volume.`);

	let knownHeadroomPaise = Infinity; // set once we've actually hit the 10x-wallet ceiling
	let skippedForBudget = 0;
	let stoppedForRateLimit = false;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		console.log(`\n[${i + 1}/${items.length}]`);

		// Once we know the remaining headroom, skip items whose cached price already
		// won't fit, without spending an API call/rate-limit budget to find out live.
		const estimatedBuyPaise = Math.floor((item.price_paise ?? Infinity) * DISCOUNT_FACTOR);
		if (estimatedBuyPaise >= knownHeadroomPaise) {
			console.log(`  Skipping ${item.name}: estimated ₹${(estimatedBuyPaise / 100).toFixed(2)} exceeds known active-orders headroom of ₹${(knownHeadroomPaise / 100).toFixed(2)}.`);
			skippedForBudget++;
			continue;
		}

		try {
			const placedPricePaise = await processItem(item);
			if (placedPricePaise) {
				placedOrders.add(item.market_hash_name);
				savePlacedOrders(placedOrders);
				if (knownHeadroomPaise !== Infinity) {
					knownHeadroomPaise -= placedPricePaise; // actual price paid, not the cached estimate
				}
			}
		} catch (err) {
			console.error(`  Failed: ${err.message}`);
			// Calling on while banned extends the ban; placedOrders.json is already saved per success.
			if (err.message.includes('rate-limited')) {
				stoppedForRateLimit = true;
				break;
			}
			const ceilingInfo = parseWalletCeilingError(err.message);
			if (ceilingInfo) {
				knownHeadroomPaise = ceilingInfo.ceilingPaise - ceilingInfo.currentPaise;
				console.log(`  Active-orders ceiling hit: ₹${(ceilingInfo.currentPaise / 100).toFixed(2)} / ₹${(ceilingInfo.ceilingPaise / 100).toFixed(2)} committed, ₹${(knownHeadroomPaise / 100).toFixed(2)} headroom remaining.`);
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 6000)); // pace requests between items — see selectPilotItems.js's PRICEOVERVIEW_DELAY_MS comment: the real limit looks like a per-hour call count (~535-585 priceoverview calls), not a per-minute rate. 6s + createBuyOrder time per item keeps live up below that, but revisit if it ever hits a limit
	}
	if (stoppedForRateLimit) {
		console.error(`\nRate-limited — stopped early to avoid extending the ban. ${placedOrders.size} order(s) tracked as placed; re-run after the ban clears (hours) and already-placed items will be skipped.`);
		process.exitCode = 1;
		return;
	}
	console.log(`\nDone — processed ${items.length} item(s), ${skippedForBudget} skipped due to the active-orders ceiling.`);
}

startBot().catch(console.error);
