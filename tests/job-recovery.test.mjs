import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import Campaign from "../models/Campaign.js";
import Message from "../models/Message.js";
import { recoverQueuedEmails, findCompletedCampaigns } from "../lib/job-recovery.js";

let mf, db;
const newsletterId = "123456789012345678901234";
const now = Date.now();
before(async () => {
	mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: "2026-10-11", modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "job-recovery" } }));
	db = await mf.getD1Database("DB");
	const migration = await readFile(new URL("../migrations/0001_d1_documents.sql", import.meta.url), "utf8");
	await db.exec(migration.replace(/^--.*$/gm, "").split("\n").filter(Boolean).join(" "));
	for (const model of [Campaign, Message]) model._db = async () => db;
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.batch(["campaigns", "messages"].map((table) => db.prepare(`DELETE FROM ${table}`))); });
async function message(extra = {}) {
	return Message.create({ newsletterId, email: "reader@example.com", kind: "confirmation", status: "queued", createdAt: new Date(now - 180_000), ...extra });
}

test("cron recovers welcome and active campaign publication but never paused, recent or ambiguous sends", async () => {
	const active = await Campaign.create({ newsletterId, status: "sending" });
	const paused = await Campaign.create({ newsletterId, status: "paused" });
	const expected = [];
	for (const kind of ["welcome", "confirmation", "campaign", "last-chance"]) expected.push((await message({ kind, campaignId: active._id }))._id);
	await message({ kind: "campaign", campaignId: paused._id });
	await message({ kind: "test" });
	await message({ createdAt: new Date(now) });
	for (const status of ["processing", "uncertain", "sent", "failed"]) await message({ status });
	let published;
	assert.equal(await recoverQueuedEmails(db, { sendBatch: async (jobs) => { published = jobs; } }, now), 4);
	assert.deepEqual(published.flatMap(({ body }) => body.messageIds).sort(), expected.sort());
	// Recovery only publishes IDs; the queue consumer still has to claim them.
	assert.equal(await Message.countDocuments({ status: "processing" }), 1);
});

test("cron settles completed sends but leaves campaigns with pending or uncertain delivery alone", async () => {
	const completed = await Campaign.create({ newsletterId, status: "sending" });
	await message({ kind: "campaign", campaignId: completed._id, status: "delivered" });
	for (const status of ["queued", "processing", "uncertain"]) {
		const campaign = await Campaign.create({ newsletterId, status: "sending" });
		await message({ kind: "campaign", campaignId: campaign._id, status });
	}
	await Campaign.create({ newsletterId, status: "paused" });
	assert.deepEqual(await findCompletedCampaigns(db), [completed._id]);
});

test("publication errors propagate for retry without changing stored message status", async () => {
	const queued = await message();
	await assert.rejects(recoverQueuedEmails(db, { sendBatch: async () => { throw new Error("queue unavailable"); } }, now), /queue unavailable/);
	assert.equal((await Message.findById(queued._id).lean()).status, "queued");
});
