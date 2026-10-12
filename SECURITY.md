# Security

Mailcheap is provided as is, with no security support and no promise of fixes. If you run it, you're responsible for your deployment: keep dependencies updated and review changes before you deploy them.

## What's built in

- One admin login. Login attempts are rate limited per IP, and every login, new API key and send is logged and, with `ALERT_FROM` set, emailed to `ADMIN_EMAIL`.
- Mailcheap refuses to start with an `ADMIN_PASSWORD` under 12 characters or a `SESSION_SECRET` under 32.
- Sessions last 7 days, in an httpOnly cookie (`__Host-` prefixed in production) signed with a key derived from `SESSION_SECRET`. Changing `ADMIN_PASSWORD` or `ADMIN_EMAIL` signs out every session.
- Every dashboard page, API route and server action checks the session. Public routes are limited to reader flows, public media and authenticated API-key clients.
- API keys are stored as SHA-256 hashes and can be revoked.
- Unsubscribe, confirmation, "keep sending it" and tracking links are signed with keys derived from `SESSION_SECRET`. Rotating it logs you out and breaks those links in emails already sent.
- Background jobs use native Cloudflare Queues instead of public job HTTP routes. SES lifecycle events arrive at `/api/webhooks/ses`; the handler accepts only the configured SNS topic, verifies the SNS signature using an allowlisted AWS certificate URL, and rejects unauthenticated events.
- Public endpoints are rate limited with shared atomic D1 counters. Storage failures deny requests. Only Cloudflare's `CF-Connecting-IP` is trusted as the connecting address.
- D1 conditional claims prevent two consumers sending the same queued message. Unknown provider outcomes require manual review and are not blindly retried.
- Uploaded images are signature-checked, bounded while streaming, stored in R2 under immutable random keys, and served with `nosniff`.
- Subscription-authenticated Codex automation belongs in a private controller repository with a dedicated runner. Public pull requests never execute on the credentialed runner; generated changes require review before merging.
- Issue HTML shown inline on the archive goes through an allowlist cleaner, then `sanitize-html`, every time the page renders. HTML issues, including every one created through the API, render in a sandboxed iframe without scripts.
- Every response carries a Content Security Policy (no framing, no plugins, no inline event handlers, forms and `<base>` limited to the app's origin) and HSTS.
- Click tracking only redirects to links signed by the app, so it can't be used as an open redirect.

## The archive's domain

Issue pages show HTML that came from the editor and from API keys. Give each newsletter its own archive domain (`ARCHIVE_HOSTS`): that HTML then never shares the dashboard's origin, and the app domain's `/archive` pages redirect there. Without one, the archive stays on the app domain, protected by the sanitizer, the sandboxed frame and the Content Security Policy.

## Reporting a vulnerability

There's no support channel. If you find a problem, fix it in your own deployment. You can also open a pull request, but it may not be reviewed.
