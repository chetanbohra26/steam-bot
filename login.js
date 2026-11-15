// Standalone login: resumes the saved session, renews it from the saved refresh token, or shows a QR code
// to scan — whichever works first — then exits. Run it before `up` / `down` so a QR scan (if needed)
// doesn't interrupt a long run. Pass --password-login to use the username + password flow instead.
const { login } = require('./auth');

login()
	.then(() => {
		console.log('Login OK — session saved to session.json.');
		process.exit(0);
	})
	.catch((err) => {
		console.error(`Login failed: ${err.message}`);
		process.exit(1);
	});
