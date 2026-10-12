// Per-message acknowledgements keep one bad job from replaying successful jobs.
// Delivery idempotency lives in D1; Queues are at-least-once.
export async function consumeEmailQueue(batch, { sendBatch }) {
	for (const message of batch.messages) {
		try {
			const body = message.body;
			if (body?.type === "send-batch" && Array.isArray(body.messageIds) && body.messageIds.length > 0 && body.messageIds.length <= 100 && body.messageIds.every((id) => typeof id === "string" && /^[a-f0-9]{24}$/i.test(id))) {
				const result = await sendBatch(body.messageIds);
				if (result.retry) {
					message.retry({ delaySeconds: 60 });
					continue;
				}
			} else {
				// Reject poison messages; none can invoke sends without valid stored IDs.
				console.warn("[queue] Ignored invalid email job", message.id);
			}
			message.ack();
		} catch (error) {
			console.error("[queue] Email job failed", message.id, error?.message);
			message.retry({ delaySeconds: Math.min(300, 30 * 2 ** Math.min(message.attempts ?? 1, 4)) });
		}
	}
}
