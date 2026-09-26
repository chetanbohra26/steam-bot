const allItems = require('./items.json');

const LIMIT = 200; // matches index.js

// Same selection as index.js: the LIMIT cheapest items from the pool, by cached price_paise.
// Uses the price_paise already captured by the last pick-items run — no live API calls,
// so this is an estimate as of whenever pick-items last ran, not current-second pricing.
const items = [...allItems].sort((a, b) => (a.price_paise ?? Infinity) - (b.price_paise ?? Infinity)).slice(0, LIMIT);

let totalBuyPaise = 0;
console.log(`Dry run (cached prices, no live API calls) — ${items.length} of ${allItems.length} pooled items:\n`);

for (const item of items) {
	const buyPricePaise = Math.floor(item.price_paise * 0.7);
	totalBuyPaise += buyPricePaise;
	console.log(`  ${item.name} — cached ₹${(item.price_paise / 100).toFixed(2)}, would buy at ₹${(buyPricePaise / 100).toFixed(2)}`);
}

console.log(`\n=== Dry run summary (cached prices) ===`);
console.log(`Items: ${items.length}`);
console.log(`Total buy-order commitment: ₹${(totalBuyPaise / 100).toFixed(2)}`);
console.log(`Note: based on prices from the last pick-items run, not live — actual up run may differ if prices moved since.`);
