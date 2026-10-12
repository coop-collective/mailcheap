import app from "vinext/server/app-router-entry";
import { handleQueue, handleScheduled } from "../lib/jobs.js";

// HTTP uses vinext's request context; background handlers are native Worker
// events, never public HTTP endpoints.
const worker = {
	fetch: app.fetch,
	queue: handleQueue,
	async scheduled(event, env, ctx) {
		await handleScheduled(event, env, ctx);
		await env.DB.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(Date.now()).run();
		await env.DB.prepare("DELETE FROM transactional_email_requests WHERE expires_at < ?").bind(Date.now()).run();
	},
};

export default worker;
