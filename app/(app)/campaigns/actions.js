"use server";

import { isValidObjectId } from "@/lib/d1-id";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { notifyActivity } from "@/lib/alerts";
import { PUBLISHED_STATUSES, revalidateArchive } from "@/lib/archive-data";
import { requireSession } from "@/lib/auth";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getScheduleProblem } from "@/lib/schedule";
import { publishScheduledSend } from "@/lib/scheduling";
import { getCleanupPreview, queueCampaign, sendTestEmail, sendToMoreContacts } from "@/lib/sending";
import { getSendProblem } from "@/lib/sending-rules";
import { ARCHIVE_SLUG_PATTERN } from "@/lib/slug";
import { firstImageUrl } from "@/lib/thumbnail";
import { MAX_BODY_BYTES } from "@/lib/validation";
import Campaign from "@/models/Campaign";
import Newsletter from "@/models/Newsletter";

const MAX_SUBJECT_LENGTH = 200;
const COPY_SUFFIX = " (copy)";
// A scheduled campaign stays editable until it goes out.
const EDITABLE_STATUSES = ["draft", "scheduled"];

function readAudienceLimit(value) {
	const limit = Number(value);
	return Number.isInteger(limit) && limit > 0 ? limit : undefined;
}

function notifySend(campaign, action) {
	return notifyActivity([`${action}: ${campaign.subject || "(no subject)"}`, `${getAppUrl()}/campaigns/${campaign._id}`]);
}

function formatCount(count) {
	return count.toLocaleString("en-US");
}

async function findCampaign(id) {
	await requireSession();
	if (!isValidObjectId(id)) return null;
	await connectDb();
	return Campaign.findById(id);
}

export async function createCampaign(newsletterId) {
	await requireSession();
	if (!isValidObjectId(newsletterId)) return { error: "Newsletter not found" };
	await connectDb();
	if (!(await Newsletter.exists({ _id: newsletterId }))) return { error: "Newsletter not found" };

	const campaign = await Campaign.create({ newsletterId });
	revalidatePath("/campaigns");
	redirect(`/campaigns/${campaign._id}`);
}

// The status check is part of the write, so a save can't land on a campaign that just started sending.
export async function saveCampaign(id, values) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Only drafts can be edited" };

	const body = String(values?.body ?? "");
	const bytes = Buffer.byteLength(body, "utf8");
	if (bytes > MAX_BODY_BYTES) {
		return { error: `The content is ${Math.ceil(bytes / 1000)} KB. The limit is ${MAX_BODY_BYTES / 1000} KB.` };
	}

	// The editor opens Markdown drafts as rich text, so their first save moves them to it.
	const format = campaign.format === "markdown" ? "rich" : campaign.format;
	const thumbnailUrl = firstImageUrl({ format, html: body });
	const { matchedCount } = await Campaign.updateOne(
		{ _id: campaign._id, status: { $in: EDITABLE_STATUSES } },
		{
			$set: {
				subject: String(values?.subject ?? "").slice(0, MAX_SUBJECT_LENGTH),
				previewText: String(values?.previewText ?? "").slice(0, 300),
				format,
				html: body,
				...(thumbnailUrl && { thumbnailUrl }),
			},
			...(!thumbnailUrl && { $unset: { thumbnailUrl: 1 } }),
		}
	);
	if (!matchedCount) return { error: "This campaign is already sending" };

	revalidatePath("/campaigns");
	return { ok: true };
}

// Sending errors become toasts; a thrown error would replace the page with the error boundary.
async function runSend(send) {
	try {
		await send();
		return { ok: true };
	} catch (error) {
		console.error("[campaigns] Send failed:", error);
		return { error: error.message || "Sending failed" };
	}
}

export async function sendTestCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const result = await runSend(() =>
		sendTestEmail({ campaignId: campaign._id.toString(), to: process.env.ADMIN_EMAIL })
	);
	revalidatePath(`/campaigns/${id}`);
	return result;
}

// Sending a scheduled campaign now replaces its schedule; the Cron Trigger ignores the old schedule.
export async function sendCampaign(id, { audienceLimit } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	campaign.audienceLimit = readAudienceLimit(audienceLimit);
	campaign.scheduledAt = undefined;
	await campaign.save();

	const result = await runSend(() => queueCampaign(campaign._id.toString()));
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) {
		revalidateArchive();
		const limit = campaign.audienceLimit;
		await notifySend(campaign, limit ? `Send started (first ${formatCount(limit)})` : "Send started");
	}
	return result;
}

// Checked now and again when it goes out: content edited in between could still block the send.
export async function scheduleCampaign(id, { scheduledAt, audienceLimit } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Already sent" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const at = new Date(scheduledAt ?? NaN);
	const problem = getScheduleProblem(at);
	if (problem) return { error: problem };
	const newsletter = await Newsletter.findById(campaign.newsletterId).lean();
	const sendProblem = getSendProblem({ campaign, newsletter });
	if (sendProblem) return { error: sendProblem };

	const limit = readAudienceLimit(audienceLimit);
	const { matchedCount } = await Campaign.updateOne(
		{ _id: campaign._id, status: { $in: EDITABLE_STATUSES } },
		{
			$set: { status: "scheduled", scheduledAt: at, ...(limit && { audienceLimit: limit }) },
			...(!limit && { $unset: { audienceLimit: 1 } }),
		}
	);
	if (!matchedCount) return { error: "The campaign changed, refresh and try again" };

	try {
		await publishScheduledSend({ campaignId: campaign._id, scheduledAt: at });
	} catch (error) {
		console.error("[campaigns] Scheduling failed:", error);
		const previous =
			campaign.status === "scheduled"
				? { $set: { status: "scheduled", scheduledAt: campaign.scheduledAt } }
				: { $set: { status: "draft" }, $unset: { scheduledAt: 1 } };
		await Campaign.updateOne({ _id: campaign._id, status: "scheduled", scheduledAt: at }, previous);
		return { error: `Couldn't schedule it: ${error.message}` };
	}

	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	const when = `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
	await notifySend(campaign, `Send scheduled for ${when}${limit ? ` (first ${formatCount(limit)})` : ""}`);
	return { ok: true };
}

export async function unscheduleCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };

	const { matchedCount } = await Campaign.updateOne(
		{ _id: campaign._id, status: "scheduled" },
		{ $set: { status: "draft" }, $unset: { scheduledAt: 1 } }
	);
	if (!matchedCount) return { error: "It isn't scheduled anymore" };

	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

// The send dialogs ask when they open: it walks the whole list.
export async function previewCleanup(id) {
	await requireSession();
	if (!isValidObjectId(id)) return { error: "Campaign not found" };
	try {
		return await getCleanupPreview(id);
	} catch (error) {
		console.error("[campaigns] Cleanup preview failed:", error);
		return { error: error.message || "Couldn't count the list cleanup" };
	}
}

// Without a number, the campaign goes to everyone who hasn't received it yet.
export async function sendCampaignToMore(id, { additional } = {}) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const more = readAudienceLimit(additional);
	const result = await runSend(() => sendToMoreContacts(campaign._id.toString(), more));
	revalidatePath("/campaigns");
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, `Send to more started (${more ? `next ${formatCount(more)}` : "everyone left"})`);
	return result;
}

export async function resumeCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (campaign.status !== "paused") return { error: "Only paused campaigns can resume" };
	if (!isSendingEnabled()) return { error: "Sending is off" };

	const result = await runSend(() => queueCampaign(campaign._id.toString()));
	revalidatePath(`/campaigns/${id}`);
	if (result.ok) await notifySend(campaign, "Send resumed");
	return result;
}

export async function pauseCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	await Campaign.updateOne({ _id: campaign._id, status: "sending" }, { $set: { status: "paused" } });
	revalidatePath(`/campaigns/${id}`);
	return { ok: true };
}

export async function toggleArchivePin(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!campaign.archiveSlug || campaign.archiveListed === false) return { error: "Not listed on the archive" };

	campaign.archivePinned = !campaign.archivePinned;
	await campaign.save();
	revalidatePath(`/campaigns/${id}`);
	revalidateArchive();
	return { ok: true };
}

export async function duplicateCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };

	const copy = await Campaign.create({
		newsletterId: campaign.newsletterId,
		subject: campaign.subject ? `${campaign.subject.slice(0, MAX_SUBJECT_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}` : "",
		previewText: campaign.previewText,
		format: campaign.format,
		markdown: campaign.markdown,
		html: campaign.html,
		thumbnailUrl: campaign.thumbnailUrl,
		// A copy of an API draft is still content from the API key's holder, not from the dashboard.
		...(campaign.source === "api" && { source: "api" }),
	});
	revalidatePath("/campaigns");
	redirect(`/campaigns/${copy._id}`);
}

// Discarded campaigns keep everything: canceled hides them from the lists and stops a scheduled send.
export async function discardCampaign(id) {
	const campaign = await findCampaign(id);
	if (!campaign) return { error: "Campaign not found" };
	if (!EDITABLE_STATUSES.includes(campaign.status)) return { error: "Only drafts can be discarded" };

	const { matchedCount } = await Campaign.updateOne(
		{ _id: campaign._id, status: { $in: EDITABLE_STATUSES } },
		{ $set: { status: "canceled" }, $unset: { scheduledAt: 1 } }
	);
	if (!matchedCount) return { error: "This campaign is already sending" };

	revalidatePath("/");
	revalidatePath("/campaigns");
	return { ok: true };
}

// The page lives at /p/<slug> once the issue goes out. A draft without one gets the subject's slug then.
// Slugs are unique across newsletters: /p/<slug> on the app's own domain finds an issue by slug alone.
export async function updateArchiveSlug(id, value) {
	const campaign = await findCampaign(id);
	if (!campaign || campaign.status === "canceled") return { error: "Campaign not found" };

	const slug = String(value ?? "").trim().toLowerCase().replace(/-+$/, "");
	const isPublished = PUBLISHED_STATUSES.includes(campaign.status);
	if (!slug && isPublished) return { error: "A sent issue needs a URL" };
	if (slug && !ARCHIVE_SLUG_PATTERN.test(slug)) return { error: "Use lowercase letters, digits and hyphens" };
	if (slug === (campaign.archiveSlug ?? "")) return { ok: true, archiveSlug: slug };
	if (slug && (await Campaign.exists({ _id: { $ne: campaign._id }, archiveSlug: slug }))) {
		return { error: "Another issue uses this URL" };
	}

	try {
		await Campaign.updateOne(
			{ _id: campaign._id },
			slug ? { $set: { archiveSlug: slug } } : { $unset: { archiveSlug: 1 } }
		);
	} catch (error) {
		if (error?.code === 11000) return { error: "Another issue uses this URL" };
		throw error;
	}

	revalidatePath(`/campaigns/${id}`);
	if (isPublished) {
		revalidatePath("/campaigns");
		revalidateArchive();
	}
	return { ok: true, archiveSlug: slug };
}
