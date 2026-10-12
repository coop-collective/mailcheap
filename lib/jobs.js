import "server-only";
import { sendAlert } from "@/lib/alerts";
import { isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { recoverQueuedEmails, findCompletedCampaigns } from "@/lib/job-recovery";
import { consumeEmailQueue } from "@/lib/queue-consumer";
import { runScheduledSend } from "@/lib/scheduling";
import { sendMessageBatch, settleCampaign } from "@/lib/sending";
import Campaign from "@/models/Campaign";
import Message from "@/models/Message";

export async function handleQueue(batch) {
	return consumeEmailQueue(batch, {
		sendBatch: sendMessageBatch,
	});
}

export async function handleScheduled(_event, env) {
	const db = await connectDb();
	const stale = new Date(Date.now() - 15 * 60_000);
	const { modifiedCount } = await Message.updateMany(
		{ status: "processing", processingAt: { $lt: stale } },
		{ $set: { status: "uncertain", error: "Worker stopped during delivery. Check SES delivery events before resending." } }
	);
	if (modifiedCount) await sendAlert({ key: "delivery-interrupted", title: "Email delivery needs review", detail: `${modifiedCount} interrupted sends require review in SES delivery events.` });
	if (!isSendingEnabled()) return;

	await recoverQueuedEmails(db, env.EMAIL_QUEUE);
	for (const campaignId of await findCompletedCampaigns(db)) await settleCampaign(campaignId);
	const due = await Campaign.find({ status: "scheduled", scheduledAt: { $lte: new Date() } }).sort({ scheduledAt: 1 }).limit(20).lean();
	for (const campaign of due) {
		try {
			await runScheduledSend({ campaignId: String(campaign._id), scheduledAt: campaign.scheduledAt.toISOString() });
		} catch (error) {
			console.error("[cron] Scheduled send failed", String(campaign._id), error.message);
			await sendAlert({ key: `scheduled-send-${campaign._id}`, title: "Scheduled send needs attention", detail: error.message, path: `/campaigns/${campaign._id}` });
		}
	}
}
