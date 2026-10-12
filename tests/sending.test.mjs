import assert from "node:assert/strict";
import { test } from "node:test";
import { LIMITS } from "../lib/config.js";
import { UNSUBSCRIBE_PLACEHOLDER } from "../lib/render-email.js";
import {
	buildRecipientEmail,
	chunk,
	formatFromAddress,
	getCampaignPauseReason,
	getIssueWebUrl,
	getNextStepLimit,
	getSendErrorAction,
	getSendProblem,
	getWelcomeContent,
} from "../lib/sending-rules.js";
import { verifyUnsubscribeToken } from "../lib/unsubscribe.js";

process.env.SESSION_SECRET = "test-session-secret-with-at-least-32-characters";
process.env.APP_URL = "https://mail.example.com";

const newsletter = {
	_id: "74f1a2b3c4d5e6f7a8b9c0d2",
	name: "Field notes",
	fromName: "Jane Doe",
	fromEmail: "jane@example.net",
	replyTo: "",
	postalAddress: "1 Main St, Paris",
};
const contact = { _id: "64f1a2b3c4d5e6f7a8b9c0d1", email: "reader@example.com" };
const campaign = {
	format: "markdown",
	subject: "Issue 12",
	previewText: "This week",
	markdown: "# Hello\n\nRead [this](https://example.com).",
};



test("recipient emails carry a personal unsubscribe link and one-click headers", () => {
	const email = buildRecipientEmail({ campaign, newsletter, contact });
	const token = new URL(email.unsubscribeUrl).searchParams.get("token");

	assert.equal(email.from, '"Jane Doe" <jane@example.net>');
	assert.equal(email.to, "reader@example.com");
	assert.equal(email.replyTo, undefined);
	assert.equal(email.subject, "Issue 12");
	assert.ok(!email.html.includes(UNSUBSCRIBE_PLACEHOLDER));
	assert.ok(!email.text.includes(UNSUBSCRIBE_PLACEHOLDER));
	assert.ok(email.html.includes(`href="${email.unsubscribeUrl}"`));
	assert.ok(email.text.includes(`Unsubscribe: ${email.unsubscribeUrl}`));
	assert.deepEqual(verifyUnsubscribeToken(token), {
		contactId: contact._id,
		newsletterId: newsletter._id,
	});
	assert.deepEqual(email.headers, {
		"List-Unsubscribe": `<https://mail.example.com/api/unsubscribe?token=${token}>`,
		"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
	});
	assert.equal(email.bytes, Buffer.byteLength(email.html));
});

test("custom HTML keeps its own unsubscribe link, filled in per recipient", () => {
	const html = `<html><body><p>Issue</p><a href="${UNSUBSCRIBE_PLACEHOLDER}">Leave</a></body></html>`;
	const email = buildRecipientEmail({
		campaign: { format: "html", subject: "Issue", html },
		newsletter: { ...newsletter, replyTo: "hello@example.net" },
		contact,
	});
	assert.equal(email.html.match(/unsubscribe\?token=/g).length, 1);
	assert.ok(!email.html.includes(UNSUBSCRIBE_PLACEHOLDER));
	assert.ok(email.text.includes(email.unsubscribeUrl));
	assert.equal(email.replyTo, "hello@example.net");
});

test("issues link to their archive page; drafts to the one their subject gives", () => {
	const archived = { ...newsletter, slug: "weekly", archiveEnabled: true };
	const issue = { ...campaign, _id: "84f1a2b3c4d5e6f7a8b9c0d3", archiveSlug: "issue-12-is-out" };

	const sent = buildRecipientEmail({ campaign: issue, newsletter: archived, contact });
	assert.ok(sent.html.includes('href="https://mail.example.com/archive/weekly/p/issue-12-is-out"'));
	assert.ok(sent.text.startsWith("Read online: https://mail.example.com/archive/weekly/p/issue-12-is-out"));

	const draft = buildRecipientEmail({ campaign: { ...issue, archiveSlug: undefined }, newsletter: archived, contact });
	assert.ok(draft.html.includes('href="https://mail.example.com/archive/weekly/p/issue-12"'));

	assert.equal(getIssueWebUrl({ campaign: issue, newsletter }), null, "archive off");
	assert.equal(getIssueWebUrl({ campaign: { ...issue, archiveListed: false }, newsletter: archived }), null);
	const welcome = getWelcomeContent({ welcome: { enabled: true, subject: "Welcome", markdown: "Hi" } });
	assert.equal(getIssueWebUrl({ campaign: welcome, newsletter: archived }), null, "welcome email");
});

test("each step reaches the most engaged contacts up to what was sent plus the step", () => {
	assert.equal(getNextStepLimit({ sentSoFar: 2000, additional: 5000 }), 7000);
	assert.equal(getNextStepLimit({ sentSoFar: 2000, additional: undefined }), undefined, "everyone left");
	assert.equal(getNextStepLimit({ sentSoFar: 2000, additional: 0 }), undefined);
	assert.equal(getNextStepLimit({ sentSoFar: 2000, additional: 2.5 }), undefined);
});

test("each recipient gets a different unsubscribe token", () => {
	const first = buildRecipientEmail({ campaign, newsletter, contact });
	const second = buildRecipientEmail({
		campaign,
		newsletter,
		contact: { _id: "64f1a2b3c4d5e6f7a8b9c0d9", email: "other@example.com" },
	});
	assert.notEqual(first.unsubscribeUrl, second.unsubscribeUrl);
	assert.equal(second.to, "other@example.com");
});

test("from names are quoted, encoded, and can't inject headers", () => {
	const fromEmail = "jane@example.net";
	assert.equal(formatFromAddress({ fromName: "Jane, from Field notes", fromEmail }), `"Jane, from Field notes" <${fromEmail}>`);
	assert.equal(formatFromAddress({ fromName: "  ", fromEmail }), fromEmail);
	assert.equal(formatFromAddress({ fromEmail }), fromEmail);
	assert.equal(
		formatFromAddress({ fromName: 'Jane "Doe"\r\nBcc: x@evil.example', fromEmail }),
		`"Jane DoeBcc: x@evil.example" <${fromEmail}>`
	);
	assert.equal(
		formatFromAddress({ fromName: "L'équipe Field notes", fromEmail }),
		`=?UTF-8?B?${Buffer.from("L'équipe Field notes").toString("base64")}?= <${fromEmail}>`
	);
});

test("campaigns pause above the bounce or complaint limit once 100 are sent", () => {
	assert.equal(LIMITS.bounceRate, 0.02);
	assert.equal(LIMITS.complaintRate, 0.0008);

	assert.equal(getCampaignPauseReason(), null);
	assert.equal(getCampaignPauseReason({ sent: 99, bounced: 50, complained: 10 }), null);
	assert.equal(getCampaignPauseReason({ sent: 100, bounced: 2 }), null);
	assert.equal(getCampaignPauseReason({ sent: 100, bounced: 3 }), "bounce rate");
	assert.equal(getCampaignPauseReason({ sent: 1250, complained: 1 }), null);
	assert.equal(getCampaignPauseReason({ sent: 1000, complained: 1 }), "complaint rate");
	assert.equal(getCampaignPauseReason({ sent: 5000, bounced: 99, complained: 4 }), null);
});

test("provider rejections retry safely while ambiguous delivery errors need review", () => {
	const error = (code) => Object.assign(new Error(code), { code });
	assert.equal(getSendErrorAction(error("TooManyRequestsException")), "retry");
	assert.equal(getSendErrorAction(new Error("Sending is off")), "retry");
	assert.equal(getSendErrorAction(error("MailFromDomainNotVerifiedException")), "pause");
	assert.equal(getSendErrorAction(error("LimitExceededException")), "pause");
	assert.equal(getSendErrorAction(error("BadRequestException")), "fail");
	assert.equal(getSendErrorAction(error("InternalServiceErrorException")), "uncertain");
	assert.equal(getSendErrorAction(new Error("network connection lost")), "uncertain");
});

test("send problems block incomplete or oversized emails", () => {
	assert.equal(getSendProblem({ campaign, newsletter }), null);
	assert.equal(getSendProblem({ campaign, newsletter: null }), "Newsletter not found");
	assert.equal(
		getSendProblem({ campaign, newsletter: { ...newsletter, fromEmail: "" } }),
		"Add a from email to the newsletter"
	);
	assert.equal(getSendProblem({ campaign: { ...campaign, subject: "  " }, newsletter }), "Add a subject");
	assert.equal(getSendProblem({ campaign: { ...campaign, markdown: "" }, newsletter }), "Add content");
	assert.equal(
		getSendProblem({ campaign: { ...campaign, format: "html", html: " " }, newsletter }),
		"Add content"
	);

	const oversized = { ...campaign, markdown: "word ".repeat(30_000) };
	assert.match(getSendProblem({ campaign: oversized, newsletter }), /Gmail clips emails over 100 KB/);
});

test("welcome content needs the toggle, a subject, and content", () => {
	const welcome = { enabled: true, subject: " Welcome ", markdown: "Hello" };
	assert.equal(getWelcomeContent(null), null);
	assert.equal(getWelcomeContent({ welcome: { ...welcome, enabled: false } }), null);
	assert.equal(getWelcomeContent({ welcome: { ...welcome, subject: "" } }), null);
	assert.equal(getWelcomeContent({ welcome: { ...welcome, markdown: " \n" } }), null);
	assert.deepEqual(getWelcomeContent({ welcome }), {
		format: "markdown",
		subject: "Welcome",
		markdown: "Hello",
		previewText: "",
	});
	assert.equal(getWelcomeContent({ welcome: { ...welcome, previewText: " Reply hi " } }).previewText, "Reply hi");
});

test("chunk splits ids into send batches", () => {
	assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
	assert.deepEqual(chunk([], 50), []);
	assert.equal(chunk(Array.from({ length: 120 }, (_, index) => index), 50).length, 3);
});
