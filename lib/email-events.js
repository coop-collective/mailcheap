import "server-only";
import { sendAlert } from "@/lib/alerts";
import { connectDb } from "@/lib/db";
import { applyEmailEventUpdates, recordEmailAccepted } from "@/lib/email-persistence";
import { getEmailEventPlan, getTrackingPlan, matchesEmailEvent } from "@/lib/email-event-mapping";
import { isLikelyScanner } from "@/lib/tracking";
import Contact from "@/models/Contact";
import Event from "@/models/Event";
import Message from "@/models/Message";
import Suppression from "@/models/Suppression";

export { getEmailEventPlan } from "@/lib/email-event-mapping";

// Every send produces a delivery event; storing those raw would fill a small cluster within months.
const RECORDED_EVENT_TYPES = new Set(["Bounce", "Complaint", "Reject", "DeliveryDelay", "RenderingFailure"]);

// Signed SES tags cover notifications that arrive before the send response.
// Require the stored recipient and provider ID to agree before trusting a tag.
async function findMessage(plan) {
	const byProvider = await Message.findOne({ providerMessageId: plan.providerMessageId }).lean();
	if (byProvider) return matchesEmailEvent(byProvider, plan) ? byProvider : null;
	if (!plan.messageId) return null;
	const byTag = await Message.findById(plan.messageId).lean();
	return matchesEmailEvent(byTag, plan) ? byTag : null;
}

async function applyMessageUpdates(message, plan) {
	await applyEmailEventUpdates(await connectDb(), message, plan);
}

// Global: the address is never emailed again, from any newsletter.
async function suppress({ emails, reason, detail, contactStatus, contactStatusFrom }) {
	if (emails.length === 0) return;
	await Promise.all(
		emails.map((email) =>
			Suppression.updateOne(
				{ email },
				// A complaint outranks an earlier bounce or manual suppression.
				reason === "complaint"
					? { $set: { reason, detail } }
					: { $setOnInsert: { reason, detail } },
				{ upsert: true }
			)
		)
	);
	await Contact.updateMany(
		{ email: { $in: emails }, status: { $in: contactStatusFrom } },
		{ $set: { status: contactStatus } }
	);
}

// Mailcheap's own open pixel and click links update messages the way provider events do.
export async function recordEngagement({ messageId, type, userAgent }) {
	await connectDb();
	const message = await Message.findById(messageId).select("kind campaignId contactId sentAt").lean();
	if (!message) return;
	if (type === "Click" && isLikelyScanner({ userAgent, sentAt: message.sentAt })) return;
	await applyMessageUpdates(message, getTrackingPlan(type));
}

export async function handleEmailEvent(event) {
	const plan = getEmailEventPlan(event);
	if (!plan) return { handled: false };

	await connectDb();
	const message = await findMessage(plan);
	// Alerts and other applications may share this SES sending domain. Apply global
	// suppression even when no Mailcheap message matches. A short correlation delay
	// covers an event racing the send response without dead-lettering unrelated mail.
	if (!message && plan.suppression) await suppress(plan.suppression);
	if (!message && Date.now() - plan.occurredAt.getTime() < 2 * 60_000) {
		throw new Error("Email event arrived before its send result; retrying correlation");
	}
	if (await Event.exists({ providerEventId: plan.providerEventId })) return { handled: true, duplicate: true };
	if (message) {
		// A signed lifecycle event is evidence of SES acceptance even when the send
		// request timed out. Persist acceptance/counters once, without resending.
		const accepted = await recordEmailAccepted(await connectDb(), {
			message, contact: message.contactId ? { _id: message.contactId } : null,
			providerMessageId: plan.providerMessageId, sentAt: plan.sentAt || plan.occurredAt,
		});
		if (!accepted.correlated) return { handled: false };
		await applyMessageUpdates(message, plan);
	}
	if (plan.suppression) await suppress(plan.suppression);
	if (plan.suppression?.reason === "complaint") {
		await sendAlert({
			key: "complaints",
			title: "Spam complaint",
			detail: `${plan.suppression.emails.join(", ")} marked an email as spam. Contacts are suppressed.`,
			path: message?.campaignId ? `/campaigns/${message.campaignId}` : "",
		});
	}

	if (RECORDED_EVENT_TYPES.has(plan.type)) {
		await Event.updateOne({ providerEventId: plan.providerEventId }, { $setOnInsert: {
			type: plan.type,
			providerMessageId: plan.providerMessageId,
			messageId: message?._id,
			campaignId: message?.campaignId,
			email: plan.email ?? message?.email,
			occurredAt: plan.occurredAt,
			data: plan.data,
		} }, { upsert: true });
	}
	return { handled: true, messageId: message ? String(message._id) : null };
}
