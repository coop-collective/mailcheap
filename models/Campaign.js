import { defineModel } from "../lib/d1-model.js";

export const CAMPAIGN_STATUSES = ["draft", "scheduled", "sending", "paused", "sent", "canceled"];

export default defineModel("campaigns", {
	defaults: {
		subject: "", previewText: "", format: "rich", markdown: "", html: "", status: "draft", source: "dashboard",
		archiveListed: true, archivePinned: false, webViews: 0,
		stats: { recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, opened: 0, clicked: 0, unsubscribed: 0, failed: 0 },
		lastChance: { recipients: 0, sent: 0, delivered: 0, bounced: 0, complained: 0, failed: 0, dormant: 0 },
	},
	required: ["newsletterId"],
	trim: ["subject", "previewText", "archiveSlug", "thumbnailUrl"],
	lowercase: ["archiveSlug"],
	enums: { status: CAMPAIGN_STATUSES, format: ["markdown", "html", "rich"] },
	min: { audienceLimit: 1 },
});
