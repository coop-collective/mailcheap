import { defineModel } from "../lib/d1-model.js";

export const CONTACT_STATUSES = ["active", "pending", "unsubscribed", "bounced", "complained", "dormant"];

export default defineModel("contacts", {
	defaults: () => ({ status: "active", subscribedAt: Date.now(), stats: { sent: 0, opens: 0, clicks: 0 } }),
	required: ["newsletterId", "email"],
	trim: ["email", "source"],
	lowercase: ["email"],
	enums: { status: CONTACT_STATUSES },
});
