function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, '0')}m${seconds.toString().padStart(2, '0')}s`;
	return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

// "elapsed 3m10s | ETA 12m40s" — ETA extrapolates the average time per completed unit.
function progressSuffix(startedAt, done, total) {
	const elapsedMs = Date.now() - startedAt;
	if (done === 0) return `elapsed ${formatDuration(elapsedMs)}`;
	const etaMs = (elapsedMs / done) * (total - done);
	return `elapsed ${formatDuration(elapsedMs)} | ETA ${formatDuration(etaMs)}`;
}

module.exports = { formatDuration, progressSuffix };
