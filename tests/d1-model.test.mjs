import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
		if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}.js`, import.meta.url).href, context);
		return nextResolve(specifier, context);
	},
});
const { getSubscriberHistory, getEmailStats, getHourlySends } = await import("../lib/overview-data.js");
const { listNewslettersWithActiveCounts, upsertContact } = await import("../lib/contacts.js");
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import Newsletter from "../models/Newsletter.js";
import Campaign from "../models/Campaign.js";
import Contact from "../models/Contact.js";
import Message from "../models/Message.js";
import Suppression from "../models/Suppression.js";
import Alert from "../models/Alert.js";
import Event from "../models/Event.js";
import ApiKey from "../models/ApiKey.js";
import { recentCampaignsPipeline, sendTimesPipeline } from "../lib/campaign-queries.js";
import { cleanupTotalsPipeline } from "../lib/cleanup.js";
import { MESSAGE_STATS_GROUP } from "../lib/message-stats.js";
import { AUDIENCE_SORT } from "../lib/audience.js";
import { dayBuckets, hourBuckets } from "../lib/d1-time-buckets.js";
import { Sql } from "../lib/d1-sql.js";

const models = [Newsletter, Campaign, Contact, Message, Suppression, Alert, Event, ApiKey];
const newsletterId = "012345678901234567890123";
let mf;
let db;
before(async () => {
	mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: "2026-10-01", modules: true, script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "mailcheap-test" } }));
	db = await mf.getD1Database("DB");
	const migration = await readFile(new URL("../migrations/0001_d1_documents.sql", import.meta.url), "utf8");
	await db.exec(migration.replace(/^--.*$/gm, "").split("\n").filter(Boolean).join(" "));
	for (const model of models) model._db = async () => db;
});
after(async () => { await mf?.dispose(); });
beforeEach(async () => { await db.batch(models.map(({ table }) => db.prepare(`DELETE FROM ${table}`))); });

async function contact(input = {}) { return Contact.create({ newsletterId, email: "reader@example.com", ...input }); }

test("D1 preserves defaults, normalization, public IDs and Date round trips", async () => {
	const reader = await contact({ email: " Reader@Example.COM " });
	assert.match(reader._id, /^[0-9a-f]{24}$/);
	assert.equal(reader.email, "reader@example.com");
	assert.equal(reader.status, "active");
	assert.ok(reader.subscribedAt instanceof Date);
	assert.deepEqual(reader.stats, { sent: 0, opens: 0, clicks: 0 });
	const campaign = await Campaign.create({ newsletterId });
	assert.equal(campaign.stats.sent, 0);
	assert.equal(campaign.lastChance.dormant, 0);
	assert.equal(campaign.archiveListed, true);
	assert.equal((await Campaign.findById(campaign._id).select("archiveListed archivePinned").lean()).archiveListed, true);
	const found = await Contact.findById(reader._id).select("email subscribedAt").lean();
	assert.deepEqual(Object.keys(found).sort(), ["_id", "email", "subscribedAt"]);
	assert.equal(found.subscribedAt.getTime(), reader.subscribedAt.getTime());
	await assert.rejects(contact(), { code: 11000 });
	await assert.rejects(Contact.create({ email: "missing@example.com" }), /newsletterId is required/);
});

test("atomic conditional claims permit exactly one queue consumer; increments never lose counts", async () => {
	const message = await Message.create({ newsletterId, kind: "test", email: "reader@example.com" });
	const claims = await Promise.all(Array.from({ length: 20 }, () => Message.updateOne({ _id: message._id, status: "queued" }, { $set: { status: "processing", processingAt: new Date() } })));
	assert.equal(claims.reduce((sum, result) => sum + result.matchedCount, 0), 1);
	const campaign = await Campaign.create({ newsletterId });
	await Promise.all(Array.from({ length: 40 }, () => Campaign.updateOne({ _id: campaign._id }, { $inc: { "stats.sent": 1 } })));
	assert.equal((await Campaign.findById(campaign._id).lean()).stats.sent, 40);
});

test("upserts preserve existing opt-outs and metadata identifies just one new subscriber", async () => {
	const options = { upsert: true, returnDocument: "after", includeResultMetadata: true };
	const results = await Promise.all(Array.from({ length: 12 }, () => Contact.findOneAndUpdate({ newsletterId, email: "reader@example.com" }, { $setOnInsert: { status: "unsubscribed" } }, options).lean()));
	assert.equal(results.filter(({ lastErrorObject }) => !lastErrorObject.updatedExisting).length, 1);
	assert.equal(new Set(results.map(({ value }) => value._id)).size, 1);
	const again = await Contact.findOneAndUpdate({ newsletterId, email: "reader@example.com" }, { $setOnInsert: { status: "active" } }, options).lean();
	assert.equal(again.value.status, "unsubscribed");
	const previous = await Contact.findOneAndUpdate({ newsletterId, status: "unsubscribed" }, { $set: { status: "active" } }).select("status").lean();
	assert.equal(previous.status, "unsubscribed");
});

test("cooldown upsert conflicts rather than overwriting a recent alert", async () => {
	const cutoff = new Date(Date.now() - 60_000);
	const claim = () => Alert.updateOne({ key: "warning", $or: [{ lastSentAt: { $lt: cutoff } }, { lastSentAt: null }] }, { $set: { lastSentAt: new Date(), title: "Warning" } }, { upsert: true });
	await claim();
	await assert.rejects(claim(), { code: 11000 });
	assert.equal(await Alert.countDocuments(), 1);
});

test("partial unique indexes protect campaign/last-chance sends and provider event dedup", async () => {
	const base = { newsletterId, campaignId: "111111111111111111111111", contactId: "222222222222222222222222", email: "reader@example.com" };
	await Message.create({ ...base, kind: "campaign" });
	await assert.rejects(Message.create({ ...base, kind: "campaign" }), { code: 11000 });
	await Message.create({ ...base, kind: "last-chance" });
	await assert.rejects(Message.create({ ...base, kind: "last-chance" }), { code: 11000 });
	await Message.create({ ...base, kind: "test", providerMessageId: "message-1" });
	await assert.rejects(Message.create({ ...base, kind: "test", providerMessageId: "message-1" }), { code: 11000 });
	await Message.create({ ...base, kind: "test" });
	await Event.create({ type: "Bounce", providerEventId: "event-1" });
	await assert.rejects(Event.create({ type: "Bounce", providerEventId: "event-1" }), { code: 11000 });
	await Event.create({ type: "Bounce" });
	await Event.create({ type: "Bounce" });
	await Campaign.create({ newsletterId });
	await Campaign.create({ newsletterId });
	await Campaign.create({ newsletterId, archiveSlug: "unique" });
	await assert.rejects(Campaign.create({ newsletterId, archiveSlug: "unique" }), { code: 11000 });
});

test("updates handle null/missing, dates, nested min/max/unset and large membership lists", async () => {
	const reader = await contact();
	assert.equal(await Contact.countDocuments({ confirmedAt: null }), 1);
	assert.equal(await Contact.countDocuments({ confirmedAt: { $exists: false } }), 1);
	const early = new Date("2026-01-01"); const late = new Date("2026-02-01");
	await Contact.updateOne({ _id: reader._id }, { $max: { lastOpenAt: late }, $min: { lastSentAt: early } });
	await Contact.updateOne({ _id: reader._id }, { $max: { lastOpenAt: early }, $min: { lastSentAt: late }, $inc: { "stats.opens": 2 } });
	const result = await Contact.findById(reader._id).lean();
	assert.equal(result.lastOpenAt.getTime(), late.getTime());
	assert.equal(result.lastSentAt.getTime(), early.getTime());
	assert.equal(result.stats.opens, 2);
	assert.equal(await Contact.countDocuments({ lastOpenAt: { $type: "date", $gte: late, $lte: late } }), 1);
	await Contact.updateOne({ _id: reader._id }, { $unset: { lastOpenAt: 1 } });
	assert.equal(await Contact.countDocuments({ lastOpenAt: { $exists: true } }), 0);
	assert.equal(await Contact.countDocuments({ email: { $in: [...Array(1500).fill("absent@example.com"), reader.email] } }), 1);
	assert.equal(await Contact.countDocuments({ email: { $nin: [reader.email] } }), 0);
	assert.equal(await Contact.countDocuments({ email: { $regex: "^reader@" } }), 1);
});

test("bulk imports report created/existing counts and cannot reactivate an opt-out", async () => {
	await contact({ status: "unsubscribed" });
	const result = await Contact.bulkWrite(["reader@example.com", "new@example.com"].map((email) => ({ updateOne: { filter: { newsletterId, email }, update: { $setOnInsert: { status: "active" }, $set: { "imported.openRate": 0.4 } }, upsert: true } })));
	assert.equal(result.upsertedCount, 1);
	assert.equal(result.matchedCount, 1);
	assert.equal((await Contact.findOne({ email: "reader@example.com" }).lean()).status, "unsubscribed");
});

test("keyset cursor stays bounded and visits all recipients while their status changes", async () => {
	await Contact.insertMany(Array.from({ length: 425 }, (_, i) => ({ newsletterId, email: `reader-${i}@example.com`, ...(i % 2 && { imported: { openRate: i % 3, clickRate: 0.5 } }) })));
	const ids = [];
	const cursor = Contact.find({ newsletterId, status: "active" }).sort(AUDIENCE_SORT).select("email").lean().cursor();
	for await (const row of cursor) {
		ids.push(row._id);
		assert.deepEqual(Object.keys(row).sort(), ["_id", "email"]);
		if (ids.length % 100 === 0) await Contact.updateMany({ _id: { $in: ids.slice(-100) } }, { $set: { status: "dormant" } });
	}
	assert.equal(new Set(ids).size, 425);
	const page = await Contact.find().sort({ email: 1 }).skip(5).limit(7).lean();
	assert.equal(page.length, 7);
});

test("saving an edited document patches changed fields without overwriting concurrent stats", async () => {
	const draft = await Campaign.create({ newsletterId });
	await Campaign.updateOne({ _id: draft._id }, { $inc: { "stats.sent": 5 } });
	draft.subject = "New title";
	draft.scheduledAt = undefined;
	await draft.save();
	const saved = await Campaign.findById(draft._id).lean();
	assert.equal(saved.subject, "New title");
	assert.equal(saved.stats.sent, 5);
});

test("campaign projections, date coalescing, sorting and grouping execute in D1", async () => {
	await Campaign.create({ newsletterId, subject: "draft", updatedAt: new Date("2026-01-01") });
	await Campaign.create({ newsletterId, subject: "later", status: "scheduled", scheduledAt: new Date("2026-02-01") });
	await Campaign.create({ newsletterId, subject: "sent", status: "sent", sentAt: new Date("2026-01-15") });
	const recent = await Campaign.aggregate(recentCampaignsPipeline(2, newsletterId));
	assert.deepEqual(recent.map(({ subject }) => subject), ["later", "sent"]);
	assert.ok(recent[0].activityAt instanceof Date);
	assert.equal(recent[0].html, undefined);
	const times = await Campaign.aggregate(sendTimesPipeline({ newsletterId }));
	assert.equal(times.length, 2);
	assert.ok(times[0].at instanceof Date);
	await Message.create({ newsletterId, email: "a@example.com", kind: "test", provider: "gmail", sentAt: new Date(), openedAt: new Date() });
	await Message.create({ newsletterId, email: "b@example.com", kind: "test", sentAt: new Date() });
	const groups = await Message.aggregate([{ $group: { _id: { $ifNull: ["$provider", "other"] }, ...MESSAGE_STATS_GROUP } }, { $sort: { _id: 1 } }]);
	assert.deepEqual(groups.map(({ _id, sent, opened }) => ({ _id, sent, opened })), [{ _id: "gmail", sent: 1, opened: 1 }, { _id: "other", sent: 1, opened: 0 }]);
});

test("cleanup reports preserve null-safe max/condition/boolean semantics", async () => {
	const at = new Date("2026-02-01");
	await contact({ email: "waiting@example.com", subscribedAt: new Date("2025-01-01"), lastChanceAt: at });
	await contact({ email: "kept@example.com", subscribedAt: new Date("2025-01-01"), lastChanceAt: at, lastOpenAt: new Date("2026-03-01") });
	await contact({ email: "dormant@example.com", status: "dormant", lastChanceAt: at });
	const [counts] = await Contact.aggregate(cleanupTotalsPipeline(newsletterId));
	assert.deepEqual(counts, { _id: null, waiting: 1, kept: 1, dormant: 1 });
});

test("lookup counts and unwind joins are correlated in SQL", async () => {
	const first = await Newsletter.create({ name: "First", slug: "first", fromEmail: "a@example.com" });
	await Newsletter.create({ name: "Other", slug: "other", fromEmail: "b@example.com" });
	await contact({ newsletterId: first._id });
	await contact({ newsletterId: first._id, email: "left@example.com", status: "unsubscribed" });
	const rows = await Newsletter.aggregate([
		{ $sort: { createdAt: 1 } },
		{ $project: { name: 1 } },
		{ $lookup: { from: "contacts", localField: "_id", foreignField: "newsletterId", pipeline: [{ $match: { status: "active" } }, { $count: "count" }], as: "active" } },
		{ $set: { activeCount: { $ifNull: [{ $first: "$active.count" }, 0] } } },
		{ $unset: "active" },
	]);
	assert.deepEqual(rows.map(({ name, activeCount }) => ({ name, activeCount })), [{ name: "First", activeCount: 1 }, { name: "Other", activeCount: 0 }]);
	await Suppression.create({ email: "reader@example.com", reason: "bounce" });
	const joined = await Suppression.aggregate([
		{ $lookup: { from: "contacts", localField: "email", foreignField: "email", pipeline: [{ $match: { newsletterId: first._id } }, { $project: { subscribedAt: 1 } }], as: "contact" } },
		{ $unwind: "$contact" },
		{ $project: { _id: 0, leftAt: "$createdAt", contact: 1 } },
	]);
	assert.equal(joined.length, 1);
	assert.ok(joined[0].leftAt instanceof Date);
	assert.ok(joined[0].contact.subscribedAt instanceof Date);
});

test("timezone buckets preserve spring/fall DST and D1 groups into local days", async () => {
	assert.equal(dayBuckets(["2026-03-08"], "America/New_York")[0].end - dayBuckets(["2026-03-08"], "America/New_York")[0].start, 23 * 3600000);
	assert.equal(dayBuckets(["2026-11-01"], "America/New_York")[0].end - dayBuckets(["2026-11-01"], "America/New_York")[0].start, 25 * 3600000);
	const hours = hourBuckets(["2026-11-01"], "America/New_York");
	assert.equal(hours.filter(({ value }) => value === 1).reduce((sum, { start, end }) => sum + end - start, 0), 2 * 3600000);
	await Message.create({ newsletterId, kind: "test", email: "a@example.com", sentAt: new Date("2026-11-01T05:30:00Z") });
	await Message.create({ newsletterId, kind: "test", email: "b@example.com", sentAt: new Date("2026-11-01T06:30:00Z") });
	const rows = await Message.aggregate([{ $group: { _id: { day: { $dateBucket: { date: "$sentAt", buckets: dayBuckets(["2026-11-01"], "America/New_York") } }, hour: { $dateBucket: { date: "$sentAt", buckets: hours } } }, count: { $sum: 1 } } }]);
	assert.deepEqual(rows, [{ _id: { day: "2026-11-01", hour: 1 }, count: 2 }]);
});

test("filter keys and unsupported operations fail closed; indexed lookups use D1 indexes", async () => {
	await assert.rejects(Contact.find({ "email') OR 1=1 --": "x" }).lean(), /Invalid document field/);
	await assert.rejects(Contact.updateMany({}, { $rename: { email: "x" } }), /Unsupported D1 update/);
	const sql = new Sql();
	const plan = await db.prepare(`EXPLAIN QUERY PLAN SELECT document FROM contacts WHERE ${sql.where({ newsletterId, email: "reader@example.com" })}`).bind(...sql.values).all();
	assert.ok(plan.results.some(({ detail }) => detail.includes("contacts_newsletter_email")));
});

test("dashboard reports run the application's real pipelines against D1", async () => {
	const now = new Date("2026-10-11T12:00:00Z");
	await contact({ email: "old@example.com", subscribedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01") });
	await contact({ email: "new@example.com", subscribedAt: new Date("2026-10-01"), createdAt: new Date("2026-10-01") });
	await contact({ email: "import@example.com", source: "import", subscribedAt: new Date("2026-10-05"), createdAt: new Date("2026-10-05") });
	await contact({ email: "left@example.com", status: "unsubscribed", subscribedAt: new Date("2026-09-01"), createdAt: new Date("2026-09-01"), unsubscribedAt: new Date("2026-09-20") });
	await contact({ email: "bounced@example.com", status: "bounced", subscribedAt: new Date("2026-09-03"), createdAt: new Date("2026-09-03") });
	await Suppression.create({ email: "bounced@example.com", reason: "bounce", createdAt: new Date("2026-09-25") });
	const history = await getSubscriberHistory({ newsletterId, timeZone: "UTC", now });
	assert.equal(history.total, 3);
	const days = [...history.previous, ...history.current];
	assert.equal(days.find(({ key }) => key === "2026-09-20").left, 1);
	assert.equal(days.find(({ key }) => key === "2026-09-25").left, 1);
	assert.equal(days.find(({ key }) => key === "2026-10-01").joined, 1);
	assert.equal(days.find(({ key }) => key === "2026-10-05").joined, 0);
	await Campaign.create({ newsletterId, startedAt: new Date("2026-10-01"), stats: { sent: 10, delivered: 9, opened: 4 } });
	await Campaign.create({ newsletterId, startedAt: new Date("2026-09-01"), stats: { sent: 5 } });
	await Message.create({ newsletterId, kind: "welcome", email: "welcome@example.com", createdAt: new Date("2026-10-11T05:00:00Z"), sentAt: new Date("2026-10-11T05:00:00Z"), openedAt: new Date("2026-10-11T06:00:00Z") });
	const stats = await getEmailStats({ newsletterId, now });
	assert.equal(stats.current.sent, 11);
	assert.equal(stats.current.opened, 5);
	assert.equal(stats.previous.sent, 5);
	const hours = await getHourlySends({ newsletterId, timeZone: "UTC", now });
	assert.equal(hours.find(({ hour }) => hour === 5).today, 1);
	assert.equal(hours.find(({ hour }) => hour === 13).today, null);
});

test("real signup and newsletter summary queries keep confirmation and suppression rules", async () => {
	const newsletter = await Newsletter.create({ name: "Confirmed", slug: "confirmed", fromEmail: "hello@example.com", requireConfirmation: true });
	const first = await upsertContact({ newsletter, email: "reader@example.com", source: "form", resubscribe: true });
	assert.equal(first.created, true);
	assert.equal(first.contact.status, "pending");
	await Contact.updateOne({ _id: first.contact._id }, { $set: { status: "unsubscribed" } });
	const repeat = await upsertContact({ newsletter, email: "reader@example.com", source: "form", resubscribe: false });
	assert.equal(repeat.contact.status, "unsubscribed");
	await Suppression.create({ email: "reader@example.com", reason: "complaint" });
	const suppressed = await upsertContact({ newsletter, email: "reader@example.com", source: "form", resubscribe: true });
	assert.equal(suppressed.contact.status, "unsubscribed");
	const summary = await listNewslettersWithActiveCounts("name slug");
	assert.deepEqual(summary.map(({ name, activeCount }) => ({ name, activeCount })), [{ name: "Confirmed", activeCount: 0 }]);
});
