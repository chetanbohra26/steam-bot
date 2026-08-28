const { login } = require('./auth');
const { getSession, httpsRequest } = require('./market');
const fs = require('fs');

const APPID = 730; // Counter-Strike 2
const PAGE_SIZE = 100;
const PAGES_TO_SCAN = 40; // scans the 4000 most-liquid commodity items
const MIN_PRICE_PAISE = 10000; // ₹100.00 — sell_price is in paise; rough floor so a 70% lowball fill is still worth something
const TARGET_COUNT = 10;

async function fetchPage(cookieString, start) {
	const path = `/market/search/render/?query=&start=${start}&count=${PAGE_SIZE}&search_descriptions=0&sort_column=quantity&sort_dir=desc&appid=${APPID}&norender=1`;
	const { body } = await httpsRequest({
		hostname: 'steamcommunity.com',
		path,
		method: 'GET',
		headers: {
			'Cookie': cookieString,
			'X-Requested-With': 'XMLHttpRequest',
			'Referer': `https://steamcommunity.com/market/search?appid=${APPID}`,
		},
	});
	return JSON.parse(body);
}

async function main() {
	await login();
	const { cookieString } = getSession();

	const candidates = [];
	for (let page = 0; page < PAGES_TO_SCAN; page++) {
		const data = await fetchPage(cookieString, page * PAGE_SIZE);
		if (!data.success || !data.results?.length) break;

		if (page === 0) {
			console.log('Sample result fields:', JSON.stringify(data.results[0]));
		}

		for (const r of data.results) {
			if (r.asset_description?.commodity !== 1) continue; // skip non-commodity (one-of-a-kind) items
			const price = Number(r.sell_price);
			if (!Number.isFinite(price) || price < MIN_PRICE_PAISE) continue; // Number() on undefined/garbage -> NaN, explicitly excluded rather than silently passing
			candidates.push({
				name: r.hash_name,
				market_hash_name: r.hash_name,
				appid: APPID,
				quantity: 1,
				sell_listings: r.sell_listings,
				sell_price_text: r.sell_price_text,
			});
		}

		if (candidates.length >= TARGET_COUNT) break;
		await new Promise((resolve) => setTimeout(resolve, 1000)); // be gentle between pages
	}

	const picked = candidates.slice(0, TARGET_COUNT);

	console.log(`Selected ${picked.length} item(s):`);
	for (const item of picked) {
		console.log(`  ${item.name} — ${item.sell_price_text}, ${item.sell_listings} active listings`);
	}

	const items = picked.map(({ name, market_hash_name, appid, quantity }) => ({ name, market_hash_name, appid, quantity }));
	fs.writeFileSync('./items.json', JSON.stringify(items, null, '\t') + '\n');
	console.log('\nWrote items.json');
}

main().catch(console.error);
