import { defineModel } from "../lib/d1-model.js";

export const MESSAGE_STATUSES = ["queued", "processing", "uncertain", "sent", "delivered", "bounced", "complained", "failed", "suppressed"];

export default defineModel("messages", {
	defaults: { status: "queued" },
	required: ["kind", "newsletterId", "email"],
	trim: ["email"],
	lowercase: ["email"],
	enums: { status: MESSAGE_STATUSES, kind: ["campaign", "last-chance", "welcome", "confirmation", "test"] },
});
