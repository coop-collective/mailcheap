import assert from "node:assert/strict";
import test from "node:test";
import { createSesWebhookHandler } from "../lib/sns-webhook.js";

const topicArn = "arn:aws:sns:us-east-1:123456789012:mailcheap";
const notification = { Type: "Notification", TopicArn: topicArn, MessageId: "sns-id", Message: JSON.stringify({ eventType: "Delivery" }) };
const request = (message) => new Request("https://example.com/api/webhooks/ses", { method: "POST", body: JSON.stringify(message) });

test("SNS route checks configured topic and signature before any event handler", async () => {
	let calls = 0;
	const handleEvent = async () => { calls++; return { handled: true }; };
	assert.equal((await createSesWebhookHandler({ topicArn: "", handleEvent })(request(notification))).status, 503);
	const handler = createSesWebhookHandler({ topicArn, handleEvent, verifyMessage: async () => false });
	assert.equal((await handler(request({ ...notification, TopicArn: `${topicArn}-other` }))).status, 403);
	assert.equal((await handler(request(notification))).status, 400);
	assert.equal(calls, 0);
});

test("verified notifications carry the SNS id and processing errors return retryable 5xx", async () => {
	let input;
	const handler = createSesWebhookHandler({ topicArn, verifyMessage: async () => true, handleEvent: async (value) => { input = value; return { handled: true }; } });
	assert.equal((await handler(request(notification))).status, 200);
	assert.deepEqual(input, { provider: "ses", snsMessageId: "sns-id", event: { eventType: "Delivery" } });
	const failing = createSesWebhookHandler({ topicArn, verifyMessage: async () => true, handleEvent: async () => { throw new Error("D1 unavailable"); } });
	assert.equal((await failing(request(notification))).status, 500);
	const certificateFailure = createSesWebhookHandler({ topicArn, verifyMessage: async () => { throw Object.assign(new Error("offline"), { code: "SNS_CERTIFICATE_UNAVAILABLE" }); } });
	assert.equal((await certificateFailure(request(notification))).status, 503);
});

test("signed malformed SES payloads are acknowledged and unbounded request bodies are rejected", async () => {
	const handler = createSesWebhookHandler({ topicArn, verifyMessage: async () => true, handleEvent: async () => assert.fail("must not invoke") });
	assert.equal((await handler(request({ ...notification, Message: "not json" }))).status, 200);
	const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(300 * 1024)); controller.enqueue(new Uint8Array(300 * 1024)); controller.close(); } });
	assert.equal((await handler(new Request("https://example.com", { method: "POST", body: stream, duplex: "half" }))).status, 413);
});

test("subscription confirmation only fetches matching SNS action/topic/token after verification", async () => {
	const confirmation = { Type: "SubscriptionConfirmation", TopicArn: topicArn, Token: "token", SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(topicArn)}&Token=token` };
	let calls = 0;
	const handler = createSesWebhookHandler({ topicArn, verifyMessage: async () => true, fetcher: async (_url, options) => { calls++; assert.equal(options.redirect, "error"); return new Response("ok"); } });
	assert.equal((await handler(request(confirmation))).status, 200);
	for (const SubscribeURL of ["https://example.com/", confirmation.SubscribeURL.replace("Token=token", "Token=other"), confirmation.SubscribeURL.replace("Action=ConfirmSubscription", "Action=DeleteTopic")]) {
		assert.equal((await handler(request({ ...confirmation, SubscribeURL }))).status, 400);
	}
	assert.equal(calls, 1);
});
