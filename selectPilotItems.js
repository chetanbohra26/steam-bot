const { login } = require('./auth');
const { getSession, httpsRequest, getPriceOverview } = require('./market');
const fs = require('fs');

const APPID = 730; // Counter-Strike 2
const PAGE_SIZE = 100;
const PAGES_TO_SCAN = 800; // scans up to the 80,000 most-liquid items
const MIN_PRICE_PAISE = 2000; // ₹20.00 — sell_price is in paise; rough floor so a 70% lowball fill is still worth something
// Matches asset_description.type strings for guns, e.g. "Mil-Spec Grade Rifle", "Restricted Pistol",
// "Covert Sniper Rifle" — excludes knives/gloves ("Covert Knife", "Extraordinary Gloves") and
// non-weapon items (cases, stickers, agents, etc).
const WEAPON_TYPE_PATTERN = /(Pistol|SMG|Rifle|Shotgun|Machine ?Gun)$/i;

const STAGE1_CANDIDATE_COUNT = 2000; // broad pool gathered cheaply by listing count, before real-demand ranking
const TARGET_COUNT = 1000; // final pool size after ranking by real trade volume
const PRICEOVERVIEW_DELAY_MS = 4500; // pace between per-item priceoverview calls in stage 2 — Steam's limit is ~20/min per IP (community-reported), this keeps us under ~13/min for margin

// Caches stage 1's candidate list and stage 2's resolved (volume-checked) results across
// runs, so a rate-limit hit doesn't force starting over from zero — a retry only queries
// priceoverview for candidates not yet resolved. Delete this file to force a fresh scan.
const CACHE_FILE = './pickItemsCache.json';

function loadCache() {
	if (!fs.existsSync(CACHE_FILE)) return { candidates: null, resolved: {} };
	try {
		const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
		return { candidates: raw.candidates || null, resolved: raw.resolved || {} };
	} catch (err) {
		console.error('Failed to read cache, starting fresh:', err.message);
		return { candidates: null, resolved: {} };
	}
}

function saveCache(cache) {
	fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, '\t'));
}

async function fetchSearchPage(cookieString, start) {
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

// Stage 1 (cheap, bulk): scan listings sorted by quantity to gather a broad pool of
// liquid weapon skins above the price floor. This is just a first-pass net — listing
// count reflects order-book supply, not actual demand (an unwanted item can have huge
// listing counts simply from oversupply), so it's re-ranked properly in stage 2.
async function gatherCandidates(cookieString) {
	const candidates = [];
	for (let page = 0; page < PAGES_TO_SCAN; page++) {
		const data = await fetchSearchPage(cookieString, page * PAGE_SIZE);
		if (!data.success || !data.results?.length) break;

		for (const r of data.results) {
			if (!WEAPON_TYPE_PATTERN.test(r.asset_description?.type || '')) continue;
			const price = Number(r.sell_price);
			if (!Number.isFinite(price) || price < MIN_PRICE_PAISE) continue;
			candidates.push({ name: r.hash_name, market_hash_name: r.hash_name, appid: APPID, quantity: 1 });
		}

		if (candidates.length >= STAGE1_CANDIDATE_COUNT) break;
		if ((page + 1) % 10 === 0) {
			console.log(`  [stage 1] ...scanned ${(page + 1) * PAGE_SIZE} items, ${candidates.length}/${STAGE1_CANDIDATE_COUNT} matched so far`);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	return candidates.slice(0, STAGE1_CANDIDATE_COUNT);
}

// Stage 2 (slow, per-item): fetch real recent sales volume for each candidate via
// priceoverview, and rank by volume alone — this isn't about maximizing payoff size,
// it's about picking the "better horses": the items most likely to actually fill.
// Price only remains as the stage-1 floor filter, not part of the ranking itself.
// Skips candidates already resolved in cache, and persists progress periodically so a
// rate-limit hit partway through doesn't lose everything already fetched.
async function rankByDemand(candidates, cache) {
	const failureCounts = {};
	let loggedSamples = 0;
	let newlyResolved = 0;

	const remaining = candidates.filter((c) => !cache.resolved[c.market_hash_name]);
	console.log(`  [stage 2] ${remaining.length}/${candidates.length} candidates still need resolving (${candidates.length - remaining.length} already cached).`);

	for (let i = 0; i < remaining.length; i++) {
		const item = remaining[i];
		try {
			const data = await getPriceOverview(item.appid, item.market_hash_name);
			if (data.success && data.lowest_price) {
				const priceRupees = parseFloat(data.lowest_price.replace(/[^0-9.]/g, ''));
				const volume = data.volume ? parseInt(String(data.volume).replace(/,/g, ''), 10) : 0;
				if (priceRupees > 0) {
					cache.resolved[item.market_hash_name] = {
						...item,
						price_paise: Math.round(priceRupees * 100),
						volume,
					};
					newlyResolved++;
				} else {
					failureCounts.zeroPrice = (failureCounts.zeroPrice || 0) + 1;
				}
			} else {
				failureCounts.unsuccessful = (failureCounts.unsuccessful || 0) + 1;
				if (loggedSamples < 3) {
					console.log(`  [stage 2] sample failure for "${item.name}": ${JSON.stringify(data)}`);
					loggedSamples++;
				}
			}
		} catch (err) {
			failureCounts.exception = (failureCounts.exception || 0) + 1;
			if (loggedSamples < 3) {
				console.log(`  [stage 2] sample exception for "${item.name}": ${err.message}`);
				loggedSamples++;
			}
		}

		if ((i + 1) % 20 === 0) {
			saveCache(cache);
		}
		if ((i + 1) % 100 === 0) {
			console.log(
				`  [stage 2] ...checked ${i + 1}/${remaining.length} remaining (${newlyResolved} newly resolved, ${Object.keys(cache.resolved).length} total cached, failures: ${JSON.stringify(failureCounts)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, PRICEOVERVIEW_DELAY_MS));
	}

	saveCache(cache);
	console.log(`  [stage 2] final failure breakdown: ${JSON.stringify(failureCounts)}`);
}

async function main() {
	await login();
	const { cookieString } = getSession();

	const cache = loadCache();

	let candidates;
	if (cache.candidates) {
		candidates = cache.candidates;
		console.log(`Stage 1: reusing ${candidates.length} cached candidates (delete ${CACHE_FILE} to force a fresh scan).`);
	} else {
		console.log('Stage 1: gathering liquid weapon-skin candidates by listing volume...');
		candidates = await gatherCandidates(cookieString);
		console.log(`Stage 1 done: ${candidates.length} candidates.`);
		cache.candidates = candidates;
		saveCache(cache);
	}

	console.log('Stage 2: fetching real sales volume per candidate (this takes a while)...');
	await rankByDemand(candidates, cache);

	const ranked = Object.values(cache.resolved);
	console.log(`Stage 2 done: ${ranked.length} candidates have usable price/volume data.`);

	ranked.sort((a, b) => b.volume - a.volume);
	const picked = ranked.slice(0, TARGET_COUNT);

	console.log(`\nSelected ${picked.length} item(s) by real trade volume:`);
	const LOG_LIMIT = 20;
	for (const item of picked.slice(0, LOG_LIMIT)) {
		console.log(`  ${item.name} — ₹${(item.price_paise / 100).toFixed(2)}, volume ${item.volume}`);
	}
	if (picked.length > LOG_LIMIT) {
		console.log(`  ...and ${picked.length - LOG_LIMIT} more (see items.json)`);
	}

	const items = picked.map(({ name, market_hash_name, appid, quantity, price_paise, volume }) => ({ name, market_hash_name, appid, quantity, price_paise, volume }));
	fs.writeFileSync('./items.json', JSON.stringify(items, null, '\t') + '\n');
	console.log('\nWrote items.json');
}

main().catch(console.error);
