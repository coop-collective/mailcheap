import crypto from "node:crypto";
import { readBoundedBody } from "./request-body.js";

// Exactly sns.<region>.amazonaws.com: a looser pattern also matched S3 bucket hosts like sns.s3.amazonaws.com.
const AWS_SNS_HOST = /^sns\.[a-z]{2}(?:-[a-z]+)+-\d+\.amazonaws\.com$/;
const SIGNING_CERT_PATH = /^\/SimpleNotificationService-[a-z0-9]+\.pem$/i;
const SIGNATURE_ALGORITHMS = new Map([
	["1", "RSA-SHA1"],
	["2", "RSA-SHA256"],
]);
const SUBSCRIPTION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
// AWS spec: keys in byte order, Subject only when the notification has one.
const SIGNED_KEYS = new Map([
	["Notification", ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]],
	["SubscriptionConfirmation", SUBSCRIPTION_KEYS],
	["UnsubscribeConfirmation", SUBSCRIPTION_KEYS],
]);
const OPTIONAL_KEYS = new Set(["Subject"]);
const MAX_CACHED_CERTIFICATES = 20;
const CERTIFICATE_TTL_MS = 6 * 60 * 60_000;
const PEM_PATTERN = /-----BEGIN (CERTIFICATE|PUBLIC KEY)-----/;

function parseAwsSnsUrl(value) {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		const isAws =
			url.protocol === "https:" &&
			AWS_SNS_HOST.test(url.hostname) &&
			!url.port &&
			!url.username &&
			!url.password;
		return isAws ? url : null;
	} catch {
		return null;
	}
}

export function isValidSigningCertUrl(value) {
	const url = parseAwsSnsUrl(value);
	return Boolean(url && SIGNING_CERT_PATH.test(url.pathname) && !url.search && !url.hash);
}

export function isValidSubscribeUrl(value, topicArn, token) {
	const url = parseAwsSnsUrl(value);
	if (!url || url.pathname !== "/" || url.hash || url.searchParams.get("Action") !== "ConfirmSubscription") return false;
	if (!url.searchParams.get("TopicArn") || !url.searchParams.get("Token")) return false;
	if (topicArn && url.searchParams.get("TopicArn") !== topicArn) return false;
	if (token && url.searchParams.get("Token") !== token) return false;
	if (topicArn && url.hostname !== `sns.${topicArn.split(":")[3]}.amazonaws.com`) return false;
	return true;
}

export function buildSigningString(message) {
	const keys = SIGNED_KEYS.get(message?.Type);
	if (!keys) return null;

	let signingString = "";
	for (const key of keys) {
		const value = Object.hasOwn(message, key) ? message[key] : undefined;
		if (value == null && OPTIONAL_KEYS.has(key)) continue;
		if (typeof value !== "string") return null;
		signingString += `${key}\n${value}\n`;
	}
	return signingString;
}

async function fetchAwsCertificate(url) {
	const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new Error(`Certificate request failed with ${response.status}`);
	return new TextDecoder().decode(await readBoundedBody(response, 32 * 1024));
}

export function createSnsVerifier({ fetchCertificate = fetchAwsCertificate } = {}) {
	const certificates = new Map();

	async function getCertificate(url) {
		const cached = certificates.get(url);
		if (cached?.expiresAt > Date.now()) return cached.pem;
		let pem;
		try { pem = String(await fetchCertificate(url)); }
		catch (cause) { throw Object.assign(new Error("SNS signing certificate is temporarily unavailable", { cause }), { code: "SNS_CERTIFICATE_UNAVAILABLE" }); }
		if (!PEM_PATTERN.test(pem) || pem.length > 32 * 1024) return null;
		if (certificates.size >= MAX_CACHED_CERTIFICATES) certificates.delete(certificates.keys().next().value);
		// Cache only resolved PEM, avoiding cross-request I/O Promises in Workers.
		certificates.set(url, { pem, expiresAt: Date.now() + CERTIFICATE_TTL_MS });
		return pem;
	}

	return async function verifySnsMessage(message) {
		const algorithm = SIGNATURE_ALGORITHMS.get(message?.SignatureVersion);
		const signingString = buildSigningString(message);
		if (!algorithm || !signingString || typeof message.Signature !== "string") return false;
		if (!isValidSigningCertUrl(message.SigningCertURL)) return false;

		const certificate = await getCertificate(message.SigningCertURL);
		if (!certificate) return false;
		try {
			return crypto
				.createVerify(algorithm)
				.update(signingString, "utf8")
				.verify(certificate, message.Signature, "base64");
		} catch {
			return false;
		}
	};
}

export const verifySnsMessage = createSnsVerifier();
