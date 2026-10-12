import { handleEmailEvent } from "@/lib/email-events";
import { createSesWebhookHandler } from "@/lib/sns-webhook";

// Subscribe with raw message delivery OFF so SNS supplies its signed envelope.
export const POST = createSesWebhookHandler({
	topicArn: () => process.env.SES_SNS_TOPIC_ARN,
	handleEvent: handleEmailEvent,
});
