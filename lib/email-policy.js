// SES supports this app's transactional and permission-based newsletter mail.
const SUPPORTED_KINDS = new Set(["campaign", "last-chance", "welcome", "confirmation", "test", "alert"]);

export function isEmailKindSupported(kind) {
	return SUPPORTED_KINDS.has(kind);
}

export function assertEmailKindSupported(kind) {
	if (isEmailKindSupported(kind)) return;
	throw Object.assign(new Error("Unsupported email message kind"), { code: "E_UNSUPPORTED_EMAIL_KIND" });
}

const RETRY_ERRORS = new Set(["TooManyRequestsException", "ThrottlingException", "Throttling", "E_SENDING_DISABLED"]);
const PAUSE_ERRORS = new Set([
	"AccountSuspendedException", "SendingPausedException", "MailFromDomainNotVerifiedException",
	"LimitExceededException", "NotFoundException", "AccessDeniedException", "UnrecognizedClientException",
	"InvalidClientTokenId", "ExpiredToken", "ExpiredTokenException", "SignatureDoesNotMatch", "E_EMAIL_NOT_CONFIGURED",
]);
const REJECT_ERRORS = new Set(["MessageRejected", "BadRequestException", "ValidationException", "E_UNSUPPORTED_EMAIL_KIND", "E_CONTENT_MISSING"]);

// An ambiguous network/5xx result may have sent the message. Only explicit SES
// rejection before acceptance can cause a retry; never silently repeat a send.
export function getEmailErrorAction(error) {
	const name = error?.code || error?.name;
	if (error?.status >= 500) return "uncertain";
	if (RETRY_ERRORS.has(name)) return /daily (?:message|sending) quota exceeded/i.test(error?.message || "") ? "pause" : "retry";
	if (PAUSE_ERRORS.has(name)) return "pause";
	if (name === "MessageRejected" && /not verified/i.test(error?.message || "")) return "pause";
	if (REJECT_ERRORS.has(name)) return "fail";
	return "uncertain";
}
