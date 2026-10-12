const RETENTION_MS = 24 * 60 * 60 * 1000;

// Keep only hashes and outcomes, never message content or reset/verification links.
// The atomic claim prevents concurrent requests from both reaching the provider.
export async function claimTransactionalEmail(db, { apiKeyId, key, message }, now = Date.now()) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(message)));
	const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
	const claimId = crypto.randomUUID();
	const claimed = await db.prepare(`
		INSERT INTO transactional_email_requests (api_key_id, idempotency_key, request_hash, claim_id, expires_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(api_key_id, idempotency_key) DO UPDATE SET
			request_hash = excluded.request_hash, claim_id = excluded.claim_id,
			expires_at = excluded.expires_at, http_status = NULL, response_json = NULL
		WHERE transactional_email_requests.expires_at <= ?
		RETURNING claim_id
	`).bind(apiKeyId, key, hash, claimId, now + RETENTION_MS, now).first();
	if (claimed) return { claimId };
	const existing = await db.prepare(`
		SELECT request_hash, http_status, response_json FROM transactional_email_requests
		WHERE api_key_id = ? AND idempotency_key = ?
	`).bind(apiKeyId, key).first();
	if (!existing) throw new Error("Idempotency record unavailable");
	if (existing.request_hash !== hash) return { conflict: true };
	if (!existing.http_status) return { pending: true };
	return { status: existing.http_status, body: JSON.parse(existing.response_json) };
}

export async function finishTransactionalEmail(db, claimId, { status, body }) {
	await db.prepare(`
		UPDATE transactional_email_requests SET http_status = ?, response_json = ? WHERE claim_id = ?
	`).bind(status, JSON.stringify(body), claimId).run();
}
