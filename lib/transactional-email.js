import { BodyTooLargeError, readBoundedBody } from "./request-body.js";
import { isRateLimited } from "./rate-limit.js";
import { isPlainObject, normalizeEmail } from "./validation.js";
import { claimTransactionalEmail, finishTransactionalEmail } from "./transactional-email-store.js";

export const TRANSACTIONAL_MAX_BODY_BYTES = 128 * 1024;
const ALLOWED_FIELDS = new Set(["to", "subject", "text", "html", "replyTo"]);
const PER_KEY = { name: "api-transactional-key", limit: 100, window: "1 m" };
const PER_INSTALLATION = { name: "api-transactional-total", key: "all", limit: 1000, window: "1 h" };
const reply = (status, body, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const fail = (status, code, error) => reply(status, { error, code });
const hasControl = (value) => [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function readInput(body, from) {
	if (!isPlainObject(body)) return { error: "Send a JSON object" };
	if (Object.keys(body).some((key) => !ALLOWED_FIELDS.has(key))) return { error: "Supported fields: to, subject, text, html, replyTo" };
	const to = typeof body.to === "string" && !hasControl(body.to) && normalizeEmail(body.to);
	if (!to) return { error: "to must be one email address" };
	if (typeof body.subject !== "string" || !body.subject.trim() || body.subject.length > 200 || hasControl(body.subject)) {
		return { error: "subject must contain 1–200 characters without control characters" };
	}
	if (typeof body.text !== "string" || !body.text.trim()) return { error: "text is required" };
	if (body.html !== undefined && (typeof body.html !== "string" || !body.html.trim())) return { error: "html must be a nonempty string" };
	let replyTo;
	if (body.replyTo !== undefined) {
		replyTo = typeof body.replyTo === "string" && !hasControl(body.replyTo) && normalizeEmail(body.replyTo);
		if (!replyTo) return { error: "replyTo must be one email address" };
	}
	return { message: { from, to, subject: body.subject.trim(), text: body.text, ...(body.html !== undefined && { html: body.html }), ...(replyTo && { replyTo }) } };
}

// Return only fixed diagnostics: provider messages can contain addresses or content.
function providerFailure(error) {
	const code = error?.code;
	if (["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"].includes(code)) {
		return { status: 429, body: { error: "Cloudflare email sending quota exceeded", code: "provider_rate_limited" } };
	}
	if (["E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE"].includes(code)) {
		return { status: 503, body: { error: "Configure the sender domain in Cloudflare Email Service", code: "sender_unavailable" } };
	}
	if (["E_RECIPIENT_SUPPRESSED", "E_RECIPIENT_NOT_ALLOWED", "E_DELIVERY_FAILED"].includes(code)) {
		return { status: 422, body: { error: "Cloudflare rejected this recipient", code: "recipient_rejected" } };
	}
	if (["E_VALIDATION_ERROR", "E_FIELD_MISSING", "E_CONTENT_TOO_LARGE"].includes(code)) {
		return { status: 422, body: { error: "Cloudflare rejected the message", code: "message_rejected" } };
	}
	// A timeout/unknown failure may follow acceptance. Never retry automatically.
	return { status: 502, body: { error: "Delivery outcome is unknown; check Cloudflare Email Service logs before sending again", code: "delivery_unknown" } };
}

export function createTransactionalEmailHandler({ authenticate, getEnv, rateLimited = isRateLimited }) {
	return async function handle(request) {
		let apiKey;
		let env;
		try {
			apiKey = await authenticate(request);
			if (!apiKey) return fail(401, "invalid_api_key", "Invalid API key");
			env = await getEnv();
		} catch {
			return fail(503, "service_unavailable", "Email service is temporarily unavailable");
		}
		const from = normalizeEmail(env.TRANSACTIONAL_EMAIL_FROM);
		if (env.TRANSACTIONAL_EMAIL_ENABLED !== "true") return fail(503, "sending_disabled", "Transactional email is disabled");
		if (!from || typeof env.TRANSACTIONAL_EMAIL?.send !== "function" || !env.DB) {
			return fail(503, "not_configured", "Transactional email is not configured");
		}
		if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
			return fail(415, "unsupported_media_type", "Use Content-Type: application/json");
		}
		const key = request.headers.get("idempotency-key");
		if (key !== null && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
			return fail(400, "invalid_idempotency_key", "Idempotency-Key must contain 1–128 letters, numbers, dots, underscores, colons or hyphens");
		}
		let body;
		try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, TRANSACTIONAL_MAX_BODY_BYTES))); }
		catch (error) {
			return error instanceof BodyTooLargeError
				? fail(413, "body_too_large", "JSON body must be at most 128 KiB")
				: fail(400, "invalid_json", "Invalid JSON");
		}
		const input = readInput(body, from);
		if (input.error) return fail(400, "invalid_input", input.error);
		if (await rateLimited({ ...PER_KEY, key: String(apiKey._id) }, env.DB) || await rateLimited(PER_INSTALLATION, env.DB)) {
			return fail(429, "rate_limited", "Transactional email rate limit exceeded");
		}

		let claimId;
		if (key !== null) {
			let claim;
			try { claim = await claimTransactionalEmail(env.DB, { apiKeyId: String(apiKey._id), key, message: input.message }); }
			catch { return fail(503, "storage_unavailable", "Could not reserve the email request; no email was sent"); }
			if (claim.conflict) return fail(409, "idempotency_conflict", "This Idempotency-Key was already used with a different message");
			if (claim.pending) return fail(409, "send_in_progress_or_unknown", "A send is in progress or its outcome is unknown; check Cloudflare Email Service logs before sending again");
			if (claim.status) return reply(claim.status, claim.body, { "Idempotency-Replayed": "true" });
			claimId = claim.claimId;
		}

		let outcome;
		try {
			const result = await env.TRANSACTIONAL_EMAIL.send(input.message);
			if (typeof result?.messageId !== "string" || !result.messageId) throw new Error("Missing provider message ID");
			outcome = { status: 202, body: { id: result.messageId, status: "accepted", provider: "cloudflare" } };
		} catch (error) { outcome = providerFailure(error); }
		if (claimId) {
			try { await finishTransactionalEmail(env.DB, claimId, outcome); }
			catch {
				// The original claim still prevents resending. Report the known provider
				// outcome to this caller even if D1 could not save it for later replays.
				console.error(JSON.stringify({ event: "transactional-email-result-not-recorded", claimId }));
			}
		}
		return reply(outcome.status, outcome.body);
	};
}
