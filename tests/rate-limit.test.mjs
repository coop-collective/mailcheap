import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { consumeRateLimit, getClientIp, isLimitedInMemory, isRateLimited } from "../lib/rate-limit.js";

const LOGIN = { name: "login", limit: 3, window: "15 m", key: "203.0.113.7" };

function database() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(readFileSync(new URL("../migrations/0002_rate_limits.sql", import.meta.url), "utf8"));
	return { prepare: (sql) => ({ bind: (...args) => ({ first: async () => sqlite.prepare(sql).get(...args) }) }) };
}

test("D1 limits are shared by callers and reopen after expiry", async () => {
	const db = database();
	const now = 100_000;
	const results = await Promise.all(Array.from({ length: 8 }, () => consumeRateLimit(db, LOGIN, now)));
	assert.equal(results.filter((limited) => !limited).length, 3);
	assert.equal(await consumeRateLimit(db, { ...LOGIN, key: "other" }, now), false);
	assert.equal(await consumeRateLimit(db, { ...LOGIN, name: "other" }, now), false);
	assert.equal(await consumeRateLimit(db, LOGIN, now + 15 * 60_000), false);
});

test("a D1 outage denies requests rather than bypassing login limits", async (t) => {
	t.mock.method(console, "error", () => {});
	assert.equal(await isRateLimited(LOGIN, { prepare() { throw new Error("database offline"); } }), true);
});

test("trust only Cloudflare's connecting IP", () => {
	assert.equal(getClientIp(new Headers({ "x-forwarded-for": "spoofed" })), "unknown");
	assert.equal(getClientIp(new Headers({ "cf-connecting-ip": "203.0.113.8", "x-forwarded-for": "spoofed" })), "203.0.113.8");
});

test("local memory windows expire", () => {
	assert.equal(isLimitedInMemory({ ...LOGIN, limit: 1 }, 1000), false);
	assert.equal(isLimitedInMemory({ ...LOGIN, limit: 1 }, 1001), true);
	assert.equal(isLimitedInMemory({ ...LOGIN, limit: 1 }, 901000), false);
});
