import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { registerHooks } from "node:module";

// Exercise the route boundaries with binding/auth stand-ins; no account or R2
// bucket is needed to verify an installation which deliberately omits uploads.
const modules = {
	"@/lib/auth": "export async function getSession() { return globalThis.__optionalUploadTest.session; }",
	"@/lib/cloudflare": "export async function getCloudflareEnv() { globalThis.__optionalUploadTest.bindingReads++; return globalThis.__optionalUploadTest.env; }",
	"@/lib/blob": "export async function putImage() { throw new Error('Unexpected upload'); }",
};
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (modules[specifier]) return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
		if (specifier.startsWith("@/")) return nextResolve(new URL(`../${specifier.slice(2)}.js`, import.meta.url).href, context);
		return nextResolve(specifier, context);
	},
});
const uploads = await import("../app/api/uploads/route.js");
const media = await import("../app/media/[...key]/route.js");

beforeEach(() => {
	globalThis.__optionalUploadTest = { session: null, env: {}, bindingReads: 0 };
});

test("upload capability requires authentication and cannot be cached", async () => {
	const response = await uploads.GET();
	assert.equal(response.status, 401);
	assert.equal(response.headers.get("cache-control"), "no-store");
	assert.equal(globalThis.__optionalUploadTest.bindingReads, 0);
	assert.equal((await uploads.POST({})).status, 401);
});

test("authenticated capability reflects an absent or present R2 binding", async () => {
	globalThis.__optionalUploadTest.session = { email: "admin@example.com" };
	let response = await uploads.GET();
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { enabled: false });
	assert.equal(response.headers.get("cache-control"), "no-store");
	globalThis.__optionalUploadTest.env.IMAGES = {};
	response = await uploads.GET();
	assert.deepEqual(await response.json(), { enabled: true });
});

test("omitting R2 returns a clear 503 before attempting to read uploaded bytes", async () => {
	globalThis.__optionalUploadTest.session = { email: "admin@example.com" };
	const response = await uploads.POST({
		get headers() { throw new Error("Must not inspect the file without storage"); },
		get body() { throw new Error("Must not buffer the file without storage"); },
	});
	assert.equal(response.status, 503);
	assert.match((await response.json()).error, /uploads aren't enabled/i);
});

test("media URLs return 404 without R2 rather than failing the Worker", async () => {
	const response = await media.GET(new Request("https://example.com/media/images/logo.png"), {
		params: Promise.resolve({ key: ["images", "logo.png"] }),
	});
	assert.equal(response.status, 404);
});
