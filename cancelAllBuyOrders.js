const fs = require('fs');
const { login } = require('./auth');
const { getMyBuyOrderIds, cancelBuyOrder } = require('./market');

const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES_MS = 1000;
const PLACED_ORDERS_FILE = './placedOrders.json';

function chunk(array, size) {
	const chunks = [];
	for (let i = 0; i < array.length; i += size) {
		chunks.push(array.slice(i, i + size));
	}
	return chunks;
}

async function main() {
	await login();

	const ids = await getMyBuyOrderIds();
	console.log(`Found ${ids.length} active buy order(s).`);

	const batches = chunk(ids, BATCH_SIZE);
	let cancelled = 0;
	let failed = 0;

	for (let b = 0; b < batches.length; b++) {
		const batch = batches[b];
		const results = await Promise.allSettled(batch.map((id) => cancelBuyOrder(id)));

		results.forEach((result, i) => {
			if (result.status === 'fulfilled') {
				console.log(`Cancelled buy order ${batch[i]}`);
				cancelled++;
			} else {
				console.error(`Failed to cancel buy order ${batch[i]}:`, result.reason.message);
				failed++;
			}
		});

		if (b < batches.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_BATCHES_MS));
		}
	}

	console.log(`\nDone — ${cancelled} cancelled, ${failed} failed, out of ${ids.length}.`);

	// index.js tracks which items already have an order in placedOrders.json so it can
	// skip them on future runs. Since this cancels every active order, that tracking is
	// now stale — reset it, but only if every cancel actually succeeded, otherwise some
	// orders may still be live and we'd wrongly let index.js re-place duplicates for them.
	if (failed === 0) {
		fs.writeFileSync(PLACED_ORDERS_FILE, '[]');
		console.log('Cleared placedOrders.json (all orders cancelled).');
	} else {
		console.log('Some cancellations failed — leaving placedOrders.json as-is, it may be stale for those items.');
	}
}

main().catch(console.error);
