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
	console.log(`  Sending price_total: ${priceInSmallestUnit}`);
	await createBuyOrder(community, item.appid, item.market_hash_name, priceInSmallestUnit, item.quantity);
}

async function startBot() {
	await login();
	for (const item of items) {
		await processItem(item);
	}
}

startBot().catch(console.error);
