# Mailcheap on Cloudflare

A Cloudflare-native fork of [marclou/mailcheap](https://github.com/marclou/mailcheap). The existing React dashboard, editor, contacts, API, tracking links and public archives run on **vinext in Cloudflare Workers**.

MongoDB/Mongoose, Upstash QStash/Redis and Vercel Blob are removed. Application records live in Cloudflare D1; there is no separately hosted database to operate. Amazon SES handles newsletters through signed HTTPS without the AWS SDK. SNS delivers authenticated SES email events to the Worker. An optional [transactional email API](#transactional-email-api) uses Cloudflare Email Service for messages such as verification codes, password resets and receipts.

Newsletter campaigns, welcome emails, custom opt-in confirmations, re-engagement messages and test sends use SES. Sending starts only after `SENDING_ENABLED=true` and the SES account/domain checks pass.

**Email cost:** SES à-la-carte outbound sending is **$0.10 per 1,000 emails** before attachment data and optional features. New or qualifying inactive account/region combinations now default to **Essentials at $0.16 per 1,000** in the first volume tier. Select à-la-carte in SES if you want its base rate; installing this app does not choose or change your AWS pricing plan. Check the account's current plan and additional charges in [AWS SES pricing](https://aws.amazon.com/ses/pricing/).

## Quick start

Install Node.js 24 LTS and pnpm 11.13.0, then:

```sh
git clone https://github.com/coop-collective/mailcheap.git
cd mailcheap
pnpm install --frozen-lockfile
pnpm setup
pnpm deploy
```

If pnpm is not installed, install it with `npm install --global pnpm@11.13.0`.
Setup walks through your Cloudflare account and resources and generates a private
`.env`. The repository includes only blank/example environment templates; your
`.env`, credentials, resource IDs and generated configuration stay ignored by Git.
For local development only, use `pnpm run setup --local` followed by `pnpm dev`.
pnpm is the project's package manager. Commit dependency changes to `pnpm-lock.yaml`;
overrides and dependency build permissions live in `pnpm-workspace.yaml`.

Sending starts disabled. Complete [SES setup](#amazon-ses-setup) for newsletters
or [Cloudflare Email Service setup](#cloudflare-transactional-email-setup) for the transactional API. See [deployment](#deploy) for restoring an existing installation, custom
domains and a dry run, and [upstream updates](#upstream-updates-with-codex) for the
optional private Codex runner.

## Stack

| Responsibility | Service |
| --- | --- |
| React, Server Components, actions, API and archive routes | Workers + vinext |
| Contacts, newsletters, campaigns, messages, events, suppressions, keys | D1, with migrations and indexed SQL queries |
| Editor image uploads and permanent public image URLs | R2 through `/media/images/*` |
| Campaigns and subscriber lifecycle emails | Amazon SES v2 API over signed HTTPS |
| Transactional email API for other apps | Optional Cloudflare Email Service binding |
| Send jobs | Cloudflare Queues |
| Delivery, bounce and complaint events | Amazon SNS → signature-verified Worker webhook |
| Scheduled work, interrupted-send recovery and expiration cleanup | Cron Trigger |
| Shared rate limits | Atomic D1 counters; deny on storage outage |
| Upstream adaptation | GitHub Actions + private Codex runner controller |

The image editor resizes uploads before storage. No separate image resizing service or external cache account is required. vinext remains an evolving Next.js implementation; test your deployment before moving traffic.

### What is optional?

| Component | Needed when |
| --- | --- |
| Workers, D1 and admin credentials | Always; D1 replaces the separately hosted database |
| Queues and Cron | Sending, scheduling and recovery; included in the default setup |
| R2 | Uploading and serving images; use `--skip-r2` if your images are hosted elsewhere |
| SES credentials and SNS feedback | Sending campaigns and subscriber lifecycle emails |
| Cloudflare Email Service and an onboarded sender domain | Sending through the optional transactional API; configured separately from SES |
| `ALERT_FROM` | Sending admin email notifications |
| Custom app/archive domains | Using your own domain instead of the default `workers.dev` address |
| Codex runner and private controller | Automatically adapting upstream updates |

No KV, Durable Objects, MailerLite account, Redis or MongoDB service is required. With R2 omitted, the editor disables uploads; externally hosted images in HTML/Markdown still work. Keep the bucket binding if you already have uploaded images: removing it makes those URLs unavailable, although setup never deletes the bucket.

## Local development

Use Node.js 24 LTS (minimum 22.15) and pnpm 11.13.0, pinned by the package manifest.

```sh
pnpm install --frozen-lockfile
pnpm run setup --local
pnpm run dev
```

`pnpm run setup --local` creates or reuses local credentials and applies local D1 migrations without logging in to Cloudflare or creating cloud resources. The guided default, `pnpm setup`, also authenticates to Cloudflare as needed and creates or reuses the production resources described below. Setup writes private values to `.env` by default, with owner-only permissions. Read `ADMIN_PASSWORD` there to log in; credentials are never printed. Existing passwords and signing secrets are preserved on reruns.

`.env` is the preferred environment file. Existing `.dev.vars` is supported as a legacy fallback when `.env` is absent. Pass `--env-file PATH` to select another private file. Setup refuses to write secrets into tracked example files. Project scripts make the selected file authoritative and create filtered local dev variables under ignored `.wrangler/mailcheap/`, so a root `.dev.vars` cannot shadow `.env` values.

Open `http://localhost:3000`. Vite runs the server in Cloudflare's local workerd runtime with local D1, R2 and Queues. `LOCAL_APP_URL` defaults to `http://localhost:3000`; `LOCAL_SENDING_ENABLED` defaults to `false`. Local-only setup needs no Cloudflare login, cloud resources or AWS credentials. Do not use real credentials in tests.

```sh
pnpm test
pnpm run lint
pnpm run check:cloudflare
pnpm run build
pnpm run preview
```

`preview` serves the built Worker on Wrangler's local port (normally 8787) and explicitly shares `.wrangler/state` with development and local migrations. Set `LOCAL_APP_URL` if testing generated links. `pnpm run cf:types` generates binding types from Wrangler config.

Test files run sequentially so local Worker startup and D1 integration tests do not compete with the archive parser's timing assertions. The parser's time limits remain enforced.

Validation includes application tests with real local D1 transactions, upstream workflow fixture suites, browser flows on workerd, a production build and Wrangler packaging dry run. No live SES delivery or subscription-authenticated upstream run has been exercised. The dependency audit still reports the upstream `braces` nesting advisory through vinext/build tooling; the latest published `braces` version has no fix. The vulnerable `fflate` version pulled by Satori is overridden to its patched release. Recheck upstream advisories before production rollout.

## Deploy

Run the guided setup to authenticate and provision the Cloudflare resources:

```sh
pnpm setup
pnpm deploy
```

Setup asks for your admin email and any missing Worker, D1, R2 and Queue names; it asks you to choose an account when multiple accounts are available. If interactive Cloudflare authentication is missing, Wrangler opens its browser login. You can also provide a Cloudflare API token in `.env` or use an existing Wrangler login. Setup reuses resources that match the supplied IDs or names, creates missing resources, and saves discovered IDs and names back to the private environment file. If `D1_DATABASE_ID` is set without a database name, setup discovers the actual name; an explicit name that does not match the ID is rejected.

Cloudflare resource settings are `CLOUDFLARE_ACCOUNT_ID`, `WORKER_NAME`, `D1_DATABASE_ID`, `D1_DATABASE_NAME`, `R2_ENABLED`, `R2_BUCKET_NAME`, `EMAIL_QUEUE_NAME` and `EMAIL_DEAD_LETTER_QUEUE_NAME`. R2 is enabled by default. To skip R2, pass `--skip-r2`; setup records `R2_ENABLED=false` in the private environment file. Setup never edits tracked `wrangler.jsonc`. That file is the public template; private `.env` values override its account and resource IDs. Generated configurations and filtered local variables live under ignored `.wrangler/mailcheap/`.

```sh
# Local credentials and local migrations only; no Cloudflare login or provisioning:
pnpm run setup --local
# Skip R2 for this installation:
pnpm run setup --skip-r2
```

`pnpm deploy` reads the private environment file, builds the app, applies pending **remote** D1 migrations, and deploys the Worker code and runtime secrets. Generated build output lives under ignored `dist/`. Only an allowlist of runtime secrets is uploaded; the Cloudflare token is never included in the Worker runtime. `SENDING_ENABLED` controls SES sending and defaults to `false`. Keep it off until SES verification and SNS are ready. `TRANSACTIONAL_EMAIL_ENABLED` separately controls the Cloudflare API and also defaults to `false`. Existing Worker secrets absent from the environment file are retained by Wrangler; to revoke one, remove it locally and use `pnpm cf secret delete NAME`.

`APP_URL` is the production public URL. Region, SES feedback, send-rate, archive-host, alert and other production variables can be configured in `.env`; they override the public Wrangler template during deployment. No generated values are written back to tracked Wrangler files.

Setup derives `APP_URL` from your existing `workers.dev` subdomain. If there is none, register one in Cloudflare or supply `--app-url https://mail.example.com` and attach that custom domain to the Worker separately. Cloudflare must have the selected products enabled; setup does not change billing plans.

For an **existing installation**, restore its original `.env` (or legacy `.dev.vars`) before deploying from a new checkout. A fresh checkout can deploy with the restored file without rerunning setup. Keep the original `SESSION_SECRET` to preserve unsubscribe, confirmation and tracking links. Changing the admin email or password invalidates sessions. Keep a private backup of this file and your configured resource IDs.

To build and package locally without remote migrations or uploading:

```sh
pnpm run deploy --dry-run
```

Setup and deploy accept `--env-file PATH`. Use `pnpm run` when passing script options, and add a `--` separator when selecting an environment file: `pnpm run setup -- --env-file .env.preview` or `pnpm run deploy -- --dry-run --env-file .env.preview`. The separator prevents pnpm from interpreting `--env-file` as a Node startup option. Bare `pnpm setup` and `pnpm deploy` run this project's scripts with no arguments. The scripts use the top-level Wrangler configuration; named `CLOUDFLARE_ENV` environments are rejected.

SES identity verification, DNS records, configuration-set event delivery and SNS subscription confirmation remain manual Cloudflare/AWS setup steps. The setup command does not make SES or DNS changes.

### Amazon SES setup

Use the same AWS region for the SES identity, configuration set and SNS topic. Set `AWS_REGION` in `.env` (default `us-east-1`). Campaigns and subscriber lifecycle messages use SES; the optional `/api/v1/emails` endpoint uses Cloudflare Email Service.

1. Verify a sending domain in SES, add its Easy DKIM DNS records, and configure a custom MAIL FROM domain for SPF alignment. Add a DMARC record for the sending domain. The Domains page reads live SES verification, DKIM and return-path status and shows the DNS records.
2. Request production access for the SES account if it is in the sandbox, and check its sending quota. The overview shows the account's sandbox/production status, health, daily quota and maximum rate.
3. Create a configuration set such as `mailcheap` and set `SES_CONFIGURATION_SET` to its name. Leave SES open/click tracking off; Mailcheap tracks links on your app domain.
4. Create a standard SNS topic such as `mailcheap-ses-events` and set `SES_SNS_TOPIC_ARN` to its exact ARN. Use SNS signature version 2. In the SES configuration set, add an SNS event destination for bounces, complaints, deliveries, delivery delays, rejects and rendering failures.
5. Create a dedicated IAM access key with `ses:SendEmail` for your sending identity and configuration set, plus `ses:GetAccount`, `ses:ListEmailIdentities` and `ses:GetEmailIdentity` for account/domain checks. Put `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` in your private `.env` file. Add `AWS_SESSION_TOKEN` only for temporary credentials. Deploy uploads them as Worker secrets; never put them in Wrangler plaintext variables.
6. Run `pnpm deploy` with sending still off. Add an HTTPS SNS subscription to `https://<your-app>/api/webhooks/ses`, leaving raw message delivery off. The app verifies and confirms the subscription; confirm that SNS shows it as active before sending.
7. Set `ALERT_FROM` to a verified sender for optional admin notifications. Create a newsletter with a verified from address and postal address. Enable `SENDING_ENABLED=true`, send a test to yourself, and verify delivery events before starting a campaign. Start with a conservative `SEND_RATE_PER_SECOND` within your SES quota.

Campaigns, welcome emails, custom confirmations and list-cleanup messages retain the original product behavior. Native Cloudflare Queues process send batches and a minute Cron Trigger handles scheduled campaigns and interrupted jobs. SNS calls the verified webhook directly; no separate Cloudflare email-event queue is needed.

A message is atomically claimed in D1 before delivery. Explicit rate-limit rejection may retry. An ambiguous network/provider result becomes `uncertain` rather than being blindly resent; review SES events before manual recovery. Interrupted claims are marked uncertain after 15 minutes. Monitor the send dead-letter queue and investigate before replaying jobs. There is no claim of exactly-once delivery across D1 and SES.

### Cloudflare transactional email setup

This optional addition sends individual transactional messages for your other apps. It uses the native Workers binding and needs no Cloudflare API token in the application runtime. Newsletter campaigns continue to use SES.

1. Use a Workers Paid plan and a domain managed with Cloudflare DNS. In **Email Service → Email Sending**, onboard your sending domain and complete DNS verification. Follow [Cloudflare's domain setup](https://developers.cloudflare.com/email-service/get-started/send-emails/); `pnpm setup` does not change DNS or onboard email domains.
2. Set these values in your private `.env`:

   ```dotenv
   TRANSACTIONAL_EMAIL_ENABLED=true
   TRANSACTIONAL_EMAIL_FROM=notifications@your-verified-domain.com
   LOCAL_TRANSACTIONAL_EMAIL_ENABLED=false
   ```

3. Run `pnpm deploy`. It applies the new D1 idempotency migration and adds a `TRANSACTIONAL_EMAIL` binding restricted to that sender. Disabled installations have no transactional email binding. SES credentials are unnecessary for this endpoint; `SENDING_ENABLED` can remain `false` if you only use the transactional API.
4. Create a named key for the calling app on **API keys**, store it in that app's backend environment, and call the [endpoint below](#transactional-email-api). Existing keys also gain access when you enable it: keys are not scoped to individual operations or newsletters.

One sender address is configured per installation. Check delivery status and Cloudflare suppressions in **Email Service**. These messages do not create newsletter contacts, use newsletter unsubscribe preferences, appear in campaign reports, or use the SES/SNS tracking flow. They are for service messages triggered by your app, not newsletter or marketing campaigns. Cloudflare's [Email Service plan requirements](https://developers.cloudflare.com/email-service/) and [sending charges](https://developers.cloudflare.com/email-service/platform/pricing/) apply separately from SES.

For local simulation, set `LOCAL_TRANSACTIONAL_EMAIL_ENABLED=true` and a `TRANSACTIONAL_EMAIL_FROM` address, then run `pnpm run db:migrate:local` and `pnpm dev`. Wrangler simulates the binding without sending real mail; do not enable a remote email binding for this test. Production enabling alone never enables local sending. A built `pnpm start` preview also requires the binding to have been enabled at build time; use `pnpm dev` for local-only setup.

### Configuration

| Variable | Purpose |
| --- | --- |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET` | Required secrets for the dashboard and signed links |
| `APP_URL` | Public HTTPS app URL used in emails, archives and media URLs |
| `LOCAL_APP_URL`, `LOCAL_SENDING_ENABLED` | Local public URL and local sending switch; sending defaults to `false` |
| `SENDING_ENABLED` | Exact `true` enables SES campaigns and subscriber lifecycle emails |
| `TRANSACTIONAL_EMAIL_ENABLED` | Exact `true` enables the Cloudflare transactional API; default `false` |
| `TRANSACTIONAL_EMAIL_FROM` | One bare sender address on a domain onboarded to Cloudflare Email Sending |
| `LOCAL_TRANSACTIONAL_EMAIL_ENABLED` | Local simulation switch, independent of production; default `false` |
| `CLOUDFLARE_ACCOUNT_ID`, `WORKER_NAME` | Cloudflare account and Worker to reuse or create |
| `D1_DATABASE_ID`, `D1_DATABASE_NAME` | D1 database to reuse or create |
| `R2_ENABLED`, `R2_BUCKET_NAME` | Optional R2 storage; enabled by default |
| `EMAIL_QUEUE_NAME`, `EMAIL_DEAD_LETTER_QUEUE_NAME` | Queue resources to reuse or create |
| `AWS_REGION` | SES/SNS region, default `us-east-1` |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Worker secrets for the dedicated IAM sender |
| `AWS_SESSION_TOKEN` | Optional Worker secret for temporary AWS credentials |
| `SES_CONFIGURATION_SET` | SES configuration set publishing delivery events to SNS |
| `SES_SNS_TOPIC_ARN` | Exact SNS topic accepted by `/api/webhooks/ses` |
| `SEND_RATE_PER_SECOND` | Conservative send pacing, 1–14, default 1; provider quotas still apply |
| `ALERT_FROM` | Optional sender for admin alert emails |
| `ARCHIVE_HOSTS` | Optional custom archive domains, e.g. `news.example.com=weekly` |

The legacy aliases `SES_REGION`, `SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY` and `SES_SESSION_TOKEN` are also accepted and take precedence over their AWS equivalents. Use one consistent credential pair. Workers do not read a local AWS credentials file or assume an EC2 role.

Resource bindings are generated from private configuration for deployment: `DB`, optional `IMAGES` (R2), `ASSETS`, `EMAIL_QUEUE`, and optional `TRANSACTIONAL_EMAIL`. These are bindings, not connection-string environment variables. Production rate limiting trusts only `CF-Connecting-IP` set by Cloudflare.

## Existing data

Creating D1 does not transfer MongoDB contents. Keep the old service read-only during cutover, export and back up its records and uploaded media, preserve record IDs and the signing secret, and validate counts, unique contacts, suppression records and sample links before directing traffic here. Do not delete the old database until the migrated data and unsubscribe behavior have been verified. The schema and local adapter tests are in `migrations/` and `tests/d1*`; no remote data migration has been performed.

The offline converter accepts default newline-delimited `mongoexport` files named `newsletters.json`, `contacts.json`, `campaigns.json`, `messages.json`, `suppressions.json`, `events.json`, `alerts.json` and `apikeys.json` (`.ndjson` also works). Export every collection, including empty ones, and compare record counts with the source; the converter reports the collections it finds. It preserves IDs, dates, opt-outs and signing-link references without adding a MongoDB dependency to the app.

```sh
# Use a private directory outside the repository; these exports contain personal data.
node scripts/mongo-export-to-d1.mjs /private/path/exports /private/path/mailcheap-import.sql
# First validate against a fresh local D1 with the schema applied.
pnpm run db:exec --local --file=/private/path/mailcheap-import.sql
# After checking the target account and an EMPTY migrated production database:
pnpm run db:exec --remote --file=/private/path/mailcheap-import.sql
```

The converter only creates a local SQL file with owner-only permissions. It never connects to either database. Importing is a separate explicit operation; do not retry a partial import against existing rows. Restore an empty target and verify counts before cutover. Keep sending disabled throughout.

Old Vercel image URLs in sent emails cannot be rewritten after delivery. Preserve that bucket/domain or migrate assets while keeping their existing URLs reachable.

## Upstream updates with Codex

See [the upstream-sync setup](docs/upstream-sync.md) for the runnable GitHub Actions controller, subscription login and dedicated runner configuration. Because this fork is public, the credentialed automation lives in a **private controller repository**; ordinary CI stays on GitHub-hosted runners.

The controller detects new upstream commits, asks Codex to adapt the delta to this fork's Cloudflare architecture, validates it, and proposes a pull request. It does not automatically merge or deploy. Unchanged upstream revisions and already-open sync PRs skip model work. Subscription usage limits still apply, and the runner itself needs compute; this is not a hosted Codex service or an API-key billing workaround.

## API


Create a key on the **API keys** page and send it as `Authorization: Bearer <key>`. Keep keys in the calling app's backend; never embed them in browser or mobile code.

**Add a contact**: `POST /api/v1/contacts`

```bash
curl -X POST https://<your-app>/api/v1/contacts \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"newsletter":"weekly","email":"jane@example.com","source":"website","ip":"203.0.113.7"}'
```

- `newsletter` (slug) and `email` are required. `source` labels where the signup came from.
- `resubscribe: true` brings back someone who unsubscribed (never someone who bounced or complained).
- Pass your visitor's IP as `ip` to get the per-visitor limit of 5 signups per 10 minutes. Each key is also limited to 600 signups an hour.
- Answers `201` for a new contact, `200` if it already existed, with `{ id, status, created }`. When the newsletter confirms signups, `status` is `pending` and `inbox` links to the reader's email provider for your "check your inbox" message.

**Create a draft**: `POST /api/v1/campaigns` with `newsletter`, `subject`, `previewText` (optional), `html` or `markdown`, and `archiveSlug` (optional). Answers `201` with the draft's id and dashboard URL. Sending stays a click in the dashboard.

**List sent issues**: `GET /api/v1/campaigns?newsletter=<slug>` returns each issue's id, subject, preview text, archive URL and send date.

### Transactional email API

**Send one transactional message**: `POST /api/v1/emails`. Complete [Cloudflare setup](#cloudflare-transactional-email-setup) first. This endpoint uses the same dashboard-generated bearer keys as the other API routes.

```sh
curl https://<your-app>/api/v1/emails \
  -H "Authorization: Bearer $MAILCHEAP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-123-receipt" \
  -d '{
    "to": "customer@example.com",
    "subject": "Your order confirmation",
    "text": "We received order 123. Thank you!",
    "html": "<p>We received order <strong>123</strong>. Thank you!</p>",
    "replyTo": "support@your-verified-domain.com"
  }'
```

| Field | Required | Description |
| --- | --- | --- |
| `to` | Yes | One bare recipient email address |
| `subject` | Yes | 1–200 characters, without control characters |
| `text` | Yes | Nonempty plain-text message |
| `html` | No | Nonempty HTML version accompanying the text |
| `replyTo` | No | One bare reply-to email address |

The sender comes from `TRANSACTIONAL_EMAIL_FROM`. Recipient arrays, custom `from`, attachments, CC/BCC, arbitrary headers and other fields are rejected. The entire JSON body is limited to 128 KiB. The endpoint enforces 100 requests per minute per API key and 1,000 per hour across the installation, using D1 counters. Replays also count toward these limits; Cloudflare's account quotas apply in addition.

Cloudflare acceptance returns **202**:

```json
{ "id": "<cloudflare-message-id>", "status": "accepted", "provider": "cloudflare" }
```

Acceptance does not confirm inbox delivery. The response ID can be used to investigate the message in Cloudflare Email Service logs. The endpoint awaits Cloudflare's response; it does not queue background delivery or automatically retry.

Send an optional **`Idempotency-Key`** for retries: 1–128 letters, numbers, dots, underscores, colons or hyphens. Repeating the same key and normalized message with the same API key within 24 hours returns the recorded outcome with `Idempotency-Replayed: true`, including recorded provider rejections. Changing the message returns **409**. An in-flight or interrupted send also returns **409** until its result is recorded; it is never automatically resent. Use a non-sensitive identifier because the key is stored alongside the message hash and result; the message body and recipient are not stored in this table. Keys expire after 24 hours, after which reuse can send again.

Errors return `{ "error": "...", "code": "..." }`:

| Status | Meaning |
| --- | --- |
| `400` / `413` / `415` | Invalid input, oversized body, or wrong content type |
| `401` | Missing, invalid or revoked API key |
| `409` | Idempotency conflict, send in progress, or an interrupted send with an unknown outcome |
| `422` | Cloudflare rejected the message or recipient, including suppressed recipients |
| `429` | App rate limit or Cloudflare sending quota reached |
| `502` | Unknown delivery outcome; inspect Cloudflare logs before sending again |
| `503` | Disabled sending, missing configuration, sender verification or storage/service failure |

For network timeouts, retry with the **same** idempotency key to retrieve the outcome without issuing another send. After `delivery_unknown` or `send_in_progress_or_unknown`, investigate before using a new key. Without an idempotency key, every call is a new send and retries can duplicate emails. There is no exactly-once delivery guarantee across D1 and Cloudflare Email Service. Local tests cover the API with D1 and a simulated Workers email binding; live delivery requires your configured account and verified domain.

## License

[MIT](LICENSE). Original app by [Marc Lou](https://github.com/marclou); Cloudflare adaptations in this fork.
