import { chunk, SEND_BATCH_SIZE } from "./sending-rules.js";

// Recover interrupted publication without restarting paused campaigns or replaying
// ambiguous sends. D1's queued -> processing claim still controls actual delivery.
export async function recoverQueuedEmails(db, queue, now = Date.now()) {
	const { results } = await db.prepare(`
		SELECT json_extract(m.document, '$._id') AS id FROM messages AS m
		WHERE json_extract(m.document, '$.status') = 'queued'
		AND json_extract(m.document, '$.createdAt') < ?
		AND (
			json_extract(m.document, '$.kind') IN ('welcome', 'confirmation')
			OR (json_extract(m.document, '$.kind') IN ('campaign', 'last-chance') AND EXISTS (
				SELECT 1 FROM campaigns AS c
				WHERE json_extract(c.document, '$._id') = json_extract(m.document, '$.campaignId')
				AND json_extract(c.document, '$.status') = 'sending'
			))
		)
		ORDER BY json_extract(m.document, '$.createdAt'), json_extract(m.document, '$._id') LIMIT 100
	`).bind(now - 2 * 60_000).all();
	if (results.length) {
		await queue.sendBatch(chunk(results.map(({ id }) => id), SEND_BATCH_SIZE)
			.map((messageIds) => ({ body: { type: "send-batch", messageIds }, contentType: "json" })));
	}
	return results.length;
}

// A worker can stop after its final accepted-message write but before settlement.
export async function findCompletedCampaigns(db) {
	const { results } = await db.prepare(`
		SELECT json_extract(c.document, '$._id') AS id FROM campaigns AS c
		WHERE json_extract(c.document, '$.status') = 'sending' AND NOT EXISTS (
			SELECT 1 FROM messages AS m
			WHERE json_extract(m.document, '$.campaignId') = json_extract(c.document, '$._id')
			AND json_extract(m.document, '$.kind') IN ('campaign', 'last-chance')
			AND json_extract(m.document, '$.status') IN ('queued', 'processing', 'uncertain')
		) LIMIT 20
	`).all();
	return results.map(({ id }) => id);
}
