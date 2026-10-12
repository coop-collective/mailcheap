import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createTransactionalEmailHandler, TRANSACTIONAL_MAX_BODY_BYTES } from "../lib/transactional-email.js";
import { claimTransactionalEmail, finishTransactionalEmail } from "../lib/transactional-email-store.js";

let mf;
let db;
before(async () => {
	mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: "2026-10-11", modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "transactional-test" } }));
	db = await mf.getD1Database("DB");
	for (const migration of ["0002_rate_limits.sql", "0003_transactional_email_requests.sql"]) {
		await db.exec((await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8")).replace(/\n/g, " "));
	}
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.batch([db.prepare("DELETE FROM transactional_email_requests"), db.prepare("DELETE FROM rate_limits")]); });

const message = { to: "reader@example.com", subject: "Your verification code", text: "Your code is 123456." };
const request = (body = message, headers = {}) => new Request("https://mail.example.com/api/v1/emails", {
	method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
function fixture({ authenticate = async () => ({ _id: "app-key" }), environment = {}, send, rateLimited = async () => false } = {}) {
	const sent = [];
	const env = { DB: db, SENDING_ENABLED: "false", TRANSACTIONAL_EMAIL_ENABLED: "true", TRANSACTIONAL_EMAIL_FROM: "notify@example.com", TRANSACTIONAL_EMAIL: { async send(input) { sent.push(input); return send ? send(input) : { messageId: "cf-message-id" }; } }, ...environment };
	return { sent, env, handle: createTransactionalEmailHandler({ authenticate, getEnv: async () => env, rateLimited }) };
}

test("invalid and revoked API keys cannot read the body or reach the sender", async () => {
	const { handle, sent } = fixture({ authenticate: async () => null });
	const response = await handle({ get body() { assert.fail("must authenticate first"); } });
	assert.equal(response.status, 401);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(sent.length, 0);
	const failing = fixture({ authenticate: async () => { throw new Error("DB offline"); } });
	assert.equal((await failing.handle(request())).status, 503);
});

test("transactional sending requires explicit configuration independently of SES", async () => {
	for (const environment of [{ TRANSACTIONAL_EMAIL_ENABLED: "false" }, { TRANSACTIONAL_EMAIL_ENABLED: undefined }, { TRANSACTIONAL_EMAIL_FROM: "" }, { TRANSACTIONAL_EMAIL: undefined }, { DB: undefined }]) {
		const { handle, sent } = fixture({ environment });
		assert.equal((await handle(request())).status, 503);
		assert.equal(sent.length, 0);
	}
	const { handle, sent } = fixture();
	const response = await handle(request({ ...message, html: "<p>Your code is <b>123456</b>.</p>", replyTo: "Support@Example.com" }));
	assert.equal(response.status, 202);
	assert.deepEqual(await response.json(), { id: "cf-message-id", status: "accepted", provider: "cloudflare" });
	assert.deepEqual(sent, [{ from: "notify@example.com", ...message, html: "<p>Your code is <b>123456</b>.</p>", replyTo: "support@example.com" }]);
});

test("invalid payloads, sender overrides, multiple recipients and unsupported fields never send", async () => {
	const { handle, sent } = fixture();
	for (const input of [null, [], {}, { ...message, from: "spoof@example.com" }, { ...message, to: [message.to] }, { ...message, to: "one@example.com,two@example.com" }, { ...message, to: "a@example.com\r\nBcc: b@example.com" }, { ...message, subject: "a\r\nBcc: bad" }, { ...message, subject: "s".repeat(201) }, { ...message, text: " " }, { ...message, html: 42 }, { ...message, replyTo: [] }, { ...message, attachments: [] }]) {
		assert.equal((await handle(request(input))).status, 400, JSON.stringify(input));
	}
	assert.equal((await handle(request(message, { "Content-Type": "text/plain" }))).status, 415);
	assert.equal((await handle(request(message, { "Idempotency-Key": "bad key" }))).status, 400);
	assert.equal((await handle(new Request("https://example.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }))).status, 400);
	assert.equal(sent.length, 0);
});

test("JSON size is bounded for declared and streamed bodies", async () => {
	const { handle, sent } = fixture();
	assert.equal((await handle(request(message, { "Content-Length": String(TRANSACTIONAL_MAX_BODY_BYTES + 1) }))).status, 413);
	let cancelled = false;
	const streamed = new Request("https://example.com", { method: "POST", headers: { "Content-Type": "application/json" }, duplex: "half", body: new ReadableStream({
		pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); }, cancel() { cancelled = true; },
	}) });
	assert.equal((await handle(streamed)).status, 413);
	assert.equal(cancelled, true);
	assert.equal(sent.length, 0);
});

test("per-key and installation quotas are checked before sending and storage outages fail closed", async () => {
	const checked = [];
	const { handle, sent } = fixture({ rateLimited: async (limit) => { checked.push(limit); return limit.name === "api-transactional-total"; } });
	assert.equal((await handle(request())).status, 429);
	assert.deepEqual(checked.map(({ key, limit }) => ({ key, limit })), [{ key: "app-key", limit: 100 }, { key: "all", limit: 1000 }]);
	assert.equal(sent.length, 0);
	const actual = createTransactionalEmailHandler({ authenticate: async () => ({ _id: "full-key" }), getEnv: async () => fixture().env });
	await db.prepare("INSERT INTO rate_limits VALUES (?, ?, ?)").bind(JSON.stringify(["api-transactional-key", "full-key"]), 100, Date.now() + 60_000).run();
	assert.equal((await actual(request())).status, 429);
	const offline = createTransactionalEmailHandler({ authenticate: async () => ({ _id: "offline" }), getEnv: async () => fixture({ environment: { DB: { prepare() { throw new Error("offline"); } } } }).env });
	assert.equal((await offline(request())).status, 429);
});

test("same idempotency key replays results, changed payload conflicts, and keys are scoped to apps", async () => {
	const { handle, sent } = fixture();
	const headers = { "Idempotency-Key": "reset-123" };
	const first = await handle(request(message, headers));
	const replay = await handle(request(message, headers));
	assert.equal(replay.status, 202);
	assert.equal(replay.headers.get("idempotency-replayed"), "true");
	assert.deepEqual(await replay.json(), await first.json());
	assert.equal((await handle(request({ ...message, text: "Different code" }, headers))).status, 409);
	assert.equal(sent.length, 1);
	assert.equal((await fixture({ authenticate: async () => ({ _id: "another-app" }) }).handle(request(message, headers))).status, 202);
	const rows = await db.prepare("SELECT * FROM transactional_email_requests").all();
	assert.equal(rows.results.length, 2);
	assert.ok(!JSON.stringify(rows.results).includes("123456"));
	assert.ok(!JSON.stringify(rows.results).includes(message.to));
});

test("concurrent attempts send once; a pending or interrupted claim never resends", async () => {
	let release;
	const { handle, sent } = fixture({ send: () => new Promise((resolve) => { release = () => resolve({ messageId: "one-send" }); }) });
	const calls = Array.from({ length: 10 }, () => handle(request(message, { "Idempotency-Key": "concurrent" })));
	// At least one duplicate must have found the in-flight reservation.
	const firstFinished = await Promise.race(calls);
	assert.equal(firstFinished.status, 409);
	while (!release) await new Promise((resolve) => setImmediate(resolve));
	release();
	const results = await Promise.all(calls);
	assert.equal(sent.length, 1);
	assert.ok(results.some(({ status }) => status === 202));
	await claimTransactionalEmail(db, { apiKeyId: "app-key", key: "crashed", message: { from: "notify@example.com", ...message } });
	assert.equal((await handle(request(message, { "Idempotency-Key": "crashed" }))).status, 409);
	assert.equal(sent.length, 1);
});

test("provider rejections are sanitized and ambiguous failures are retained without resending", async () => {
	for (const [code, status] of [["E_SENDER_NOT_VERIFIED", 503], ["E_SENDER_DOMAIN_NOT_AVAILABLE", 503], ["E_RECIPIENT_SUPPRESSED", 422], ["E_VALIDATION_ERROR", 422], ["E_RATE_LIMIT_EXCEEDED", 429], ["E_DAILY_LIMIT_EXCEEDED", 429], ["E_INTERNAL_SERVER_ERROR", 502], [undefined, 502]]) {
		const { handle, sent } = fixture({ send: async () => { throw Object.assign(new Error("secret content and recipient"), { code }); } });
		const headers = { "Idempotency-Key": code || "network-error" };
		const first = await handle(request(message, headers));
		assert.equal(first.status, status);
		assert.ok(!(await first.text()).includes("secret content"));
		assert.equal((await handle(request(message, headers))).status, status);
		assert.equal(sent.length, 1);
	}
	const noReceipt = fixture({ send: async () => ({}) });
	assert.equal((await noReceipt.handle(request())).status, 502);
});

test("unavailable idempotency storage blocks sending; failed outcome writes preserve the original claim", async () => {
	const broken = { prepare() { throw new Error("D1 unavailable"); } };
	const { handle, sent } = fixture({ environment: { DB: broken } });
	assert.equal((await handle(request(message, { "Idempotency-Key": "offline" }))).status, 503);
	assert.equal(sent.length, 0);
	const partial = { prepare(sql) { if (sql.includes("UPDATE transactional_email_requests SET")) throw new Error("write failed"); return db.prepare(sql); } };
	const accepted = fixture({ environment: { DB: partial } });
	assert.equal((await accepted.handle(request(message, { "Idempotency-Key": "accepted" }))).status, 202);
	assert.equal((await accepted.handle(request(message, { "Idempotency-Key": "accepted" }))).status, 409);
	assert.equal(accepted.sent.length, 1);
});

test("idempotency expires after 24 hours and stale writers cannot overwrite a new claim", async () => {
	const input = { apiKeyId: "app", key: "expiry", message };
	const initial = await claimTransactionalEmail(db, input, 1000);
	await finishTransactionalEmail(db, initial.claimId, { status: 202, body: { id: "old" } });
	assert.deepEqual((await claimTransactionalEmail(db, input, 1001)).body, { id: "old" });
	const replacement = await claimTransactionalEmail(db, input, 1000 + 86_400_000);
	assert.ok(replacement.claimId);
	assert.notEqual(replacement.claimId, initial.claimId);
	await finishTransactionalEmail(db, initial.claimId, { status: 202, body: { id: "stale" } });
	assert.deepEqual(await claimTransactionalEmail(db, input, 1000 + 86_400_001), { pending: true });
});
