import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import { generateApiKey } from "../lib/api-key-tokens.js";

test("transactional route authenticates real D1 API keys and sends through the local Workers email binding", async () => {
	const bundled = await build({
		stdin: { contents: 'import { POST } from "./app/api/v1/emails/route.js"; export default { fetch: POST };', resolveDir: process.cwd() },
		bundle: true, write: false, format: "esm", platform: "neutral", target: "es2022", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"],
		alias: { "@": process.cwd() },
		plugins: [{ name: "server-only-marker", setup(build) {
			build.onResolve({ filter: /^server-only$/ }, () => ({ path: "server-only", namespace: "empty" }));
			build.onLoad({ filter: /.*/, namespace: "empty" }, () => ({ contents: "export {};" }));
		} }],
	});
	const mf = new Miniflare(convertV4MiniflareOptions({
		compatibilityDate: "2026-10-11", compatibilityFlags: ["nodejs_compat"], modules: true, script: bundled.outputFiles[0].text,
		log: new Log(LogLevel.ERROR), d1Databases: { DB: "transactional-route-test" },
		bindings: { TRANSACTIONAL_EMAIL_ENABLED: "true", TRANSACTIONAL_EMAIL_FROM: "notify@example.com", SENDING_ENABLED: "false" },
		email: { send_email: [{ name: "TRANSACTIONAL_EMAIL", allowed_sender_addresses: ["notify@example.com"] }] },
	}));
	try {
		const db = await mf.getD1Database("DB");
		for (const migration of ["0001_d1_documents.sql", "0002_rate_limits.sql", "0003_transactional_email_requests.sql"]) {
			await db.exec((await readFile(new URL(`../migrations/${migration}`, import.meta.url), "utf8")).replace(/^--.*$/gm, "").replace(/\n/g, " "));
		}
		const { key, hash, prefix } = generateApiKey();
		const id = "012345678901234567890123";
		await db.prepare("INSERT INTO apikeys (document) VALUES (?)").bind(JSON.stringify({ _id: id, name: "Test app", hash, prefix, revokedAt: null })).run();
		const request = (token) => mf.dispatchFetch("https://mail.example.com/api/v1/emails", {
			method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": "workerd-message" },
			body: JSON.stringify({ to: "local-recipient@example.com", subject: "Local binding test", text: "Simulated only", html: "<p>Simulated only</p>", replyTo: "support@example.com" }),
		});
		assert.equal((await request("invalid")).status, 401);
		const response = await request(key);
		const body = await response.json();
		assert.equal(response.status, 202, JSON.stringify(body));
		assert.equal(body.provider, "cloudflare");
		assert.ok(body.id);
		const replay = await request(key);
		assert.equal(replay.headers.get("idempotency-replayed"), "true");
		assert.deepEqual(await replay.json(), body);
		await db.prepare("UPDATE apikeys SET document = json_set(document, '$.revokedAt', ?)").bind(new Date().toISOString()).run();
		assert.equal((await request(key)).status, 401);
	} finally { await mf.dispose(); }
});
