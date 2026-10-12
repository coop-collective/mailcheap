import assert from "node:assert/strict";
import test from "node:test";
import { createSesClient, getSesConfiguration, sendEmailWithSes } from "../lib/email-transport.js";
import { getEmailErrorAction } from "../lib/email-policy.js";
import { getEmailEventPlan, matchesEmailEvent } from "../lib/email-event-mapping.js";
import { consumeEmailQueue } from "../lib/queue-consumer.js";

const config = { region: "us-east-1", accessKeyId: "FAKE_TEST_ACCESS_KEY", secretAccessKey: "fake-test-secret-not-real", sessionToken: "fake-session-token" };
const message = { kind: "campaign", from: { email: "sender@example.com", name: "Jane, Example" }, to: "reader@example.com", replyTo: "reply@example.com", subject: "Hello", html: "<p>Hello</p>", text: "Hello", headers: { "List-Unsubscribe": "<https://example.com/unsubscribe>", "Feedback-ID": "campaign:weekly:campaign:mailcheap" }, tags: [{ name: "message_id", value: "a".repeat(24) }] };

test("SES request is SigV4 signed and sends configuration, headers, tags and both bodies", async () => {
	let wire;
	const request = createSesClient(config, { fetcher: async (req) => { wire = req; return Response.json({ MessageId: "ses-id" }); } });
	assert.deepEqual(await sendEmailWithSes(request, message, { configurationSet: "mailcheap" }), { providerMessageId: "ses-id" });
	assert.equal(wire.url, "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
	assert.match(wire.headers.get("authorization"), /^AWS4-HMAC-SHA256 Credential=FAKE_TEST_ACCESS_KEY\//);
	assert.equal(wire.headers.get("x-amz-security-token"), "fake-session-token");
	const body = await wire.json();
	assert.equal(body.FromEmailAddress, '"Jane, Example" <sender@example.com>');
	assert.deepEqual(body.Destination.ToAddresses, ["reader@example.com"]);
	assert.deepEqual(body.ReplyToAddresses, ["reply@example.com"]);
	assert.equal(body.ConfigurationSetName, "mailcheap");
	assert.equal(body.Content.Simple.Body.Text.Data, "Hello");
	assert.equal(body.Content.Simple.Body.Html.Data, "<p>Hello</p>");
	assert.deepEqual(body.EmailTags, [{ Name: "message_id", Value: "a".repeat(24) }]);
	assert.equal(body.Content.Simple.Headers.find(({ Name }) => Name === "Feedback-ID").Value, message.headers["Feedback-ID"]);
});

test("all app email kinds send through SES; unknown kinds fail before network access", async () => {
	let calls = 0;
	const request = async () => { calls++; return { MessageId: "ses-id" }; };
	for (const kind of ["campaign", "last-chance", "welcome", "confirmation", "test", "alert"]) await sendEmailWithSes(request, { ...message, kind });
	assert.equal(calls, 6);
	for (const kind of [undefined, null, "__proto__", "unexpected"]) await assert.rejects(sendEmailWithSes(request, { ...message, kind }), { code: "E_UNSUPPORTED_EMAIL_KIND" });
	assert.equal(calls, 6);
});

test("SES transport never retries throttling, server errors or transport failures itself", async () => {
	for (const status of [429, 500]) {
		let calls = 0;
		const request = createSesClient(config, { fetcher: async () => { calls++; return Response.json({ message: "Failure", __type: status === 429 ? "TooManyRequestsException" : "InternalFailure" }, { status }); } });
		await assert.rejects(sendEmailWithSes(request, message), (error) => getEmailErrorAction(error) === (status === 429 ? "retry" : "uncertain"));
		assert.equal(calls, 1);
	}
	let calls = 0;
	const request = createSesClient(config, { fetcher: async () => { calls++; throw new Error("connection lost"); } });
	await assert.rejects(sendEmailWithSes(request, message), /connection lost/);
	assert.equal(calls, 1);
	await assert.rejects(sendEmailWithSes(async () => ({}), message), /without a message ID/);
	assert.equal(getEmailErrorAction({ code: "ThrottlingException", message: "Daily message quota exceeded" }), "pause");
	assert.equal(getEmailErrorAction({ code: "TooManyRequestsException", message: "Maximum sending rate exceeded" }), "retry");
});

test("explicit Worker credentials are required and invalid endpoint regions fail closed", () => {
	assert.throws(() => createSesClient({ region: "us-east-1" }), { code: "E_EMAIL_NOT_CONFIGURED" });
	assert.throws(() => getSesConfiguration({ SES_REGION: "us-east-1.evil.com/" }), /standard AWS partition/);
	assert.throws(() => getSesConfiguration({ SES_REGION: "cn-north-1" }), /standard AWS partition/);
	assert.equal(getSesConfiguration({ AWS_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "key" }).region, "eu-west-1");
});

test("verified SNS envelopes map ids and reject malformed SES events or conflicting correlations", () => {
	const input = { provider: "ses", snsMessageId: "sns-id", event: { eventType: "Delivery", mail: { messageId: "ses-id", timestamp: "2026-10-11T01:00:00Z", destination: ["reader@example.com"], tags: { message_id: ["a".repeat(24)] } }, delivery: {} } };
	const plan = getEmailEventPlan(input);
	assert.equal(plan.providerEventId, "sns-id");
	assert.equal(plan.providerMessageId, "ses-id");
	assert.equal(plan.messageId, "a".repeat(24));
	assert.equal(getEmailEventPlan({ ...input, snsMessageId: "" }), null);
	assert.equal(getEmailEventPlan({ ...input, event: { eventType: "Delivery" } }), null);
	assert.equal(matchesEmailEvent({ email: "reader@example.com" }, plan), true);
	assert.equal(matchesEmailEvent({ email: "other@example.com" }, plan), false);
	assert.equal(matchesEmailEvent({ email: "reader@example.com", providerMessageId: "other-id" }, plan), false);
});

function job(body) { const calls = []; return { id: "job", body, attempts: 1, calls, ack: () => calls.push("ack"), retry: (options) => calls.push(options) }; }
test("queue acknowledges successes independently and invalid payloads cannot invoke sends", async () => {
	const first = job({ type: "send-batch", messageIds: ["a".repeat(24)] });
	const throttled = job({ type: "send-batch", messageIds: ["b".repeat(24)] });
	const invalid = job({ type: "send-batch", messageIds: ["invalid"] });
	const forgedEvent = job({ provider: "ses", event: {} });
	let calls = 0;
	await consumeEmailQueue({ messages: [first, throttled, invalid, forgedEvent] }, { sendBatch: async ([id]) => { calls++; return { retry: id.startsWith("b") }; } });
	assert.equal(calls, 2);
	assert.deepEqual(first.calls, ["ack"]);
	assert.deepEqual(throttled.calls, [{ delaySeconds: 60 }]);
	assert.deepEqual(invalid.calls, ["ack"]);
	assert.deepEqual(forgedEvent.calls, ["ack"]);
});
