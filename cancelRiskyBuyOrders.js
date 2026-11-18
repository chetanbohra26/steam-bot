const { login } = require('./auth');
const { findRiskyOrders, cancelRiskyOrders, NOTABLE_PCT_CHANGE } = require('./buyOrderRisk');
const allItems = require('./items.json');

const EXECUTE = process.argv.includes('--execute'); // without this flag, the script only reports what it would cancel

async function main() {
	await login();

	const { risky, unmatched, totalOrders } = await findRiskyOrders(allItems);

	console.log(`${totalOrders} active buy order(s). Flagging drops of ${NOTABLE_PCT_CHANGE}%+ below each order's reference price.`);
	console.log(`${unmatched.length} order(s) are for items no longer in the pool — skipped, can't judge risk without a current price.`);
	console.log(`${risky.length} order(s) at risk:\n`);
	for (const r of risky) {
		console.log(
			`  ${r.name}: bid ₹${(r.bidPaise / 100).toFixed(2)} | ref ₹${(r.refPrice / 100).toFixed(2)} (${r.baseline}) | current ₹${(r.current / 100).toFixed(2)} (${r.pctChange.toFixed(1)}%) [${r.id}]`,
		);
	}

	if (risky.length === 0) {
		console.log('\nNothing to cancel.');
		return;
	}

	if (!EXECUTE) {
		console.log(`\nDry run — no orders cancelled. Re-run with --execute to cancel the ${risky.length} order(s) listed above.`);
		return;
	}

	await cancelRiskyOrders(risky);
}

main().catch(console.error);
