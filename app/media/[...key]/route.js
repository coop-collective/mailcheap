import { getCloudflareEnv } from "@/lib/cloudflare";

export async function GET(request, { params }) {
	const { key } = await params;
	const pathname = key.join("/");
	if (!/^images\/[a-z0-9-]+\.(png|jpg|gif|webp)$/.test(pathname)) return new Response("Not found", { status: 404 });
	const { IMAGES } = await getCloudflareEnv();
	if (!IMAGES) return new Response("Not found", { status: 404 });
	const object = await IMAGES.get(pathname, { onlyIf: request.headers });
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("etag", object.httpEtag);
	headers.set("x-content-type-options", "nosniff");
	if (!("body" in object)) {
		const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since");
		return new Response(null, { status: notModified ? 304 : 412, headers });
	}
	return new Response(object.body, { headers });
}
