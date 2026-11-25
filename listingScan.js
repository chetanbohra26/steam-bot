// Reads current prices and 24h sales volume from Steam's market listing pages. One page covers
// every variant (wears, StatTrak™) of a skin, so the pool needs one request per skin rather than
// one per item. This replaced the search/render scan, which started returning 404 on 2026-11-25
// when Steam changed the market UI.
const https = require('https');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { progressSuffix } = require('./progress');

const APPID = 730;
const EXPECTED_CURRENCY = '24'; // INR — items.json prices are in paise, so any other currency would corrupt them
const PAGE_DELAY_MS = 8000; // pace verified over 50 pages on 2026-11-25; the real limit for these pages is unknown
const PAGE_JITTER = 0.2;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 3;
const MAX_CONSECUTIVE_UNREADABLE = 3; // this many pages in a row with no prices means the page format changed
const VOLUME_WINDOW_S = 24 * 3600;
const MAX_HISTORY_LAG_S = 6 * 3600;
// Connection-level errors only — never an HTTP status, where calling again could extend a ban.
const TRANSIENT_NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE']);
const RETRY_DELAYS_MS = [10000, 30000];

const skinFamily = (name) =>
	name.replace(/ \((Factory New|Minimal Wear|Field-Tested|Well-Worn|Battle-Scarred)\)$/, '').replace(/^(StatTrak™|Souvenir) /, '');

function request(cookieString, path, redirects = 0) {
	return new Promise((resolve, reject) => {
		const req = https.get(
			{ hostname: 'steamcommunity.com', path, headers: { 'Cookie': cookieString, 'Accept-Encoding': 'gzip' } },
			(res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < MAX_REDIRECTS) {
					res.resume();
					const next = new URL(res.headers.location, 'https://steamcommunity.com');
					// Only the path is followed, so the session cookie can't be sent to another host.
					resolve(request(cookieString, next.pathname + next.search, redirects + 1));
					return;
				}
				const chunks = [];
				const done = (err) => (err ? reject(err) : resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
				const collect = async function (source) {
					for await (const chunk of source) chunks.push(chunk);
				};
				if (res.headers['content-encoding'] === 'gzip') pipeline(res, zlib.createGunzip(), collect, done);
				else pipeline(res, collect, done);
			},
		);
		req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })));
		req.on('error', reject);
	});
}

const fetchListingPage = (cookieString, marketHashName) => request(cookieString, `/market/listings/${APPID}/${encodeURIComponent(marketHashName)}`);

// The page embeds its data as JSON inside JavaScript strings, escaped one or more levels deep.
// Returns { currencies, prices: Map(name -> paise), volumes: Map(name -> sales in the last 24h) }.
function parseListingPage(body, nowMs = Date.now()) {
	const text = body
		.replace(/\\+"/g, '"')
		.replace(/\\+u([0-9a-fA-F]{4})/g, (escape, hex) => {
			const code = parseInt(hex, 16);
			return code >= 0x80 || code === 0x26 || code === 0x27 ? String.fromCharCode(code) : escape;
		});

	const currencies = [...new Set([...text.matchAll(/"eCurrency":(\d+)/g)].map((m) => m[1]))];

	const prices = new Map();
	for (const m of text.matchAll(/"bucket_id":"([^"]+)","localized_name":"[^"]*","min_price":"(\d+)"/g)) {
		prices.set(m[1], Number(m[2]));
	}

	// Each history is `"prices":[...]` followed by the queryKey naming the item it belongs to.
	const histories = [];
	const historyPattern = /"prices":\[([^\]]*)\](?:(?!"prices":)[\s\S])*?"queryKey":\["market","pricehistory",\d+,"([^"]+)"\]/g;
	for (const m of text.matchAll(historyPattern)) {
		const points = [...m[1].matchAll(/\{"time":(\d+),"price_median":[\d.eE+-]+,"purchases":"?(\d+)"?\}/g)].map((p) => ({
			time: Number(p[1]),
			purchases: Number(p[2]),
		}));
		// Points we can't read must not be reported as "no sales".
		if (m[1] && !points.length) continue;
		histories.push({ name: m[2], points });
	}

	// The history trails real time by an hour or two, so count the 24 hours ending at the page's
	// newest sale. The floor stops a skin that hasn't sold recently from reporting old sales.
	const nowS = nowMs / 1000;
	const newest = histories.reduce((max, h) => h.points.reduce((m, p) => Math.max(m, p.time), max), 0);
	const windowEnd = Math.max(newest, nowS - MAX_HISTORY_LAG_S);
	const volumes = new Map();
	for (const h of histories) {
		volumes.set(h.name, h.points.reduce((sum, p) => (p.time > windowEnd - VOLUME_WINDOW_S ? sum + p.purchases : sum), 0));
	}

	return { currencies, prices, volumes };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fetches one listing page per skin in `items`. Never writes anything. Returns:
//   updates  Map(market_hash_name -> { price_paise, volume }) — volume is undefined if the page had no history
//   unpriced pool names on a fetched page with no current price (or on an unreadable page)
//   stopped  null, or why the scan ended early; nothing more should be sent to Steam in that case
async function scanListings(items, cookieString, { fetchPage = fetchListingPage, wait = sleep, log = console.log } = {}) {
	const families = new Map();
	for (const item of items) {
		const family = skinFamily(item.market_hash_name);
		if (!families.has(family)) families.set(family, []);
		families.get(family).push(item);
	}

	const updates = new Map();
	const unpriced = [];
	let stopped = null;
	let unreadableInARow = 0;
	let index = 0;
	const startedAt = Date.now();
	log(`Fetching ${families.size} listing page(s) for ${items.length} pool item(s), ~${PAGE_DELAY_MS / 1000}s apart...`);

	for (const [family, members] of families) {
		if (index > 0) await wait(Math.round(PAGE_DELAY_MS * (1 - PAGE_JITTER + Math.random() * 2 * PAGE_JITTER)));
		const prefix = `  [${index + 1}/${families.size}] ${family}`;

		let response;
		for (let attempt = 0; !response; attempt++) {
			try {
				response = await fetchPage(cookieString, members[0].market_hash_name);
			} catch (err) {
				const delay = RETRY_DELAYS_MS[attempt];
				if (!TRANSIENT_NETWORK_CODES.has(err.code) || delay === undefined) {
					stopped = `request failed for ${family}: ${err.code || err.message}`;
					break;
				}
				log(`${prefix} | ${err.code}; retrying in ${delay / 1000}s (retry ${attempt + 1}/${RETRY_DELAYS_MS.length})...`);
				await wait(delay);
			}
		}
		if (stopped) break;

		if (response.statusCode !== 200) {
			stopped =
				response.statusCode === 429
					? 'rate-limited (HTTP 429) — do not retry immediately, wait hours'
					: `listing page returned HTTP ${response.statusCode} for ${family}`;
			break;
		}

		const page = parseListingPage(response.body);
		let priced = 0;
		if (page.prices.size === 0) {
			unreadableInARow++;
			unpriced.push(...members.map((m) => m.market_hash_name));
		} else if (page.currencies.join() !== EXPECTED_CURRENCY) {
			stopped = `listing page currency was ${page.currencies.join() || 'missing'}, expected ${EXPECTED_CURRENCY} (INR) — is the session logged in?`;
			break;
		} else {
			unreadableInARow = 0;
			for (const { market_hash_name: name } of members) {
				const price = page.prices.get(name);
				if (price > 0) {
					updates.set(name, { price_paise: price, volume: page.volumes.get(name) });
					priced++;
				} else {
					unpriced.push(name);
				}
			}
		}
		index++;
		log(`${prefix} | ${priced}/${members.length} priced | ${progressSuffix(startedAt, index, families.size)}`);
		if (unreadableInARow >= MAX_CONSECUTIVE_UNREADABLE) {
			stopped = `${unreadableInARow} listing pages in a row had no readable prices — Steam's page format has probably changed`;
			break;
		}
	}

	return { updates, unpriced, stopped };
}

module.exports = { scanListings, parseListingPage, fetchListingPage, skinFamily };
