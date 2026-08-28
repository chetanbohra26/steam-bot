const https = require('https');
const zlib = require('zlib');
const { getCookies } = require('./auth');

function getPriceOverview(appid, market_hash_name) {
	const currency = process.env.CURRENCY || 1;
	const url = `https://steamcommunity.com/market/priceoverview/?appid=${appid}&market_hash_name=${encodeURIComponent(market_hash_name)}&currency=${currency}`;

	return new Promise((resolve, reject) => {
		https
			.get(url, (res) => {
				let data = '';
				res.on('data', (chunk) => (data += chunk));
				res.on('end', () => {
					try {
						resolve(JSON.parse(data));
					} catch (err) {
						reject(err);
					}
				});
			})
			.on('error', reject);
	});
}

function getSession() {
	// Filter to steamcommunity.com cookies (or domain-less cookies, as returned for MobileApp-type sessions) and extract name=value
	const parsed = getCookies()
		.filter((c) => !c.includes('Domain=') || c.includes('Domain=steamcommunity.com'))
		.map((c) => c.split(';')[0].trim());
	const cookieString = parsed.join('; ');
	const sessionid = parsed
		.map((c) => [c.split('=')[0], c.substring(c.indexOf('=') + 1)])
		.find(([key]) => key === 'sessionid')?.[1];
	return { cookieString, sessionid };
}

const BROWSER_HEADERS = {
	'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
	'Accept': '*/*',
	'Accept-Language': 'en-US,en;q=0.9',
	'sec-ch-ua': '"Not/A)Brand";v="99", "Chromium";v="148", "Google Chrome";v="148"',
	'sec-ch-ua-mobile': '?0',
	'sec-ch-ua-platform': '"Windows"',
	'sec-fetch-dest': 'empty',
	'sec-fetch-mode': 'cors',
	'sec-fetch-site': 'same-origin',
};

async function createBuyOrder(_community, appid, market_hash_name, price, quantity) {
	const { cookieString, sessionid } = getSession();
	const currency = process.env.CURRENCY || 1;

	const buildBody = (confirmationId) =>
		new URLSearchParams({
			sessionid,
			currency: currency.toString(),
			appid: appid.toString(),
			market_hash_name,
			price_total: price.toString(),
			tradefee_tax: '0',
			quantity: quantity.toString(),
			confirmation: confirmationId,
		}).toString();

	const buildHeaders = (body) => ({
		...BROWSER_HEADERS,
		'Content-Type': 'application/x-www-form-urlencoded',
		'Cookie': cookieString,
		'Referer': `https://steamcommunity.com/market/listings/${appid}/${encodeURIComponent(market_hash_name)}`,
		'Origin': 'https://steamcommunity.com',
		'X-Requested-With': 'XMLHttpRequest',
		'Content-Length': Buffer.byteLength(body),
	});

	// Steam's own web client submits this same request repeatedly while a mobile
	// confirmation is pending (HTTP 406 / success:22 each time), but crucially echoes
	// the confirmation_id from the first response back in the "confirmation" field on
	// every retry — without that, Steam has no way to tell which pending confirmation
	// this poll is asking about, and never resolves it. Mirror that here.
	const POLL_INTERVAL_MS = 3000;
	const MAX_WAIT_MS = 2 * 60 * 1000;
	const deadline = Date.now() + MAX_WAIT_MS;

	let confirmationId = '0';
	let loggedPending = false;
	while (true) {
		const body = buildBody(confirmationId);
		const { result } = await submitBuyOrder(body, buildHeaders(body));

		if (result.success === 1) {
			console.log(`Buy order placed: ${market_hash_name} at ${price}`);
			return result;
		}

		if (result.success !== 22) {
			throw new Error(result.message || 'Buy order failed');
		}

		if (result.confirmation?.confirmation_id) {
			confirmationId = result.confirmation.confirmation_id;
		}

		if (!loggedPending) {
			console.log(`Buy order pending confirmation: ${market_hash_name} at ${price} — waiting for mobile confirmation...`);
			loggedPending = true;
		}

		if (Date.now() >= deadline) {
			throw new Error('Timed out waiting for mobile confirmation');
		}

		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

function httpsRequest(options, body) {
	return new Promise((resolve, reject) => {
		const req = https.request(options, (res) => {
			const encoding = res.headers['content-encoding'];
			const stream = encoding === 'gzip' ? res.pipe(zlib.createGunzip()) : res;

			let data = '';
			stream.on('data', (chunk) => (data += chunk));
			stream.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
		});
		req.on('error', reject);
		if (body) req.write(body);
		req.end();
	});
}

async function submitBuyOrder(body, headers) {
	const { statusCode, body: responseBody } = await httpsRequest(
		{ hostname: 'steamcommunity.com', path: '/market/createbuyorder/', method: 'POST', headers },
		body,
	);
	return { statusCode, result: JSON.parse(responseBody) };
}

// Fetches the "My listings" page (which server-renders both sell listings and buy
// orders) and pulls out the buy_orderid of every active buy order from the
// CancelMarketBuyOrder( '<id>' ) onclick handlers embedded in its HTML.
async function getMyBuyOrderIds() {
	const { cookieString } = getSession();
	const { body } = await httpsRequest({
		hostname: 'steamcommunity.com',
		path: '/market/mylistings?count=100',
		method: 'GET',
		headers: {
			...BROWSER_HEADERS,
			'Cookie': cookieString,
			'X-Requested-With': 'XMLHttpRequest',
			'Referer': 'https://steamcommunity.com/market/',
		},
	});
	const data = JSON.parse(body);
	const html = data.results_html || '';
	const ids = [...html.matchAll(/CancelMarketBuyOrder\(\s*'(\d+)'\s*\)/g)].map((m) => m[1]);
	return [...new Set(ids)];
}

async function cancelBuyOrder(buy_orderid) {
	const { cookieString, sessionid } = getSession();
	const body = new URLSearchParams({ sessionid, buy_orderid: buy_orderid.toString() }).toString();

	const { statusCode, body: responseBody } = await httpsRequest(
		{
			hostname: 'steamcommunity.com',
			path: '/market/cancelbuyorder/',
			method: 'POST',
			headers: {
				...BROWSER_HEADERS,
				'Content-Type': 'application/x-www-form-urlencoded',
				'Cookie': cookieString,
				'Referer': 'https://steamcommunity.com/market/',
				'Origin': 'https://steamcommunity.com',
				'X-Requested-With': 'XMLHttpRequest',
				'Content-Length': Buffer.byteLength(body),
			},
		},
		body,
	);

	if (statusCode !== 200) {
		throw new Error(`Failed to cancel buy order ${buy_orderid} (HTTP ${statusCode}): ${responseBody}`);
	}
}

module.exports = { getPriceOverview, createBuyOrder, getMyBuyOrderIds, cancelBuyOrder };
