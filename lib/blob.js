import "server-only";
import { getCloudflareEnv } from "./cloudflare.js";
import { getAppUrl } from "./config.js";

// Sent emails point at these files forever, so their URLs never change and browsers can cache them for a year.
const ONE_YEAR = 365 * 24 * 60 * 60;

export async function putImage(pathname, bytes, contentType) {
	const { IMAGES } = await getCloudflareEnv();
	if (!IMAGES) throw new Error("The IMAGES R2 bucket is not configured");
	const key = pathname.replace(/\.[^.]+$/, `-${crypto.randomUUID()}$&`);
	await IMAGES.put(key, bytes, {
		httpMetadata: { contentType, cacheControl: `public, max-age=${ONE_YEAR}, immutable` },
	});
	return `${getAppUrl()}/media/${key}`;
}
