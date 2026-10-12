import { getSession } from "@/lib/auth";
import { putImage } from "@/lib/blob";
import { MAX_UPLOAD_BYTES } from "@/lib/upload-image";
import { slugify } from "@/lib/slug";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { BodyTooLargeError, readBoundedBody } from "@/lib/request-body";

// The declared type must match the file's first bytes, so nothing but pictures ends up on the CDN.
const IMAGE_TYPES = {
	"image/png": { extension: "png", signature: "\x89PNG" },
	"image/jpeg": { extension: "jpg", signature: "\xff\xd8\xff" },
	"image/gif": { extension: "gif", signature: "GIF8" },
	"image/webp": { extension: "webp", signature: "RIFF", marker: "WEBP" },
};

export async function GET() {
	const headers = { "Cache-Control": "no-store" };
	if (!(await getSession())) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
	return Response.json({ enabled: Boolean((await getCloudflareEnv()).IMAGES) }, { headers });
}

export async function POST(request) {
	if (!(await getSession())) return Response.json({ error: "Unauthorized" }, { status: 401 });
	if (!(await getCloudflareEnv()).IMAGES) {
		return Response.json({ error: "File uploads aren't enabled for this site. Use an image hosted elsewhere." }, { status: 503 });
	}

	const contentType = request.headers.get("content-type");
	const type = IMAGE_TYPES[contentType];
	if (!type) return Response.json({ error: "Use a PNG, JPEG, GIF or WebP image" }, { status: 415 });

	let bytes;
	try {
		bytes = await readBoundedBody(request, MAX_UPLOAD_BYTES);
	} catch (error) {
		if (error instanceof BodyTooLargeError) return Response.json({ error: "Images must be under 4 MB" }, { status: 413 });
		throw error;
	}
	if (!startsWith(bytes, type.signature) || (type.marker && !startsWith(bytes, type.marker, 8))) {
		return Response.json({ error: "This file isn't a valid image" }, { status: 415 });
	}

	const name = slugify(request.headers.get("x-file-name"), 60) || "image";
	try {
		const url = await putImage(`images/${name}.${type.extension}`, bytes, contentType);
		return Response.json({ url });
	} catch (error) {
		console.error("[uploads] Upload failed:", error);
		return Response.json({ error: "Upload failed, try again" }, { status: 502 });
	}
}

function startsWith(bytes, signature, offset = 0) {
	return [...signature].every((character, index) => bytes[offset + index] === character.charCodeAt(0));
}
