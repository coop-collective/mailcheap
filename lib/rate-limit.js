import { getCloudflareEnv } from "./cloudflare.js";

const memory = new Map();
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

function windowMs(window) {
	const [amount, unit] = String(window).trim().split(/\s+/);
	const duration = Number(amount) * (UNIT_MS[unit] ?? Number.NaN);
	if (!Number.isSafeInteger(duration) || duration <= 0) throw new Error("Invalid rate limit window");
	return duration;
}

// Local utility-test fallback only. Deployed Workers always use D1 and deny
// requests if it is unavailable, so isolate churn cannot bypass login limits.
export function isLimitedInMemory({ name, limit, window, key }, now = Date.now()) {
	const id = `${name}:${key}`;
	const hits = (memory.get(id) ?? []).filter((time) => now - time < windowMs(window));
	const limited = hits.length >= limit;
	if (!limited) hits.push(now);
	memory.delete(id);
	memory.set(id, hits);
	if (memory.size > 10_000) memory.delete(memory.keys().next().value);
	return limited;
}

// One SQL statement atomically resets expired windows or consumes one slot.
// No per-isolate read/modify/write race. Window starts with the first request.
export async function consumeRateLimit(db, { name, limit, window, key }, now = Date.now()) {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid rate limit");
	const expiresAt = now + windowMs(window);
	const row = await db.prepare(`
		INSERT INTO rate_limits (key, hits, expires_at) VALUES (?, 1, ?)
		ON CONFLICT(key) DO UPDATE SET
			hits = CASE WHEN expires_at <= ? THEN 1 ELSE hits + 1 END,
			expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END
		WHERE expires_at <= ? OR hits < ?
		RETURNING hits
	`).bind(JSON.stringify([name, key]), expiresAt, now, now, now, limit).first();
	return !row;
}

export function getClientIp(headers) {
	// Cloudflare overwrites this header at the edge. Client-supplied forwarding
	// headers are never a trusted identity for rate limits.
	return headers.get("cf-connecting-ip") || "unknown";
}

export async function isRateLimited(options, db) {
	try {
		if (!db) db = (await getCloudflareEnv()).DB;
		if (!db) throw new Error("DB binding is missing");
		return await consumeRateLimit(db, options);
	} catch (error) {
		if (process.env.NODE_ENV !== "production" && error.code === "ERR_UNSUPPORTED_ESM_URL_SCHEME") {
			return isLimitedInMemory(options);
		}
		console.error(JSON.stringify({ event: "rate-limit-unavailable", name: options.name, error: error.message }));
		return true;
	}
}
