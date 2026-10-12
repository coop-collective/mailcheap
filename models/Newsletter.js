import { defineModel } from "../lib/d1-model.js";

export default defineModel("newsletters", {
	defaults: { archiveEnabled: false, socialLinks: [], requireConfirmation: false, cleanup: { enabled: false }, welcome: { enabled: false } },
	required: ["name", "slug", "fromEmail"],
	trim: ["name", "slug", "fromEmail", "replyTo", "imageUrl", "fromName", "postalAddress", "description", "author.bio", "author.imageUrl", "welcome.subject", "welcome.previewText", "confirmation.subject", "confirmation.previewText"],
	lowercase: ["slug", "fromEmail", "replyTo"],
	min: { "cleanup.issues": 1, "cleanup.days": 1 },
});
