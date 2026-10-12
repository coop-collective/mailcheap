import assert from "node:assert/strict";
import { test } from "node:test";
import { readBoundedBody, BodyTooLargeError } from "../lib/request-body.js";

test("uploads enforce the size limit without trusting Content-Length", async () => {
	let cancelled = false;
	const request = new Request("https://example.com", {
		method: "POST", duplex: "half",
		body: new ReadableStream({
			pull(controller) { controller.enqueue(new Uint8Array(3)); },
			cancel() { cancelled = true; },
		}),
	});
	await assert.rejects(readBoundedBody(request, 4), BodyTooLargeError);
	assert.equal(cancelled, true);
});

test("upload bytes are preserved at the exact size limit", async () => {
	const request = new Request("https://example.com", { method: "POST", body: new Uint8Array([1, 2, 3]) });
	assert.deepEqual(await readBoundedBody(request, 3), new Uint8Array([1, 2, 3]));
});
