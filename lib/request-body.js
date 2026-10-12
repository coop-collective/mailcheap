export class BodyTooLargeError extends Error {}

// A Content-Length check alone misses chunked requests. Stop before retaining
// more than the limit, even when the caller does not declare a length.
export async function readBoundedBody(request, limit) {
	if (Number(request.headers.get("content-length")) > limit) throw new BodyTooLargeError();
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > limit) {
				await reader.cancel();
				throw new BodyTooLargeError();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}
