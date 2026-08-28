const { login, community } = require('./auth');
const { getPriceOverview, createBuyOrder } = require('./market');
const items = require('./items.json');

async function processItem(item) {
	const data = await getPriceOverview(item.appid, item.market_hash_name);
	if (!data.success) {
		console.error(`Failed to get price for ${item.name}`);
		return;
	}

	const lowestPrice = parseFloat(data.lowest_price.replace(/[^0-9.]/g, ''));
	const buyPrice = lowestPrice * 0.70;
	const symbol = data.lowest_price.replace(/[\d\s.,]/g, '').trim();

	console.log(`[${item.name}]`);
	console.log(`  Lowest price: ${symbol}${lowestPrice.toFixed(2)}`);
	console.log(`  Buy order at: ${symbol}${buyPrice.toFixed(2)}`);

	const priceInSmallestUnit = Math.floor(buyPrice * 100);
	const lowestPriceInSmallestUnit = Math.round(lowestPrice * 100);

	// Hard safety check: never let a malformed price, a rounding edge case, or a
	// future change to the discount math result in an order at or above the
	// current lowest listing — this bot only lowballs, never buys at market price.
	if (!Number.isFinite(priceInSmallestUnit) || priceInSmallestUnit <= 0 || priceInSmallestUnit >= lowestPriceInSmallestUnit) {
		console.error(`  Refusing to place order: computed price (${priceInSmallestUnit}) is not a valid lowball below the lowest listing (${lowestPriceInSmallestUnit}).`);
		return;
	}

	console.log(`  Sending price_total: ${priceInSmallestUnit}`);
	await createBuyOrder(community, item.appid, item.market_hash_name, priceInSmallestUnit, item.quantity);
}

async function startBot() {
	await login();
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		console.log(`\n[${i + 1}/${items.length}]`);
		try {
			await processItem(item);
		} catch (err) {
			console.error(`  Failed: ${err.message}`);
		}
	}
	console.log(`\nDone — processed ${items.length} item(s).`);
}

startBot().catch(console.error);
