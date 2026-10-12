import { getCloudflareEnv } from "./cloudflare.js";

// D1 bindings are request scoped. Never cache a binding or a connection globally.
export async function connectDb() {
	const { DB } = await getCloudflareEnv();
	if (!DB) throw new Error("The Cloudflare D1 DB binding is not configured");
	return DB;
}
