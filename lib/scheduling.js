import "server-only";
import { connectDb } from "@/lib/db";
import { assertEmailKindSupported } from "@/lib/email-policy";
import { queueCampaign } from "@/lib/sending";
import { isObjectIdString } from "@/lib/validation";
import Campaign from "@/models/Campaign";

// D1 is the schedule of record. Cron finds due rows without a delayed HTTP callback
// or a queue retention limit.
export async function publishScheduledSend() {
	assertEmailKindSupported("campaign");
}

export async function runScheduledSend({ campaignId, scheduledAt }) {
	if (!isObjectIdString(String(campaignId)) || typeof scheduledAt !== "string") return { skipped: "invalid job" };
	await connectDb();
	const campaign = await Campaign.findById(campaignId).select("status scheduledAt subject").lean();
	if (campaign?.status !== "scheduled" || campaign.scheduledAt?.toISOString() !== scheduledAt) {
		return { skipped: "not scheduled for this time anymore" };
	}
	if (campaign.scheduledAt.getTime() > Date.now()) return { waiting: true };
	// A transient infrastructure failure leaves the schedule intact for the next cron.
	return { started: true, ...(await queueCampaign(String(campaignId))) };
}
