import { defineModel } from "../lib/d1-model.js";

export default defineModel("suppressions", {
	required: ["email", "reason"],
	trim: ["email"],
	lowercase: ["email"],
	enums: { reason: ["bounce", "complaint", "manual"] },
});
