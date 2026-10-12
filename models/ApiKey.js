import { defineModel } from "../lib/d1-model.js";

export default defineModel("apikeys", {
	required: ["name", "prefix", "hash"],
	trim: ["name"],
});
