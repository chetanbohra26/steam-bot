const { login } = require('./auth');
const { getMyBuyOrderIds, cancelBuyOrder } = require('./market');

const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES_MS = 1000;

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
}

main().catch(console.error);
