import { BodyTooLargeError, readBoundedBody } from "./request-body.js";
import { isValidSubscribeUrl, verifySnsMessage } from "./sns.js";
import { isPlainObject } from "./validation.js";

const MAX_BODY_BYTES = 512 * 1024;
const TOPIC_ARN = /^arn:(?:aws|aws-us-gov):sns:[a-z]{2}(?:-[a-z]+)+-\d+:\d{12}:[A-Za-z0-9_-]+$/;
const reply = (status, body) => Response.json(body, { status });

// The injected dependencies make the trust boundary testable without sending mail
// or confirming a real subscription. Production always uses the real verifier.
export function createSesWebhookHandler({ topicArn, handleEvent, verifyMessage = verifySnsMessage, fetcher = fetch }) {
	return async function handle(request) {
		const expectedTopic = typeof topicArn === "function" ? topicArn() : topicArn;
		if (!expectedTopic || !TOPIC_ARN.test(expectedTopic)) return reply(503, { error: "SES webhook is not configured" });
		let message;
		try { message = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, MAX_BODY_BYTES))); }
		catch (error) { return reply(error instanceof BodyTooLargeError ? 413 : 400, { error: error instanceof BodyTooLargeError ? "Body is too large" : "Invalid JSON" }); }
		if (!isPlainObject(message)) return reply(400, { error: "Invalid JSON" });
		if (message.TopicArn !== expectedTopic) return reply(403, { error: "Unknown topic" });
		try {
			if (!(await verifyMessage(message))) return reply(400, { error: "Invalid signature" });
		} catch (error) {
			if (error.code === "SNS_CERTIFICATE_UNAVAILABLE") return reply(503, { error: "Could not obtain signing certificate" });
			return reply(400, { error: "Invalid signature" });
		}
		if (message.Type === "SubscriptionConfirmation") {
			if (!isValidSubscribeUrl(message.SubscribeURL, expectedTopic, message.Token)) return reply(400, { error: "Invalid SubscribeURL" });
			const result = await fetcher(message.SubscribeURL, { redirect: "error", signal: AbortSignal.timeout(10_000) }).catch(() => null);
			return result?.ok ? reply(200, { ok: true }) : reply(502, { error: "Subscription confirmation failed" });
		}
		if (message.Type !== "Notification") return reply(200, { ok: true, ignored: true });
		let event;
		try { event = JSON.parse(message.Message); } catch { return reply(200, { ok: true, ignored: true }); }
		if (!isPlainObject(event)) return reply(200, { ok: true, ignored: true });
		try {
			const { handled } = await handleEvent({ provider: "ses", event, snsMessageId: message.MessageId });
			return reply(200, { ok: true, ...(!handled && { ignored: true }) });
		} catch (error) {
			console.error("[ses-webhook] Event processing failed", error?.message);
			// SNS retries 5xx. Message transitions/counters and suppression are replay-safe.
			return reply(500, { error: "Could not handle the event" });
		}
	};
}
