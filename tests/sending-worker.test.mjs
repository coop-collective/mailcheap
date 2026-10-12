import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const root = fileURLToPath(new URL("..", import.meta.url));
let mf;
before(async () => {
	const bundle = await build({
		stdin: { contents: `
import { sendMessageBatch } from '@/lib/sending';
import { handleEmailEvent } from '@/lib/email-events';
import Campaign from '@/models/Campaign';
import Contact from '@/models/Contact';
import Newsletter from '@/models/Newsletter';
import Message from '@/models/Message';
import Suppression from '@/models/Suppression';
export default { async fetch(request) {
  const mode = new URL(request.url).pathname.slice(1);
  const newsletter = await Newsletter.create({ name: 'Test', slug: mode, fromEmail: 'sender@example.com', postalAddress: '123 Test Road' });
  const contact = await Contact.create({ newsletterId: newsletter._id, email: mode + '@example.net', status: 'active' });
  const campaign = await Campaign.create({ newsletterId: newsletter._id, status: 'sending', subject: 'News', format: 'markdown', markdown: 'Hello reader' });
  const message = await Message.create({ newsletterId: newsletter._id, campaignId: campaign._id, contactId: contact._id, email: contact.email, kind: 'campaign' });
  const providerMessageId = 'ses-' + mode;
  let attempts = 0;
  function event(type) {
    const timestamp = new Date().toISOString();
    return { provider: 'ses', snsMessageId: mode + '-' + type, event: {
      eventType: type,
      mail: { timestamp, messageId: providerMessageId, destination: [contact.email], tags: { message_id: [message._id] } },
      ...(type === 'Bounce' ? { bounce: { timestamp, bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: contact.email }] } } : { delivery: { timestamp } })
    } };
  }
  globalThis.testSend = async (email) => {
    attempts++;
    if (email.kind !== 'campaign' || !email.headers['List-Unsubscribe'] || !email.headers['Feedback-ID']) throw new Error('Missing campaign headers');
    if (mode === 'early-bounce') await handleEmailEvent(event('Bounce'));
    if (mode === 'timeout') throw new Error('Connection lost after acceptance');
    return { providerMessageId };
  };
  const first = await sendMessageBatch([message._id]);
  const afterFirst = await Message.findById(message._id).lean();
  const second = await sendMessageBatch([message._id]);
  if (mode === 'timeout') {
    await handleEmailEvent(event('Delivery'));
    await handleEmailEvent(event('Delivery'));
  }
  return Response.json({ first, second, attempts, afterFirst: afterFirst.status,
    message: await Message.findById(message._id).lean(),
    campaign: await Campaign.findById(campaign._id).lean(),
    contact: await Contact.findById(contact._id).lean(),
    suppressed: Boolean(await Suppression.exists({ email: contact.email }))
  });
} }`, resolveDir: root, sourcefile: "sending-worker-fixture.js" },
		bundle: true, write: false, format: "esm", platform: "neutral", mainFields: ["module", "main"],
		external: ["node:*", "cloudflare:*"],
		plugins: [{ name: "worker-fixtures", setup(b) {
			b.onResolve({ filter: /^(server-only|next\/headers|next\/server|@\/lib\/email)$/ }, ({ path: name }) => ({ path: name, namespace: "fixture" }));
			b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: name }) => ({ contents: name === "@/lib/email"
				? "export async function sendEmail(message) { return globalThis.testSend(message); }"
				: name === "next/headers" ? "export async function headers() { return new Headers(); }"
				: name === "next/server" ? "export function after(fn) { return fn(); }" : "" }));
			b.onResolve({ filter: /^@\// }, ({ path: name }) => ({ path: path.join(root, `${name.slice(2)}.js`) }));
		} }],
	});
	mf = new Miniflare(convertV4MiniflareOptions({
		compatibilityDate: "2026-10-11", compatibilityFlags: ["nodejs_compat"], modules: true, script: bundle.outputFiles[0].text,
		d1Databases: { DB: "sending-worker" }, bindings: { SENDING_ENABLED: "true", SEND_RATE_PER_SECOND: "14", SESSION_SECRET: "local-fixture-only-secret-with-at-least-32-characters", APP_URL: "https://mail.example.test" },
	}));
	const db = await mf.getD1Database("DB");
	const migration = await readFile(new URL("../migrations/0001_d1_documents.sql", import.meta.url), "utf8");
	await db.exec(migration.replace(/^--.*$/gm, "").split("\n").filter(Boolean).join(" "));
});
after(async () => { await mf?.dispose(); });

test("Worker campaign delivery preserves an early SES bounce and duplicate jobs never send again", async () => {
	const response = await mf.dispatchFetch("https://test/early-bounce");
	assert.equal(response.status, 200, await response.clone().text());
	const result = await response.json();
	assert.equal(result.attempts, 1);
	assert.equal(result.message.status, "bounced");
	assert.equal(result.campaign.stats.sent, 1);
	assert.equal(result.campaign.stats.bounced, 1);
	assert.equal(result.campaign.status, "sent");
	assert.equal(result.contact.status, "bounced");
	assert.equal(result.suppressed, true);
	assert.equal(result.second.sent, 0);
});

test("Worker marks ambiguous sends uncertain; signed SES feedback recovers acceptance without another send", async () => {
	const response = await mf.dispatchFetch("https://test/timeout");
	assert.equal(response.status, 200, await response.clone().text());
	const result = await response.json();
	assert.equal(result.first.uncertain, 1);
	assert.equal(result.afterFirst, "uncertain");
	assert.equal(result.attempts, 1);
	assert.equal(result.second.sent, 0);
	assert.equal(result.message.status, "delivered");
	assert.equal(result.campaign.stats.sent, 1);
	assert.equal(result.campaign.stats.delivered, 1);
	assert.equal(result.contact.stats.sent, 1);
});
