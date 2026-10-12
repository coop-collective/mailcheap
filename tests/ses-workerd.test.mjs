import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { buildSigningString } from "../lib/sns.js";

// Workerd exercises its actual node:crypto X.509 handling and WebCrypto SigV4.
// The certificate is generated locally and every outbound fetch is mocked.
test("SES signing and SNS RSA/X509 verification run in Workers without outbound requests", async () => {
	const directory = await mkdtemp(join(tmpdir(), "mailcheap-sns-test-"));
	let mf;
	try {
		const keyPath = join(directory, "key.pem");
		const certPath = join(directory, "cert.pem");
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=mailcheap-test"], { stdio: "ignore" });
		const [privateKey, certificate] = await Promise.all([readFile(keyPath, "utf8"), readFile(certPath, "utf8")]);
		const message = { Type: "Notification", MessageId: "test-envelope-id", TopicArn: "arn:aws:sns:us-east-1:123456789012:mailcheap", Message: '{"eventType":"Delivery"}', Timestamp: "2026-10-11T01:00:00Z", SignatureVersion: "2", SigningCertURL: "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem" };
		message.Signature = crypto.createSign("RSA-SHA256").update(buildSigningString(message)).sign(privateKey, "base64");
		const source = `
			import { createSnsVerifier } from "./lib/sns.js";
			import { createSesClient, sendEmailWithSes } from "./lib/email-transport.js";
			export default { async fetch() {
				const verify = createSnsVerifier({ fetchCertificate: async () => ${JSON.stringify(certificate)} });
				const envelope = ${JSON.stringify(message)};
				const verified = await verify(envelope);
				const tampered = await verify({ ...envelope, Message: "tampered" });
				let calls = 0; let wire;
				const request = createSesClient({ region: "us-east-1", accessKeyId: "FAKE_KEY", secretAccessKey: "fake-test-secret" }, {
					fetcher: async (request) => { calls++; wire = { url: request.url, signed: request.headers.get("authorization").startsWith("AWS4-HMAC-SHA256 "), body: await request.json() }; return Response.json({ MessageId: "workerd-ses-id" }); }
				});
				const result = await sendEmailWithSes(request, { kind: "campaign", from: "sender@example.com", to: "reader@example.com", subject: "Test", html: "<p>Test</p>", text: "Test" });
				return Response.json({ verified, tampered, calls, wire, result });
			} };
		`;
		const bundled = await build({ stdin: { contents: source, resolveDir: process.cwd() }, bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"], conditions: ["workerd", "worker", "browser"], external: ["node:*", "cloudflare:*"], target: "es2022" });
		mf = new Miniflare(convertV4MiniflareOptions({ compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"], modules: true, script: bundled.outputFiles[0].text }));
		const result = await (await mf.dispatchFetch("http://localhost/test")).json();
		assert.equal(result.verified, true);
		assert.equal(result.tampered, false);
		assert.equal(result.calls, 1);
		assert.equal(result.wire.signed, true);
		assert.equal(result.wire.url, "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
		assert.equal(result.wire.body.Content.Simple.Subject.Data, "Test");
		assert.equal(result.result.providerMessageId, "workerd-ses-id");
	} finally {
		await mf?.dispose();
		await rm(directory, { recursive: true, force: true });
	}
});
