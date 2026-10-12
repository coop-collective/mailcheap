import { defineModel } from "../lib/d1-model.js";

export default defineModel("events", {
	defaults: () => ({ occurredAt: Date.now() }),
	required: ["type"],
	trim: ["email"],
	lowercase: ["email"],
});
