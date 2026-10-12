import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import Campaign from "../models/Campaign.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import { applyEmailEventUpdates, recordEmailAccepted, recordEmailRejected } from "../lib/email-persistence.js";
import { getTrackingPlan } from "../lib/email-event-mapping.js";

const newsletterId = "123456789012345678901234";
let mf;
let db;
before(async () => {
	mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: "2026-10-01", modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "email-persistence" } }));
	db = await mf.getD1Database("DB");
	const migration = await readFile(new URL("../migrations/0001_d1_documents.sql", import.meta.url), "utf8");
	await db.exec(migration.replace(/^--.*$/gm, "").split("\n").filter(Boolean).join(" "));
	for (const model of [Campaign, Contact, Message]) model._db = async () => db;
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.batch(["campaigns", "contacts", "messages"].map((table) => db.prepare(`DELETE FROM ${table}`))); });

async function fixture({ kind = "campaign", email = "reader@example.com" } = {}) {
	const campaign = await Campaign.create({ newsletterId });
	const contact = await Contact.create({ newsletterId, email, subscribedAt: new Date("2026-01-01") });
	const message = await Message.create({ newsletterId, campaignId: campaign._id, contactId: contact._id, email: contact.email, kind, status: "processing", processingAt: new Date() });
	return { campaign, contact, message };
}

function failingTransaction() {
	return {
		prepare: (sql) => db.prepare(sql),
		batch: (statements) => db.batch([...statements, db.prepare("INSERT INTO missing_email_test_table VALUES (1)")]),
	};
}

test("concurrent event redeliveries increment campaign/contact counters only once", async () => {
	const { campaign, contact, message } = await fixture();
	await Promise.all(Array.from({ length: 10 }, () => applyEmailEventUpdates(db, message, getTrackingPlan("Click"))));
	const savedCampaign = await Campaign.findById(campaign._id).lean();
	const savedContact = await Contact.findById(contact._id).lean();
	assert.equal(savedCampaign.stats.opened, 1);
	assert.equal(savedCampaign.stats.clicked, 1);
	assert.equal(savedContact.stats.opens, 1);
	assert.equal(savedContact.stats.clicks, 1);
	assert.ok((await Message.findById(message._id).lean()).clickedAt instanceof Date);
});

test("a failed event transaction rolls back markers and counters, so retry recovers both", async () => {
	const { campaign, contact, message } = await fixture();
	const plan = getTrackingPlan("Click");
	await assert.rejects(applyEmailEventUpdates(failingTransaction(), message, plan), /missing_email_test_table/);
	assert.equal((await Message.findById(message._id).lean()).openedAt, undefined);
	assert.equal((await Campaign.findById(campaign._id).lean()).stats.opened, 0);
	assert.equal((await Contact.findById(contact._id).lean()).stats.opens, 0);
	await applyEmailEventUpdates(db, message, plan);
	assert.equal((await Campaign.findById(campaign._id).lean()).stats.opened, 1);
	assert.equal((await Contact.findById(contact._id).lean()).stats.opens, 1);
});

test("accepted-message persistence is atomic and idempotent without another email call", async () => {
	const input = { ...(await fixture()), providerMessageId: "cf-accepted", sentAt: new Date() };
	await assert.rejects(recordEmailAccepted(failingTransaction(), input), /missing_email_test_table/);
	assert.equal((await Message.findById(input.message._id).lean()).status, "processing");
	assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.sent, 0);
	const receipts = await Promise.all(Array.from({ length: 5 }, () => recordEmailAccepted(db, input)));
	assert.equal(receipts.filter(({ recorded }) => recorded).length, 1);
	assert.ok(receipts.every(({ correlated }) => correlated));
	assert.equal((await Message.findById(input.message._id).lean()).status, "sent");
	assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.sent, 1);
	assert.equal((await Contact.findById(input.contact._id).lean()).stats.sent, 1);
	assert.equal((await Contact.findById(input.contact._id).lean()).ignoredIssues, 1);
});

test("permanent rejection counters and status commit together once", async () => {
	const input = { ...(await fixture()), error: new Error("Invalid recipient") };
	await assert.rejects(recordEmailRejected(failingTransaction(), input), /missing_email_test_table/);
	assert.equal((await Message.findById(input.message._id).lean()).status, "processing");
	await recordEmailRejected(db, input);
	await recordEmailRejected(db, input);
	assert.equal((await Message.findById(input.message._id).lean()).status, "failed");
	assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.failed, 1);
});

test("late acceptance preserves every advanced event status and its diagnostic", async () => {
	for (const status of ["delivered", "bounced", "complained", "failed"]) {
		const input = { ...(await fixture({ email: `${status}@example.com` })), providerMessageId: `ses-${status}`, sentAt: new Date() };
		await Message.updateOne({ _id: input.message._id }, { $set: { status, error: `${status} event detail` } });
		assert.deepEqual(await recordEmailAccepted(db, input), { correlated: true, recorded: true });
		const saved = await Message.findById(input.message._id).lean();
		assert.equal(saved.status, status);
		assert.equal(saved.error, `${status} event detail`);
		assert.equal(saved.providerMessageId, input.providerMessageId);
		assert.equal(saved.sentAt.getTime(), input.sentAt.getTime());
		assert.equal(saved.processingAt, undefined);
		assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.sent, 1);
	}
});

test("acceptance and bounce transactions remain monotonic under concurrent redelivery", async () => {
	const input = { ...(await fixture()), providerMessageId: "ses-concurrent", sentAt: new Date() };
	const plan = {
		firsts: [{ field: "bouncedAt", stat: "bounced" }], occurredAt: new Date(),
		status: { to: "bounced", from: ["queued", "processing", "uncertain", "sent", "delivered"] },
		error: "Hard bounce: unknown recipient", engagement: null,
	};
	await Promise.all(Array.from({ length: 10 }, () => Promise.all([
		recordEmailAccepted(db, input), applyEmailEventUpdates(db, input.message, plan),
	])));
	const saved = await Message.findById(input.message._id).lean();
	const campaign = await Campaign.findById(input.campaign._id).lean();
	assert.equal(saved.status, "bounced");
	assert.equal(saved.error, plan.error);
	assert.ok(saved.sentAt instanceof Date);
	assert.equal(campaign.stats.sent, 1);
	assert.equal(campaign.stats.bounced, 1);
	assert.equal((await Contact.findById(input.contact._id).lean()).stats.sent, 1);
});

test("recovered acceptance resolves an uncertain send without requiring a second transport call", async () => {
	const input = { ...(await fixture()), providerMessageId: "ses-recovered", sentAt: new Date() };
	await Message.updateOne({ _id: input.message._id }, { $set: { status: "uncertain", error: "Transport timed out" } });
	assert.deepEqual(await recordEmailAccepted(db, input), { correlated: true, recorded: true });
	assert.deepEqual(await recordEmailAccepted(db, input), { correlated: true, recorded: false });
	const saved = await Message.findById(input.message._id).lean();
	assert.equal(saved.status, "sent");
	assert.equal(saved.error, undefined);
	assert.equal(saved.processingAt, undefined);
	assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.sent, 1);
});

test("provider correlation is rechecked transactionally before changing IDs or counters", async () => {
	const input = { ...(await fixture()), providerMessageId: "ses-wrong", sentAt: new Date() };
	await Message.updateOne({ _id: input.message._id }, { $set: { providerMessageId: "ses-correct" } });
	assert.deepEqual(await recordEmailAccepted(db, input), { correlated: false, recorded: false });
	const saved = await Message.findById(input.message._id).lean();
	assert.equal(saved.providerMessageId, "ses-correct");
	assert.equal(saved.sentAt, undefined);
	assert.equal(saved.status, "processing");
	assert.equal((await Campaign.findById(input.campaign._id).lean()).stats.sent, 0);
	assert.equal((await Contact.findById(input.contact._id).lean()).stats.sent, 0);
});

test("test email acceptance needs no contact and does not change campaign recipient counts", async () => {
	const campaign = await Campaign.create({ newsletterId });
	const message = await Message.create({ newsletterId, campaignId: campaign._id, email: "test@example.com", kind: "test" });
	const input = { message, providerMessageId: "ses-test", sentAt: new Date() };
	assert.deepEqual(await recordEmailAccepted(db, input), { correlated: true, recorded: true });
	assert.equal((await Message.findById(message._id).lean()).status, "sent");
	assert.equal((await Campaign.findById(campaign._id).lean()).stats.sent, 0);
	assert.equal(await Contact.countDocuments(), 0);
});

test("out-of-order acceptance preserves later contact activity and does not call an opened issue ignored", async () => {
	const input = { ...(await fixture()), providerMessageId: "ses-opened", sentAt: new Date("2026-03-01T00:00:00Z") };
	await applyEmailEventUpdates(db, input.message, getTrackingPlan("Click", new Date("2026-03-01T00:00:01Z")));
	await recordEmailAccepted(db, input);
	assert.equal((await Contact.findById(input.contact._id).lean()).ignoredIssues, 0);
	const lastChance = { ...(await fixture({ kind: "last-chance", email: "other@example.com" })), providerMessageId: "ses-last-chance", sentAt: new Date("2026-03-01") };
	const later = new Date("2026-04-01");
	await Contact.updateOne({ _id: lastChance.contact._id }, { $set: { lastSentAt: later, lastChanceAt: later } });
	await recordEmailAccepted(db, lastChance);
	const savedContact = await Contact.findById(lastChance.contact._id).lean();
	assert.equal(savedContact.lastSentAt.getTime(), later.getTime());
	assert.equal(savedContact.lastChanceAt.getTime(), later.getTime());
	assert.equal((await Campaign.findById(lastChance.campaign._id).lean()).lastChance.sent, 1);
});

test("late delay/failure events cannot replace a delivered or bounced diagnostic", async () => {
	const { message } = await fixture();
	const delay = { firsts: [], occurredAt: new Date(), status: null, error: "Delivery temporarily delayed" };
	await applyEmailEventUpdates(db, message, delay);
	assert.equal((await Message.findById(message._id).lean()).error, delay.error);
	const delivery = { firsts: [{ field: "deliveredAt", stat: "delivered" }], occurredAt: new Date(), status: { to: "delivered", from: ["queued", "processing", "uncertain", "sent", "failed"] } };
	await applyEmailEventUpdates(db, message, delivery);
	await applyEmailEventUpdates(db, message, delay);
	assert.equal((await Message.findById(message._id).lean()).error, undefined);
	await Message.updateOne({ _id: message._id }, { $set: { status: "bounced", error: "Hard bounce" } });
	await applyEmailEventUpdates(db, message, delay);
	await applyEmailEventUpdates(db, message, delivery);
	await recordEmailRejected(db, { message, error: new Error("Late rejection") });
	const saved = await Message.findById(message._id).lean();
	assert.equal(saved.status, "bounced");
	assert.equal(saved.error, "Hard bounce");
});
