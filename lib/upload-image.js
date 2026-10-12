import { slugify } from "./slug.js";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
// Bound image memory and storage use; the server enforces this while reading.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
// Emails are 600px wide, so 1200px stays sharp on retina screens.
const MAX_WIDTH = 1200;
const EMAIL_WIDTH = 600;
const JPEG_QUALITY = 0.86;
// Readers download every picture on each open. Screenshots usually stay under this as PNG and keep
// their text sharp; photos and gradients saved as PNG don't, so they become JPEG unless transparent.
const MAX_PNG_BYTES = 1024 * 1024;

// Big pictures are scaled down before upload. GIFs keep their animation, and WebP becomes PNG or
// JPEG because Outlook can't show it.
export async function prepareImage(file) {
	const bitmap = await createImageBitmap(file).catch(() => {
		throw new Error(`Couldn't read ${file.name}`);
	});
	const scale = Math.min(1, MAX_WIDTH / bitmap.width);
	const isGif = file.type === "image/gif";
	if (isGif && file.size > MAX_UPLOAD_BYTES) {
		bitmap.close();
		throw new Error("GIFs must be under 4 MB");
	}
	const sizeLimit = file.type === "image/png" ? MAX_PNG_BYTES : MAX_UPLOAD_BYTES;
	if (isGif || (scale === 1 && file.type !== "image/webp" && file.size <= sizeLimit)) {
		const size = { width: bitmap.width, height: bitmap.height };
		bitmap.close();
		return { file, ...size };
	}

	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	const isOpaqueImage = file.type === "image/jpeg" || isOpaque(bitmap);
	const isPhoto = file.type === "image/jpeg" || (file.type === "image/webp" && isOpaqueImage);
	let blob = await drawImage(canvas, bitmap, isPhoto ? "image/jpeg" : "image/png");
	if (blob.type === "image/png" && blob.size > (isOpaqueImage ? MAX_PNG_BYTES : MAX_UPLOAD_BYTES)) {
		blob = await drawImage(canvas, bitmap, "image/jpeg");
	}
	bitmap.close();

	const extension = blob.type === "image/jpeg" ? "jpg" : "png";
	const name = `${file.name.replace(/\.[^.]+$/, "")}.${extension}`;
	return { file: new File([blob], name, { type: blob.type }), width: canvas.width, height: canvas.height };
}

// Width and height for the img tag: never wider than the email, so Outlook doesn't overflow.
export function getDisplaySize({ width, height }) {
	const displayWidth = Math.min(width, EMAIL_WIDTH);
	return { width: displayWidth, height: Math.round((height * displayWidth) / width) };
}

export async function uploadImage(file) {
	const response = await fetch("/api/uploads", {
		method: "POST",
		headers: { "content-type": file.type, "x-file-name": slugify(file.name.replace(/\.[^.]+$/, ""), 60) },
		body: file,
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok || !result.url) throw new Error(result.error || "Upload failed, try again");
	return result.url;
}

// JPEG has no transparency, so it's drawn on the white of the email.
function drawImage(canvas, bitmap, type) {
	const context = canvas.getContext("2d");
	context.clearRect(0, 0, canvas.width, canvas.height);
	if (type === "image/jpeg") {
		context.fillStyle = "#ffffff";
		context.fillRect(0, 0, canvas.width, canvas.height);
	}
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't read the image"))), type, JPEG_QUALITY);
	});
}

function isOpaque(bitmap) {
	const canvas = document.createElement("canvas");
	canvas.width = Math.min(bitmap.width, 200);
	canvas.height = Math.max(1, Math.round((bitmap.height * canvas.width) / bitmap.width));
	const context = canvas.getContext("2d", { willReadFrequently: true });
	context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
	for (let index = 3; index < data.length; index += 4) {
		if (data[index] < 255) return false;
	}
	return true;
}
