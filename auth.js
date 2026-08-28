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

async function login() {
	const cookies = loadSession();

	if (cookies) {
		community.setCookies(cookies);
		const valid = await new Promise((resolve) => {
			community.loggedIn((err, loggedIn) => resolve(!err && loggedIn));
		});

		if (valid) {
			console.log('Resumed existing session');
			return community;
		}

		console.log('Session expired, logging in again...');
	}

	const username = process.env.STEAM_USERNAME;
	const password = process.env.STEAM_PASSWORD;

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
