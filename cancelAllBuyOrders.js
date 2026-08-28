const { login } = require('./auth');
const { getMyBuyOrderIds, cancelBuyOrder } = require('./market');

const DELAY_BETWEEN_CANCELS_MS = 1500;

async function main() {
	await login();

	const ids = await getMyBuyOrderIds();
	console.log(`Found ${ids.length} active buy order(s).`);

	for (const id of ids) {
		try {
			await cancelBuyOrder(id);
			console.log(`Cancelled buy order ${id}`);
		} catch (err) {
			console.error(`Failed to cancel buy order ${id}:`, err.message);
		}
		await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_CANCELS_MS));
	}

	console.log('Done.');
}

main().catch(console.error);
