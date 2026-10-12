import { AwsClient } from "aws4fetch";
import { assertEmailKindSupported } from "./email-policy.js";
import { formatFromAddress } from "./sending-rules.js";

export function getSesConfiguration(env = process.env) {
	const region = env.SES_REGION || env.AWS_REGION || "us-east-1";
	if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region) || region.startsWith("cn-")) {
		throw Object.assign(new Error("Use an SES region in the standard AWS partition"), { code: "E_EMAIL_NOT_CONFIGURED" });
	}
	return {
		region,
		accessKeyId: env.SES_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
		secretAccessKey: env.SES_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
		sessionToken: env.SES_SESSION_TOKEN || env.AWS_SESSION_TOKEN || undefined,
		configurationSet: env.SES_CONFIGURATION_SET || undefined,
	};
}

// Sign once, fetch once. AwsClient.fetch has automatic retries, so it is never
// used here: an HTTP timeout or 5xx can be ambiguous after SES accepted an email.
export function createSesClient(configuration, { fetcher = fetch } = {}) {
	const { region, accessKeyId, secretAccessKey, sessionToken } = configuration;
	if (!accessKeyId || !secretAccessKey) {
		throw Object.assign(new Error("SES credentials are not configured"), { code: "E_EMAIL_NOT_CONFIGURED" });
	}
	const signer = new AwsClient({ region, service: "ses", accessKeyId, secretAccessKey, sessionToken, retries: 0 });
	const origin = `https://email.${region}.amazonaws.com`;
	return async function sesRequest(path, { method = "GET", body, timeoutMs = 5000 } = {}) {
		if (!path.startsWith("/v2/email/")) throw new Error("Invalid SES API path");
		const request = await signer.sign(`${origin}${path}`, {
			method,
			headers: { "content-type": "application/json" },
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		});
		const response = await fetcher(request, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
		const result = await response.json().catch(() => null);
		if (!response.ok) {
			const rawCode = result?.__type || result?.code || response.headers.get("x-amzn-errortype") || "SesHttpError";
			const code = String(rawCode).split("#").at(-1).split(":")[0];
			throw Object.assign(new Error(result?.message || result?.Message || `SES request failed (${response.status})`), { name: code, code, status: response.status });
		}
		if (!result || typeof result !== "object") throw new Error("SES returned an invalid response; inspect sending logs before retrying");
		return result;
	};
}

function address(value) {
	return typeof value === "string" ? value : formatFromAddress({ fromEmail: value?.email, fromName: value?.name });
}

export async function sendEmailWithSes(request, { kind, from, to, replyTo, subject, html, text, headers = {}, tags = [] }, { configurationSet } = {}) {
	assertEmailKindSupported(kind);
	const result = await request("/v2/email/outbound-emails", {
		method: "POST",
		timeoutMs: 20_000,
		body: {
			FromEmailAddress: address(from),
			Destination: { ToAddresses: [address(to)] },
			...(replyTo ? { ReplyToAddresses: [address(replyTo)] } : {}),
			...(configurationSet ? { ConfigurationSetName: configurationSet } : {}),
			EmailTags: tags.map(({ name, value }) => ({ Name: name, Value: String(value) })),
			Content: { Simple: {
				Subject: { Data: subject, Charset: "UTF-8" },
				Body: { Html: { Data: html, Charset: "UTF-8" }, Text: { Data: text, Charset: "UTF-8" } },
				Headers: Object.entries(headers).map(([Name, Value]) => ({ Name, Value })),
			} },
		},
	});
	if (!result?.MessageId) throw new Error("SES accepted the request without a message ID; inspect sending logs before retrying");
	return { providerMessageId: result.MessageId };
}
