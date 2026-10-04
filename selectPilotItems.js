const { login } = require('./auth');
const { getSession, httpsRequest, getPriceOverview } = require('./market');
const fs = require('fs');
const allItems = require('./items.json');

const APPID = 730; // Counter-Strike 2
const PAGE_SIZE = 100;
const PAGES_TO_SCAN = 800; // scans up to the 80,000 most-liquid items
const MIN_PRICE_PAISE = 2000; // ₹20.00 — sell_price is in paise; rough floor so a 70% lowball fill is still worth something
// ₹2000.00 — ceiling so no single item can eat a disproportionate share of the 10x-wallet
// active-orders budget (confirmed exact ceiling from Steam's own rejection message) or
// crowd out breadth. Also happens to exclude most of the volatile "hype item" tier
// (e.g. Printstream-family skins) that's a poor fit for the weekly/fixed-discount strategy.
const MAX_PRICE_PAISE = 200000;
// Minimum real sales volume required to even qualify for the pool. Without this, "sort
// by volume descending, take top TARGET_COUNT" pads out with zero/near-zero-volume junk
// once genuinely liquid candidates run out — found ~49% of the pool had volume < 5 before
// this was added. A smaller, all-genuine pool beats a full quota padded with dead items.
const MIN_VOLUME = 5;
// Matches asset_description.type strings for guns, e.g. "Mil-Spec Grade Rifle", "Restricted Pistol",
// "Covert Sniper Rifle" — excludes knives/gloves ("Covert Knife", "Extraordinary Gloves") and
// non-weapon items (cases, stickers, agents, etc). Kept as a cheap defensive double-check even
// though the search query below now filters server-side — costs nothing and catches surprises.
const WEAPON_TYPE_PATTERN = /(Pistol|SMG|Rifle|Shotgun|Machine ?Gun)$/i;

// Steam's market search supports server-side category filtering (verified live: each tag
// alone returns only that type, e.g. tag_CSGO_Type_Rifle -> 2922 results all "...Grade Rifle";
// multiple values OR together, e.g. Rifle+Pistol -> exactly 2922+3741 combined). Using this
// instead of scanning the whole ~35,000-item catalog and filtering client-side cuts stage 1
// from ~354 pages down to ~124 (12,303 total weapon items across these 6 tags), with 100%
// relevant results per page instead of the ~4-10% match rate scanning everything gave.
const WEAPON_TYPE_TAGS = [
	'tag_CSGO_Type_Pistol',
	'tag_CSGO_Type_SMG',
	'tag_CSGO_Type_Rifle',
	'tag_CSGO_Type_Shotgun',
	'tag_CSGO_Type_Machinegun',
	'tag_CSGO_Type_SniperRifle',
];

const STAGE1_CANDIDATE_COUNT = 2000; // broad pool gathered cheaply by listing count, before real-demand ranking
const TARGET_COUNT = 1000; // final pool size after ranking by real trade volume
// Pace between per-item priceoverview calls in stage 2. Steam's ~20/min-per-IP limit
// (community-reported, confirmed via research 2026-09-28) appears to be shared across
// ALL steamcommunity.com market endpoints on that IP, not siloed per-endpoint — a ban
// on 2026-09-27 happened despite this script staying under ~13/min on its own, most
// likely because two `up` runs (priceoverview + createbuyorder + mylistings calls) had
// already used IP budget earlier the same day. A second ban on 2026-10-03 hit at ~585
// calls in ~62 min (pace ~9.5/min, nothing else running that day), while 535 calls in
// ~56 min on 2026-09-28 was fine — so the real limit looks like a per-hour call count,
// roughly 535-585, not a per-minute rate. 7000ms (+~0.35s request time) is ~7.35s per
// item, ~490 calls/hour, which keeps any rolling hour under the highest known-safe count.
const PRICEOVERVIEW_DELAY_MS = 7000;
const REQUEST_OVERHEAD_MS = 350; // measured: ~6.35s per item at a 6000ms delay

// Caches stage 1's candidate list and stage 2's resolved (volume-checked) results across
// runs, so a rate-limit hit doesn't force starting over from zero — a retry only queries
// priceoverview for candidates not yet resolved. Delete this file to force a fresh scan.
const CACHE_FILE = './pickItemsCache.json';

// --price-only: run stage 1 only and use its sell_price (already fetched for the
// tooCheap/tooExpensive filter, just discarded before) to refresh items.json's cached
// prices for the existing pool — no stage 2, no priceoverview calls at all. Stage 1 is
// a handful of search/render requests (~1s apart) vs stage 2's hundreds of per-item
// priceoverview calls (7s apart), so this is dramatically cheaper for when you just want
// current prices and aren't expecting trade volume to have shifted much. Volume is left
// untouched — only a full run (no flag) re-measures that.
const SKIP_STAGE2 = process.argv.includes('--price-only');
const NOTABLE_PCT_CHANGE = 20; // flag price moves at least this big, e.g. the P90 | Neoqueen crash (~41% in days) that prompted this
const PLACED_ORDERS_FILE = './placedOrders.json';
const ORDER_ADJUSTMENTS_FILE = './buyOrderAdjustments.json';
const DISCOUNT_FACTOR = 0.60; // matches index.js — only used here to compute suggested buy-order prices for the adjustment report, not to place anything

function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function loadPlacedOrders() {
	if (!fs.existsSync(PLACED_ORDERS_FILE)) return new Set();
	try {
		return new Set(JSON.parse(fs.readFileSync(PLACED_ORDERS_FILE, 'utf8')));
	} catch {
		return new Set();
	}
}

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
	const typeParams = WEAPON_TYPE_TAGS.map((tag, i) => `category_${APPID}_Type%5B${i}%5D=${tag}`).join('&');
	const path = `/market/search/render/?query=&start=${start}&count=${PAGE_SIZE}&search_descriptions=0&sort_column=quantity&sort_dir=desc&appid=${APPID}&${typeParams}&norender=1`;
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
	const excluded = { wrongType: 0, tooCheap: 0, tooExpensive: 0 };
	for (let page = 0; page < PAGES_TO_SCAN; page++) {
		const data = await fetchSearchPage(cookieString, page * PAGE_SIZE);
		if (!data.success || !data.results?.length) break;

		for (const r of data.results) {
			if (!WEAPON_TYPE_PATTERN.test(r.asset_description?.type || '')) {
				excluded.wrongType++;
				continue;
			}
			const price = Number(r.sell_price);
			if (!Number.isFinite(price) || price < MIN_PRICE_PAISE) {
				excluded.tooCheap++;
				continue;
			}
			if (price > MAX_PRICE_PAISE) {
				excluded.tooExpensive++;
				continue;
			}
			candidates.push({ name: r.hash_name, market_hash_name: r.hash_name, appid: APPID, quantity: 1, price_paise: price });
		}

		if (candidates.length >= STAGE1_CANDIDATE_COUNT) break;
		if ((page + 1) % 10 === 0) {
			console.log(
				`  [stage 1] ...scanned ${(page + 1) * PAGE_SIZE} items, ${candidates.length}/${STAGE1_CANDIDATE_COUNT} matched so far (excluded: ${JSON.stringify(excluded)})`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 1000));
	}
	console.log(`  [stage 1] final exclusion breakdown: ${JSON.stringify(excluded)}`);
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
	let newlyResolved = 0;

	const remaining = candidates.filter((c) => !cache.resolved[c.market_hash_name]);
	console.log(`  [stage 2] ${remaining.length}/${candidates.length} candidates still need resolving (${candidates.length - remaining.length} already cached).`);
	const perItemMs = PRICEOVERVIEW_DELAY_MS + REQUEST_OVERHEAD_MS;
	console.log(`  [stage 2] pacing ${PRICEOVERVIEW_DELAY_MS / 1000}s delay -> ~${Math.round(3600000 / perItemMs)} calls/hour, estimated ${formatDuration(remaining.length * perItemMs)} for ${remaining.length} item(s).`);
	const poolPriceByName = new Map(allItems.map((p) => [p.market_hash_name, p.price_paise]));
	const parseRupees = (s) => (s ? parseFloat(String(s).replace(/[^0-9.]/g, '')) : NaN);
	const stage2StartedAt = Date.now();
	for (let i = 0; i < remaining.length; i++) {
		const item = remaining[i];
		const prefix = `  [stage 2] ${i + 1}/${remaining.length} (${((i + 1) / remaining.length * 100).toFixed(1)}%) ${item.name}`;
		let detail;
		try {
			const data = await getPriceOverview(item.appid, item.market_hash_name);
			if (data.success && data.lowest_price) {
				const priceRupees = parseRupees(data.lowest_price);
				const medianRupees = parseRupees(data.median_price);
				const volume = data.volume ? parseInt(String(data.volume).replace(/,/g, ''), 10) : 0;
				if (priceRupees > 0) {
					const pricePaise = Math.round(priceRupees * 100);
					cache.resolved[item.market_hash_name] = {
						...item,
						price_paise: pricePaise,
						volume,
					};
					newlyResolved++;

					const prevPaise = poolPriceByName.get(item.market_hash_name);
					const vsPool =
						Number.isFinite(prevPaise) && prevPaise > 0
							? `was ₹${(prevPaise / 100).toFixed(2)} in pool, ${pricePaise >= prevPaise ? '+' : ''}${(((pricePaise - prevPaise) / prevPaise) * 100).toFixed(1)}%`
							: 'new to pool';
					const median = Number.isFinite(medianRupees) ? `₹${medianRupees.toFixed(2)}` : 'n/a';
					detail = `₹${priceRupees.toFixed(2)} (${vsPool}) | median ${median} | vol ${volume} ${volume >= MIN_VOLUME ? 'OK' : `below floor ${MIN_VOLUME}`}`;
				} else {
					failureCounts.zeroPrice = (failureCounts.zeroPrice || 0) + 1;
					detail = `FAILED zero price: ${JSON.stringify(data)}`;
				}
			} else {
				failureCounts.unsuccessful = (failureCounts.unsuccessful || 0) + 1;
				detail = `FAILED no price data: ${JSON.stringify(data)}`;
			}
		} catch (err) {
			failureCounts.exception = (failureCounts.exception || 0) + 1;
			detail = `FAILED: ${err.message}`;
			// Steam's ban extends if you keep calling while banned, so stop on the first
			// rate-limit: save progress, unwind normally, and let node exit on its own.
			if (err.message.includes('rate-limited')) {
				console.log(`${prefix} | ${detail}`);
				saveCache(cache);
				console.log(`\n  [stage 2] rate-limited — stopping to avoid extending the ban. ${Object.keys(cache.resolved).length}/${candidates.length} candidates are saved in ${CACHE_FILE}; re-run pick-items after the ban clears (hours) to resume.`);
				process.exitCode = 1;
				return true;
			}
		}

		if ((i + 1) % 20 === 0) saveCache(cache);

		const qualifiedSoFar = Object.values(cache.resolved).filter((r) => (r.volume ?? 0) >= MIN_VOLUME).length;
		const elapsedMs = Date.now() - stage2StartedAt;
		// This line prints before this item's trailing delay, so elapsedMs holds i+1 requests but
		// only i delays; adding the pending delay makes it i+1 full cycles and keeps the ETA stable.
		const etaMs = ((remaining.length - (i + 1)) * (elapsedMs + PRICEOVERVIEW_DELAY_MS)) / (i + 1);
		const failures = Object.keys(failureCounts).length ? ` | failures: ${JSON.stringify(failureCounts)}` : '';
		console.log(`${prefix} | ${detail} | ${qualifiedSoFar} qualified | elapsed ${formatDuration(elapsedMs)} | ETA ${formatDuration(etaMs)}${failures}`);

		await new Promise((resolve) => setTimeout(resolve, PRICEOVERVIEW_DELAY_MS));
	}

	saveCache(cache);
	console.log(`  [stage 2] final failure breakdown: ${JSON.stringify(failureCounts)}`);
	return false;
}

// Updates items.json's cached price for every pool item found in this stage-1 scan —
// volume is left as-is (stage 1 doesn't measure it). Items not found in this scan (fell
// out of the top-liquidity ranking) are left unchanged rather than guessed at. Also
// writes buyOrderAdjustments.json: for items with an ACTIVE buy order (per
// placedOrders.json) whose price moved notably since the order was computed, lists the
// old vs. new reference price and the old vs. suggested-new buy-order price, so you can
// decide whether to cancel+replace that specific order — doesn't touch any order itself.
// Relies on items.json's price_paise still reflecting the price last used to compute
// that order (true as long as no other refresh ran in between without a re-placement).
function applyStage1PricesToPool(candidates) {
	const priceByName = new Map(candidates.map((c) => [c.market_hash_name, c.price_paise]));
	const placedOrders = loadPlacedOrders();
	let updated = 0;
	let missing = 0;
	const notableMoves = [];
	const orderAdjustments = [];

	for (const item of allItems) {
		const newPrice = priceByName.get(item.market_hash_name);
		if (newPrice === undefined) {
			missing++;
			continue;
		}
		const oldPrice = item.price_paise;
		if (oldPrice !== newPrice) {
			updated++;
			if (Number.isFinite(oldPrice) && oldPrice > 0) {
				const pctChange = ((newPrice - oldPrice) / oldPrice) * 100;
				if (Math.abs(pctChange) >= NOTABLE_PCT_CHANGE) {
					notableMoves.push({ name: item.name, oldPrice, newPrice, pctChange });
					if (placedOrders.has(item.market_hash_name)) {
						orderAdjustments.push({
							market_hash_name: item.market_hash_name,
							name: item.name,
							oldPrice_paise: oldPrice,
							oldBuyOrderPrice_paise: Math.floor(oldPrice * DISCOUNT_FACTOR),
							newPrice_paise: newPrice,
							suggestedBuyOrderPrice_paise: Math.floor(newPrice * DISCOUNT_FACTOR),
							pctChange: Math.round(pctChange * 10) / 10,
						});
					}
				}
			}
			item.price_paise = newPrice;
		}
	}

	fs.writeFileSync('./items.json', JSON.stringify(allItems, null, '\t') + '\n');
	console.log(`\n--price-only: updated price for ${updated}/${allItems.length} pool item(s) from the stage 1 scan (${missing} not found in this scan, left unchanged).`);

	if (notableMoves.length) {
		notableMoves.sort((a, b) => a.pctChange - b.pctChange);
		console.log(`${notableMoves.length} item(s) moved ${NOTABLE_PCT_CHANGE}%+ since last cached price:`);
		for (const m of notableMoves) {
			console.log(`  ${m.name}: ₹${(m.oldPrice / 100).toFixed(2)} -> ₹${(m.newPrice / 100).toFixed(2)} (${m.pctChange >= 0 ? '+' : ''}${m.pctChange.toFixed(1)}%)`);
		}
	}

	orderAdjustments.sort((a, b) => a.pctChange - b.pctChange);
	fs.writeFileSync(ORDER_ADJUSTMENTS_FILE, JSON.stringify(orderAdjustments, null, '\t') + '\n');
	if (orderAdjustments.length) {
		console.log(`\n${orderAdjustments.length} active buy order(s) worth reviewing (price moved ${NOTABLE_PCT_CHANGE}%+ since the order was placed) — see ${ORDER_ADJUSTMENTS_FILE}`);
	} else {
		console.log(`\nNo active buy orders moved ${NOTABLE_PCT_CHANGE}%+ — wrote empty ${ORDER_ADJUSTMENTS_FILE}.`);
	}
}

async function main() {
	await login();
	const { cookieString } = getSession();

	const cache = loadCache();

	// --price-only is a fresh-prices request by definition, so it always re-scans stage 1
	// rather than reusing a (possibly stale, possibly mid-write by another run) cache.
	let candidates;
	if (SKIP_STAGE2) {
		console.log('Stage 1: gathering current prices (--price-only, ignoring any cached candidates)...');
		candidates = await gatherCandidates(cookieString);
		console.log(`Stage 1 done: ${candidates.length} candidates.`);
		applyStage1PricesToPool(candidates);
		return;
	}

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
	const stoppedEarly = await rankByDemand(candidates, cache);
	if (stoppedEarly) {
		console.log('Not writing items.json from a partial run — it still has the previous pool.');
		return;
	}

	const ranked = Object.values(cache.resolved);
	console.log(`Stage 2 done: ${ranked.length} candidates have usable price/volume data.`);

	const qualified = ranked.filter((item) => (item.volume ?? 0) >= MIN_VOLUME);
	console.log(`${qualified.length}/${ranked.length} candidates clear the MIN_VOLUME (${MIN_VOLUME}) floor.`);

	qualified.sort((a, b) => b.volume - a.volume);
	const picked = qualified.slice(0, TARGET_COUNT);

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
