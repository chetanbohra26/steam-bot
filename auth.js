const SteamCommunity = require('steamcommunity');
const readline = require('readline');
const fs = require('fs');
require('dotenv').config();

const community = new SteamCommunity();
const SESSION_FILE = './session.json';

function saveSession(cookies) {
	fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies));
}

function loadSession() {
	if (!fs.existsSync(SESSION_FILE)) return null;
	try {
		return JSON.parse(fs.readFileSync(SESSION_FILE));
	} catch {
		return null;
	}
}

// A refresh token lets us mint fresh web cookies without scanning or typing anything, for as long
// as Steam keeps it valid (months). Treat the file like session.json — anyone who can read it can act
// as this Steam account on the website.
const REFRESH_TOKEN_FILE = './refreshToken.json';
const USE_PASSWORD_LOGIN = process.argv.includes('--password-login') || process.env.STEAM_LOGIN_METHOD === 'password';
const QR_LOGIN_TIMEOUT_MS = 180000; // steam-session's default is 30s, too short to find your phone and approve

function loadRefreshToken() {
	if (!fs.existsSync(REFRESH_TOKEN_FILE)) return null;
	try {
		return JSON.parse(fs.readFileSync(REFRESH_TOKEN_FILE, 'utf8')).refreshToken || null;
	} catch {
		return null;
	}
}

function saveRefreshToken(refreshToken) {
	fs.writeFileSync(REFRESH_TOKEN_FILE, JSON.stringify({ refreshToken, savedAt: new Date().toISOString() }));
}

function isLoggedIn() {
	return new Promise((resolve) => {
		community.loggedIn((err, loggedIn) => resolve(!err && loggedIn));
	});
}

async function cookiesFromRefreshToken(refreshToken) {
	const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
	const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
	session.refreshToken = refreshToken;
	return session.getWebCookies();
}

// Logs in by showing a QR code in the terminal for the Steam mobile app to scan (Steam Guard tab ->
// "Scan a QR code"), then approving the login there. No username, password or typed code needed.
async function cookiesFromQrLogin() {
	const { LoginSession, EAuthTokenPlatformType } = require('steam-session');
	const qrcode = require('qrcode-terminal');

	const session = new LoginSession(EAuthTokenPlatformType.WebBrowser);
	session.loginTimeout = QR_LOGIN_TIMEOUT_MS;
	const authenticated = new Promise((resolve, reject) => {
		session.on('authenticated', resolve);
		session.on('timeout', () => reject(new Error(`QR login timed out after ${QR_LOGIN_TIMEOUT_MS / 1000}s — run again and scan sooner`)));
		session.on('error', reject);
		session.on('remoteInteraction', () => console.log('QR code scanned — approve the login in the Steam mobile app...'));
	});

	const { qrChallengeUrl } = await session.startWithQR();
	console.log('\nScan this QR code with the Steam mobile app (Steam Guard tab -> "Scan a QR code") and approve the login:\n');
	qrcode.generate(qrChallengeUrl, { small: true });
	console.log(`\nWaiting up to ${QR_LOGIN_TIMEOUT_MS / 1000}s for approval...`);

	await authenticated;
	saveRefreshToken(session.refreshToken);
	return session.getWebCookies();
}

async function login() {
	const cookies = loadSession();

	if (cookies) {
		community.setCookies(cookies);
		if (await isLoggedIn()) {
			console.log('Resumed existing session');
			return community;
		}

		console.log('Session expired, logging in again...');
	}

	// Cheapest renewal first: a saved refresh token from an earlier QR login.
	const refreshToken = loadRefreshToken();
	if (refreshToken) {
		try {
			const renewed = await cookiesFromRefreshToken(refreshToken);
			community.setCookies(renewed);
			if (await isLoggedIn()) {
				saveSession(renewed);
				console.log('Session renewed from the saved refresh token (no code needed)');
				return community;
			}
			console.log('The saved refresh token produced cookies Steam rejected; falling back to a fresh login.');
		} catch (err) {
			console.log(`The saved refresh token no longer works (${err.message}); falling back to a fresh login.`);
		}
	}

	// Default: log in by QR code. This never reads STEAM_USERNAME / STEAM_PASSWORD from .env, so those can
	// be deleted from .env once QR login works for you.
	if (!USE_PASSWORD_LOGIN) {
		const qrCookies = await cookiesFromQrLogin();
		community.setCookies(qrCookies);
		if (!(await isLoggedIn())) throw new Error('QR login finished but Steam did not accept the resulting session');
		saveSession(qrCookies);
		console.log('Logged in successfully via QR (refresh token saved for next time)');
		return community;
	}

	// Fallback (opt in with --password-login or STEAM_LOGIN_METHOD=password): username + password from .env
	// plus a typed Steam Guard code.
	const username = process.env.STEAM_USERNAME;
	// STEAM_PASSWORD is stored base64-encoded in .env, not plaintext — decode at runtime.
	// Note: this is obfuscation, not encryption; anyone who can read .env can trivially
	// decode it. It just avoids the literal password sitting as plaintext in the file.
	const password = Buffer.from(process.env.STEAM_PASSWORD || '', 'base64').toString('utf8');

	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const twoFactorCode = await new Promise((resolve) => {
		rl.question('Enter Steam Guard code: ', (code) => {
			rl.close();
			resolve(code.trim());
		});
	});

	await new Promise((resolve, reject) => {
		community.login(
			{ accountName: username, password, twoFactorCode, disableMobile: false },
			(err, _sessionID, newCookies) => {
				if (err) {
					console.error('Login failed:', err);
					return reject(err);
				}
				saveSession(newCookies);
				console.log('Logged in successfully');
				resolve();
			},
		);
	});

	return community;
}

function getCookies() {
	return loadSession() || [];
}

module.exports = { login, community, getCookies };
