import { authenticateRequest } from "@/lib/api-keys";
import { getCloudflareEnv } from "@/lib/cloudflare";
import { createTransactionalEmailHandler } from "@/lib/transactional-email";

export const POST = createTransactionalEmailHandler({ authenticate: authenticateRequest, getEnv: getCloudflareEnv });
