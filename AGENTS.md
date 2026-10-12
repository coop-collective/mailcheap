<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cloudflare fork rules

- This fork runs the Next.js API surface on vinext/Vite in Cloudflare Workers.
- Use native D1, R2 and Queues bindings for data, files and background jobs.
  Do not reintroduce MongoDB, Mongoose, Upstash or Vercel Blob dependencies.
- Keep Amazon SES for newsletter and transactional delivery. Use the Workers-safe
  signed HTTPS transport and verify SES event notifications from the allowlisted
  SNS topic. Do not replace SES with Cloudflare Email Sending or add the AWS SDK.
- Preserve campaigns, welcome emails, custom confirmations and re-engagement
  flows. Sending remains explicitly controlled by SENDING_ENABLED and SES quotas.
- Preserve signed-link IDs, suppression behavior, atomic send claims and ambiguous
  delivery handling when adapting upstream updates.
- Keep credentials out of source. The subscription-authenticated Codex runner
  belongs to the private controller described in docs/upstream-sync.md.
- Keep `wrangler.jsonc` generic. Private `.env` IDs, names and settings are
  resolved by `scripts/project-config.mjs`; never commit generated configs.
- Run `npm test`, `npm run lint`, `npm run check:cloudflare` and `npm run build`.
  Apply migrations locally to test schema changes; production migrations and
  deployments require the intended Cloudflare account and resource configuration.
