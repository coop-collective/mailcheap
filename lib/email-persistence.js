import { LAST_SIGN_OF_LIFE_EXPRESSION, withEngagement } from "./cleanup.js";
import { Sql, tableName } from "./d1-sql.js";
import { CAMPAIGN_MESSAGE_KINDS, getCampaignStatsPath } from "./sending-rules.js";

function update(db, table, filter, changes, messageGuard) {
	const sql = new Sql();
	const expression = sql.update({ ...changes, $set: { ...changes.$set, updatedAt: new Date() } });
	const where = sql.where(filter);
	const guard = messageGuard
		? ` AND EXISTS (SELECT 1 FROM messages AS m WHERE ${sql.where(messageGuard, "m.document")})`
		: "";
	return db.prepare(`UPDATE ${tableName(table)} SET document = ${expression} WHERE ${where}${guard}`).bind(...sql.values);
}

function addCampaignCount(statements, db, message, counter, guard) {
	if (!CAMPAIGN_MESSAGE_KINDS.includes(message.kind) || !message.campaignId) return;
	statements.push(update(db, "campaigns", { _id: message.campaignId }, { $inc: counter }, guard));
}

// D1 batches are transactions. Read the first-transition condition for each
// dependent counter before changing the marker; either all writes commit or none.
export async function applyEmailEventUpdates(db, message, plan) {
	const statements = [];
	const statsPath = getCampaignStatsPath(message.kind);
	for (const { field, stat, contactStat } of plan.firsts) {
		const guard = { _id: message._id, [field]: null };
		if (stat) addCampaignCount(statements, db, message, { [`${statsPath}.${stat}`]: 1 }, guard);
		if (contactStat && message.contactId) {
			statements.push(update(db, "contacts", { _id: message.contactId }, { $inc: { [`stats.${contactStat}`]: 1 } }, guard));
		}
		statements.push(update(db, "messages", guard, { $set: { [field]: plan.occurredAt } }));
	}
	if (plan.status) {
		const guard = { _id: message._id, status: { $in: plan.status.from } };
		if (plan.status.stat) addCampaignCount(statements, db, message, { [`${statsPath}.${plan.status.stat}`]: 1 }, guard);
		statements.push(update(db, "messages", guard, {
			$set: { status: plan.status.to, ...(plan.error && { error: String(plan.error).slice(0, 500) }) },
			$unset: { processingAt: 1, ...(plan.status.to === "delivered" && { error: 1 }) },
		}));
	}
	// A delayed notification can arrive after delivery or a permanent failure.
	// It must not replace that terminal outcome's diagnostic.
	if (plan.error && !plan.status) statements.push(update(db, "messages", { _id: message._id, status: { $in: ["queued", "processing", "uncertain", "sent"] } }, { $set: { error: String(plan.error).slice(0, 500) } }));
	if (plan.engagement && message.contactId) {
		statements.push(update(db, "contacts", { _id: message.contactId }, withEngagement({ $max: plan.engagement }, plan.occurredAt)));
	}
	if (statements.length) await db.batch(statements);
}

export async function recordEmailAccepted(db, { message, contact, providerMessageId, sentAt }) {
	if (typeof providerMessageId !== "string" || !providerMessageId || !(sentAt instanceof Date) || !Number.isFinite(sentAt.getTime())) {
		throw new Error("A provider message ID and valid acceptance time are required");
	}
	const statements = [];
	// The event handler can recover acceptance from authenticated provider tags.
	// Recheck correlation in the transaction: a stale caller must never overwrite
	// a different provider ID, move its counters, or apply that other email's event.
	const guard = {
		_id: message._id,
		sentAt: null,
		$or: [{ providerMessageId: null }, { providerMessageId }],
	};
	addCampaignCount(statements, db, message, { [`${getCampaignStatsPath(message.kind)}.sent`]: 1 }, guard);
	const contactId = message.contactId ?? contact?._id;
	if (contactId) {
		statements.push(update(db, "contacts", { _id: contactId }, {
			$max: { lastSentAt: sentAt, ...(message.kind === "last-chance" && { lastChanceAt: sentAt }) },
			$inc: { "stats.sent": 1 },
		}, guard));
		if (message.kind === "campaign") {
			// An open/click may beat the transport response. That email is already
			// engaged with, so a late acceptance must not call it an ignored issue.
			statements.push(update(db, "contacts", { _id: contactId, $expr: { $lt: [LAST_SIGN_OF_LIFE_EXPRESSION, sentAt] } }, { $inc: { ignoredIssues: 1 } }, guard));
		}
	}
	// Preserve delivery/bounce/complaint/failure status and its diagnostic if an
	// event arrived first. Only a pre-delivery state advances on acceptance.
	statements.push(update(db, "messages", { ...guard, status: { $in: ["queued", "processing", "uncertain"] } }, {
		$set: { status: "sent" }, $unset: { error: 1 },
	}));
	const markerIndex = statements.length;
	statements.push(update(db, "messages", guard, {
		$set: { providerMessageId, sentAt }, $unset: { processingAt: 1 },
	}));
	const sql = new Sql();
	statements.push(db.prepare(`SELECT ${sql.field("providerMessageId")} AS providerMessageId FROM messages WHERE ${sql.where({ _id: message._id })} LIMIT 1`).bind(...sql.values));
	const results = await db.batch(statements);
	return {
		correlated: results.at(-1).results[0]?.providerMessageId === providerMessageId,
		recorded: results[markerIndex].meta.changes === 1,
	};
}

export async function recordEmailRejected(db, { message, error }) {
	const statements = [];
	const guard = { _id: message._id, status: { $in: ["queued", "processing"] } };
	addCampaignCount(statements, db, message, { [`${getCampaignStatsPath(message.kind)}.failed`]: 1 }, guard);
	statements.push(update(db, "messages", guard, { $set: { status: "failed", error: String(error?.message || error).slice(0, 500) }, $unset: { processingAt: 1 } }));
	await db.batch(statements);
}
