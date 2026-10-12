import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFIRM_URL_PLACEHOLDER, getConfirmationContent, getConfirmationProblem } from "../lib/confirmation-content.js";
import { createConfirmToken, verifyConfirmToken } from "../lib/confirmation.js";
import { getInbox } from "../lib/inbox-links.js";
import { renderEmail } from "../lib/render-email.js";
import { buildRecipientEmail, getWelcomeContent } from "../lib/sending-rules.js";
import { createUnsubscribeToken, verifyUnsubscribeToken } from "../lib/unsubscribe.js";

process.env.SESSION_SECRET ||= "test-secret-for-confirmation-links";
process.env.APP_URL ||= "https://mailcheap.test";

const REFERENCE = { contactId: "64f1a2b3c4d5e6f7a8b9c0a1", newsletterId: "64f1a2b3c4d5e6f7a8b9c0b1" };
const DAY_MS = 24 * 60 * 60 * 1000;

test("a confirmation link names one contact and stops working after 30 days", () => {
	const now = Date.now();
	const token = createConfirmToken(REFERENCE, now);
	assert.deepEqual(verifyConfirmToken(token, now + DAY_MS), REFERENCE);
	assert.equal(verifyConfirmToken(token, now + 31 * DAY_MS), null);

	const [payload, signature] = token.split(".");
	const forged = Buffer.from(JSON.stringify({ c: "64f1a2b3c4d5e6f7a8b9c0a2", n: REFERENCE.newsletterId, t: Math.floor(now / 1000) })).toString("base64url");
	assert.equal(verifyConfirmToken(`${forged}.${signature}`), null, "another contact can't reuse the signature");
	assert.equal(verifyConfirmToken(`${payload}.${signature.slice(1)}x`), null);
	assert.equal(verifyConfirmToken("not-a-token"), null);
});

test("unsubscribe and confirmation links can't stand in for each other", () => {
	assert.equal(verifyConfirmToken(createUnsubscribeToken(REFERENCE)), null);
	assert.equal(verifyUnsubscribeToken(createConfirmToken(REFERENCE)), null);
});

test("the confirmation email carries a clean link in both versions", () => {
	const content = getConfirmationContent({ name: "Field notes" });
	assert.equal(content.subject, "Confirm your subscription to Field notes");
	assert.ok(content.markdown.includes(CONFIRM_URL_PLACEHOLDER));

	const email = buildRecipientEmail({
		campaign: content,
		newsletter: { _id: REFERENCE.newsletterId, name: "Field notes", fromEmail: "hi@news.example.org" },
		contact: { _id: REFERENCE.contactId, email: "reader@example.com" },
		messageId: null,
		confirmUrl: "https://mailcheap.test/confirm?token=abc",
	});
	assert.ok(email.html.includes('href="https://mailcheap.test/confirm?token=abc"'));
	assert.ok(email.text.includes("Confirm my subscription (https://mailcheap.test/confirm?token=abc)"));
	assert.ok(!email.html.includes("/c/") && !email.html.includes("/o/"), "no tracking redirect or pixel");
	assert.ok(renderEmail(content).html.includes(CONFIRM_URL_PLACEHOLDER), "the link is filled per recipient");
});

test("saved custom confirmation content can still be previewed with each subscriber's link", () => {
	const confirmation = {
		subject: " [Action Required] Confirm your Field notes subscription ",
		previewText: "One click and you're in.",
		markdown: `<p style="text-align:center"><img src="https://mailcheap.test/email/banner.png" alt="Field notes" width="600" height="200"></p>

Confirm your email to get the next issue:

<a href="${CONFIRM_URL_PLACEHOLDER}" style="display:inline-block;">Confirm my subscription</a>

Every Sunday, you'll get:

- One idea about building things`,
	};
	const content = getConfirmationContent({ name: "Field notes", confirmation });
	assert.equal(content.subject, "[Action Required] Confirm your Field notes subscription");
	assert.equal(content.previewText, "One click and you're in.");

	const email = buildRecipientEmail({
		campaign: content,
		newsletter: { _id: REFERENCE.newsletterId, name: "Field notes", fromEmail: "hi@news.example.org" },
		contact: { _id: REFERENCE.contactId, email: "reader@example.com" },
		messageId: null,
		confirmUrl: "https://mailcheap.test/confirm?token=xyz",
	});
	assert.ok(email.html.includes('href="https://mailcheap.test/confirm?token=xyz"'));
	assert.ok(email.html.includes('src="https://mailcheap.test/email/banner.png"'));
	assert.ok(email.html.includes("<li>One idea about building things</li>"));
	assert.ok(email.text.includes("Confirm my subscription (https://mailcheap.test/confirm?token=xyz)"));
	assert.ok(!email.html.includes(CONFIRM_URL_PLACEHOLDER) && !email.text.includes(CONFIRM_URL_PLACEHOLDER));
	assert.ok(!email.html.includes("/c/") && !email.html.includes("/o/"), "no tracking redirect or pixel");
	assert.ok(email.headers["List-Unsubscribe"].includes("/api/unsubscribe?token="));
});

test("a confirmation email without its button can't be saved and never goes out", () => {
	const builtIn = getConfirmationContent({ name: "Field notes" });
	assert.equal(getConfirmationProblem(builtIn), null);
	assert.equal(getConfirmationProblem({ ...builtIn, subject: " " }), "Confirmation email needs a subject");

	const buttonProblem = /^Confirmation email needs its button: a link like <a href="\{\{confirm_url\}\}">/;
	assert.match(getConfirmationProblem({ ...builtIn, markdown: "Welcome to Field notes" }), buttonProblem);
	assert.match(
		getConfirmationProblem({ ...builtIn, markdown: `[Confirm](${CONFIRM_URL_PLACEHOLDER})` }),
		buttonProblem,
		"a Markdown link encodes the braces, so the link would be dead"
	);
	assert.match(
		getConfirmationProblem({ ...builtIn, markdown: `    <a href="${CONFIRM_URL_PLACEHOLDER}">Confirm</a>` }),
		buttonProblem,
		"an indented line is a code block"
	);

	const withoutButton = { name: "Field notes", confirmation: { subject: "Welcome", markdown: "No button here" } };
	assert.deepEqual(getConfirmationContent(withoutButton), builtIn, "the built-in email goes out instead");
});

test("confirmation configuration excludes welcome content from the content helper", () => {
	const welcome = { enabled: true, subject: "Welcome to Field notes", markdown: "Hello" };
	assert.equal(getWelcomeContent({ requireConfirmation: true, welcome }), null);
	assert.equal(getWelcomeContent({ requireConfirmation: false, welcome }).subject, "Welcome to Field notes");
	assert.equal(getWelcomeContent({ welcome }).subject, "Welcome to Field notes");
});

test("the check-your-inbox button opens the subscriber's webmail", () => {
	const webmails = { "googlemail.com": "Gmail", "hotmail.co.uk": "Outlook", "proton.me": "Proton Mail" };
	const inboxes = Object.keys(webmails).map((domain) => getInbox({ email: `reader@${domain}`, fromEmail: "hi@news.example.org" }));
	assert.deepEqual(
		inboxes.map(({ name }) => name),
		Object.values(webmails)
	);
	const [gmail] = inboxes;
	assert.ok(gmail.url.startsWith("https://mail.google.com/mail/u/0/#search/"));
	assert.ok(decodeURIComponent(gmail.url).includes("from:hi@news.example.org in:anywhere"));
	assert.equal(getInbox({ email: "founder@acme.example" }), null);
});
