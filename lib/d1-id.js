// Keep the existing 24-hex public IDs so signed links and imported data remain valid.
export function isValidObjectId(value) {
	return typeof value === "string" && /^[a-fA-F0-9]{24}$/.test(value);
}

export function createId() {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
