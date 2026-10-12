import "server-only";
import { headers } from "next/headers";
import { after } from "next/server";
import { formatActivity } from "@/lib/activity";
import { getAppUrl, isSendingEnabled } from "@/lib/config";
import { connectDb } from "@/lib/db";
import { getClientIp } from "@/lib/rate-limit";
import { sendEmail as sendProviderEmail } from "@/lib/email";
import Alert from "@/models/Alert";

const DEFAULT_COOLDOWN_MINUTES = 60;

function escapeHtml(value) {
	return String(value)
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

// Optional: needs ALERT_FROM on a verified domain, and goes out only while sending is on.
async function sendEmail({ title, text }) {
	const { ALERT_FROM: from, ADMIN_EMAIL: to } = process.env;
	if (!from || !to || !isSendingEnabled()) return;
	await sendProviderEmail({
		kind: "alert",
		from,
		to,
		subject: `[Mailcheap] ${title}`,
		text,
		html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
	});
}

// The upsert only matches once the cooldown is over; inside it, the insert hits the unique key.
async function claimAlert({ key, title, cooldownMinutes }) {
	const now = new Date();
	const cutoff = new Date(now.getTime() - cooldownMinutes * 60_000);
	try {
		await Alert.updateOne(
			{ key, $or: [{ lastSentAt: { $lt: cutoff } }, { lastSentAt: null }] },
			{ $set: { title, lastSentAt: now } },
			{ upsert: true }
		);
		return true;
	} catch (error) {
		if (error?.code === 11000) return false;
		throw error;
	}
}

// Never throws: a failing alert must not break a send or a webhook. Always logged; emailed to
// ADMIN_EMAIL at most once per cooldown.
export async function sendAlert({ key, title, detail, path = "", cooldownMinutes = DEFAULT_COOLDOWN_MINUTES }) {
	console.warn(`[alert] ${title}: ${detail}`);
	try {
		await connectDb();
		if (!(await claimAlert({ key, title, cooldownMinutes }))) return;
		await sendEmail({ title, text: `${title}\n${detail}\n${getAppUrl()}${path}` });
	} catch (error) {
		console.error("[alert] Could not send:", error?.message);
	}
}

// Logins, new API keys and sends, every time: logged, and emailed like other alerts. It goes out after
// the response, so a failing alert never holds up or blocks the action.
export async function notifyActivity(lines, { withUserAgent = false } = {}) {
	try {
		const list = await headers();
		const text = formatActivity(lines, {
			ip: getClientIp(list),
			country: list.get("cf-ipcountry"),
			userAgent: withUserAgent ? (list.get("user-agent") ?? "") : undefined,
		});
		after(async () => {
			console.info(`[activity] ${text.replaceAll("\n", " | ")}`);
			try {
				await sendEmail({ title: lines[0], text });
			} catch (error) {
				console.error("[alert] Activity notice failed:", error?.message);
			}
		});
	} catch (error) {
		console.error("[alert] Activity notice failed:", error?.message);
	}
}
