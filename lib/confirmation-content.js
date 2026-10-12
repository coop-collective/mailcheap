import { renderEmail } from "./render-email.js";

export const CONFIRM_URL_PLACEHOLDER = "{{confirm_url}}";
const CONFIRM_LINK = `href="${CONFIRM_URL_PLACEHOLDER}"`;

// The built-in email, and where a newsletter's own version starts. Kept short: one job, one button.
function getDefaultConfirmation(newsletter) {
	const name = newsletter?.name?.trim() || "the newsletter";
	return {
		subject: `Confirm your subscription to ${name}`,
		previewText: `Confirm your email address for ${name}.`,
		markdown: `**One click and you're in.**

You asked to subscribe to ${name}. Confirm your email address to complete your subscription.

<a ${CONFIRM_LINK} style="display:inline-block;background:#18181b;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px;">Confirm my subscription</a>

Didn't sign up? Ignore this email and you won't hear from us again.`,
	};
}

// Markdown links encode the braces (%7B%7B), so only an HTML link keeps the placeholder.
export function getConfirmationProblem({ subject, markdown }) {
	if (!subject?.trim()) return "Confirmation email needs a subject";
	if (!renderEmail({ markdown }).html.includes(CONFIRM_LINK)) {
		return `Confirmation email needs its button: a link like <a ${CONFIRM_LINK}>Confirm</a>`;
	}
	return null;
}

// Use valid saved content for both previews and sending, with the built-in template as fallback.
export function getConfirmationContent(newsletter) {
	const custom = newsletter?.confirmation;
	const { subject, previewText, markdown } =
		custom && !getConfirmationProblem(custom) ? custom : getDefaultConfirmation(newsletter);
	return { format: "markdown", subject: subject.trim(), previewText: previewText?.trim() ?? "", markdown };
}
