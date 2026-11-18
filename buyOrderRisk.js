const fs = require('fs');
const { getMyBuyOrders, cancelBuyOrder } = require('./market');
const { formatDuration, progressSuffix } = require('./progress');

const BATCH_SIZE = 5;
const DELAY_BETWEEN_BATCHES_MS = 3000; // matches cancelAllBuyOrders.js's shared per-IP rate limit cushion
const PLACED_ORDERS_FILE = './placedOrders.json';
const ORDER_BIDS_FILE = './orderBids.json';
const DISCOUNT_FACTOR = 0.60; // matches index.js
const NOTABLE_PCT_CHANGE = 20; // matches selectPilotItems.js's buyOrderAdjustments.json threshold

function loadOrderBids() {
	if (!fs.existsSync(ORDER_BIDS_FILE)) return {};
	try {
		return JSON.parse(fs.readFileSync(ORDER_BIDS_FILE, 'utf8'));
	} catch {
		return {};
	}
}

function loadJsonSet(file) {
	if (!fs.existsSync(file)) return null;
	try {
		return new Set(JSON.parse(fs.readFileSync(file, 'utf8')));
	} catch {
		return null;
	}
}

function loadJsonObject(file) {
	if (!fs.existsSync(file)) return null;
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return null;
	}
}

function chunk(array, size) {
	const chunks = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

// Each order is bid at ~60% of the market price when it was placed (the reference
// price). If the live price later falls more than 20% below that reference, the 7-day
// resale hold plus Steam's cut mean this order risks turning into a loss (or another
// dip during the hold could push it there) — that's the risk being guarded against
// here, not the bid being "too close" to market in the other direction. A price rise
// is never flagged: that only widens the safety margin.
//
// orderBids.json has the real reference price per order (written by index.js when it
// placed the order), but may not exist or may be missing an entry (e.g. orders placed
// from another environment). Falls back to deriving the reference from the live bid
// itself (bid / DISCOUNT_FACTOR) in that case.
async function findRiskyOrders(allItems) {
	const orders = await getMyBuyOrders();
	const priceByName = new Map(allItems.map((item) => [item.market_hash_name, item.price_paise]));
	const orderBids = loadOrderBids();

	const risky = [];
	const unmatched = [];
	for (const order of orders) {
		const current = priceByName.get(order.name);
		if (current === undefined) {
			unmatched.push(order);
			continue;
		}
		const record = orderBids[order.name];
		const refPrice = record?.ref_price_paise ?? order.bidPaise / DISCOUNT_FACTOR;
		const pctChange = ((current - refPrice) / refPrice) * 100;
		if (pctChange <= -NOTABLE_PCT_CHANGE) {
			risky.push({ ...order, current, refPrice, pctChange, baseline: record ? 'recorded at placement' : 'derived from bid' });
		}
	}
	risky.sort((a, b) => a.pctChange - b.pctChange);
	return { risky, unmatched, totalOrders: orders.length };
}

// Cancels every order in `risky` (as returned by findRiskyOrders) and removes it from
// placedOrders.json/orderBids.json if those files exist. Caller must already be logged in.
async function cancelRiskyOrders(risky) {
	const batches = chunk(risky, BATCH_SIZE);
	let cancelled = 0;
	let failed = 0;
	const startedAt = Date.now();
	const cancelledNames = [];

	for (let b = 0; b < batches.length; b++) {
		const batch = batches[b];
		const results = await Promise.allSettled(batch.map((o) => cancelBuyOrder(o.id)));

		results.forEach((result, i) => {
			const order = batch[i];
			if (result.status === 'fulfilled') {
				console.log(`Cancelled buy order ${order.id} (${order.name})`);
				cancelledNames.push(order.name);
				cancelled++;
			} else {
				console.error(`Failed to cancel buy order ${order.id} (${order.name}):`, result.reason.message);
				failed++;
			}
		});

		console.log(`  [batch ${b + 1}/${batches.length}] ${cancelled + failed}/${risky.length} processed | ${progressSuffix(startedAt, b + 1, batches.length)}`);
		if (b < batches.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
		}
	}

	console.log(`Done in ${formatDuration(Date.now() - startedAt)} — ${cancelled} cancelled, ${failed} failed, out of ${risky.length}.`);

	// Best-effort: these local tracking files may not exist in every environment (e.g. if
	// orders were placed from elsewhere), so only touch them if present, same as
	// cancelAllBuyOrders.js's approach for the full-wipe case.
	const placedOrders = loadJsonSet(PLACED_ORDERS_FILE);
	if (placedOrders) {
		for (const name of cancelledNames) placedOrders.delete(name);
		fs.writeFileSync(PLACED_ORDERS_FILE, JSON.stringify([...placedOrders], null, '\t'));
	}
	const orderBidsFile = loadJsonObject(ORDER_BIDS_FILE);
	if (orderBidsFile) {
		for (const name of cancelledNames) delete orderBidsFile[name];
		fs.writeFileSync(ORDER_BIDS_FILE, JSON.stringify(orderBidsFile, null, '\t'));
	}

	return { cancelled, failed };
}

module.exports = { DISCOUNT_FACTOR, NOTABLE_PCT_CHANGE, BATCH_SIZE, DELAY_BETWEEN_BATCHES_MS, findRiskyOrders, cancelRiskyOrders };
