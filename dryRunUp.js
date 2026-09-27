const allItems = require('./items.json');

const LIMIT = 200; // matches index.js

// Deliberately NOT filtered by placedOrders.json (unlike index.js's actual selection).
// index.js's real "next batch" shifts constantly as orders get placed mid-run, which
// makes it a moving target unsuitable for a stable planning estimate. This always shows
// the cost of the top LIMIT items in the pool's existing order (ranked by real trade
// volume, highest first, by selectPilotItems.js) — a fixed reference point, not "what's
// left to place right now". Uses price_paise from the last pick-items/up refresh — no
// live API calls, so it's an estimate, not current-second pricing.
const items = allItems.slice(0, LIMIT);

let totalBuyPaise = 0;
console.log(`Dry run (cached prices, no live API calls, ignores placedOrders.json) — top ${items.length} of ${allItems.length} pooled items by rank:\n`);

for (const item of items) {
	const buyPricePaise = Math.floor(item.price_paise * 0.7);
	totalBuyPaise += buyPricePaise;
	console.log(`  ${item.name} — cached ₹${(item.price_paise / 100).toFixed(2)}, would buy at ₹${(buyPricePaise / 100).toFixed(2)}`);
}

console.log(`\n=== Dry run summary (cached prices) ===`);
console.log(`Items: ${items.length}`);
console.log(`Total buy-order commitment: ₹${(totalBuyPaise / 100).toFixed(2)}`);
console.log(`Note: based on prices from the last pick-items run, not live — actual up run may differ if prices moved since.`);
