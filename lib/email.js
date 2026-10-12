import "server-only";
import { isSendingEnabled } from "@/lib/config";
import { createSesClient, getSesConfiguration, sendEmailWithSes } from "@/lib/email-transport";

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map();

function client() {
	const configuration = getSesConfiguration();
	return { configuration, request: createSesClient(configuration) };
}

async function cached(key, fresh, load) {
	const hit = cache.get(key);
	if (!fresh && hit?.expiresAt > Date.now()) return hit.value;
	// Cache resolved data, never a Promise tied to another Workers request context.
	const value = await load();
	if (!value?.error) cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
	return value;
}

export async function getEmailAccount({ fresh = false } = {}) {
	return cached("account", fresh, async () => {
		try {
			const { request } = client();
			const account = await request("/v2/email/account");
			return {
				configured: true,
				productionAccess: Boolean(account.ProductionAccessEnabled),
				productionAccessEnabled: Boolean(account.ProductionAccessEnabled),
				reviewStatus: account.Details?.ReviewDetails?.Status || null,
				sendingEnabled: isSendingEnabled() && Boolean(account.SendingEnabled),
				providerSendingEnabled: Boolean(account.SendingEnabled),
				enforcementStatus: account.EnforcementStatus,
				max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
				maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
				sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
			};
		} catch (error) {
			return { error: error.message, configured: error.code !== "E_EMAIL_NOT_CONFIGURED", sendingEnabled: false };
		}
	});
}

function dnsRecords(domain, identity, region) {
	const dkim = (identity.DkimAttributes?.Tokens || []).map((token) => ({ type: "CNAME", name: `${token}._domainkey.${domain}`, value: `${token}.dkim.amazonses.com` }));
	const mailFrom = identity.MailFromAttributes?.MailFromDomain;
	return [...dkim, ...(mailFrom ? [
		{ type: "MX", name: mailFrom, value: `10 feedback-smtp.${region}.amazonses.com` },
		{ type: "TXT", name: mailFrom, value: "v=spf1 include:amazonses.com ~all" },
	] : [])];
}

export async function listEmailDomains({ fresh = false } = {}) {
	return cached("domains", fresh, async () => {
		try {
			const { request, configuration } = client();
			const domains = [];
			let nextToken;
			do {
				const query = new URLSearchParams({ PageSize: "100" });
				if (nextToken) query.set("NextToken", nextToken);
				const page = await request(`/v2/email/identities?${query}`);
				for (const { IdentityName: domain, IdentityType: type } of page.EmailIdentities ?? []) {
					if (type !== "DOMAIN") continue;
					const identity = await request(`/v2/email/identities/${encodeURIComponent(domain)}`);
					domains.push({
						domain, verified: Boolean(identity.VerifiedForSendingStatus),
						dkimStatus: identity.DkimAttributes?.Status || "NOT_STARTED",
						mailFromDomain: identity.MailFromAttributes?.MailFromDomain || null,
						mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus || null,
						records: dnsRecords(domain, identity, configuration.region),
					});
				}
				nextToken = page.NextToken;
			} while (nextToken);
			return domains;
		} catch (error) { return { error: error.message }; }
	});
}

export async function sendEmail(message) {
	if (!isSendingEnabled()) throw Object.assign(new Error("Sending is off"), { code: "E_SENDING_DISABLED" });
	const { configuration, request } = client();
	return sendEmailWithSes(request, message, configuration);
}
