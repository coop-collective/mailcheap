# GitHub Actions deployments

Mailcheap can run its checks on GitHub Actions and optionally deploy production
or Cloudflare Preview Workers. Checks receive no Cloudflare or application
secrets. Deployments use separate GitHub `production` and `preview`
environments. Preview jobs run repository code with the preview environment's
secrets for same-repository pull requests, so enable them only when those
contributors are trusted. Fork pull requests never receive deployment secrets;
the setup helper supports both public and private repositories.

## Prepare Cloudflare resources

Set up production with `pnpm setup`. For a custom domain, first onboard its DNS
zone to Cloudflare, then configure `CUSTOM_DOMAIN` plus its HTTPS `APP_URL` in
the private `.env`. Deployment attaches the hostname to the Worker. You can
also use the `workers.dev` URL discovered by setup without a custom domain.
The CI deploy applies pending D1 migrations before publishing.

For previews, create a separate resource set in a private `.env.preview`:

```sh
pnpm run setup -- --environment preview --env-file .env.preview --name mailcheap-preview
```

The preview Worker, D1 database, optional R2 bucket and queues must all have
names containing `preview`. Preview releases share these isolated test
resources. They do not run Queue consumers or Cron, and both SES and
transactional email sending remain disabled. Treat preview data as shared test
data; do not copy production records into it.

Create a Cloudflare API token restricted to the account hosting these
resources. The CI commands in this repository need account settings read access
for Wrangler identity checks, Workers Scripts Edit (or Workers Editor) to
publish an existing Worker and manage its Previews, and D1 Edit to apply remote
migrations. Creating the production Worker or preview parent for the first time
requires Workers Admin at the Workers product scope. Add Workers Routes Write
for the zone only if deployment will add
or change the Worker custom domain or route. Resource provisioning also needs
the corresponding D1, R2 and Queues edit permissions. Production deployments
also manage Queue consumers, so include Queues Edit. Routine R2 binding deploys
do not need object read/write access. Avoid unrelated permissions.
See
[Cloudflare Workers authorization](https://developers.cloudflare.com/workers/authorization/workers/)
and [Cloudflare's GitHub Actions guide](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
GitHub requires Pro, Team or Enterprise to use environments and their secrets
in private repositories; see the [environment API prerequisites](https://docs.github.com/en/rest/deployments/environments).

## Configure GitHub

Run the helper from a trusted local checkout with `gh` authenticated to the
target repository. It validates the selected environment files before making
GitHub changes, uploads only whitelisted runtime settings, and sends secret
values to `gh` over stdin rather than command arguments. The Cloudflare API
token is stored separately from `MAILCHEAP_ENV`. Put `CLOUDFLARE_API_TOKEN` in
each private environment file or export it in your shell before running the
helper. Separate tokens scoped to production and preview resources are
recommended. Do not copy a Wrangler OAuth session token into GitHub.

```sh
pnpm run setup:ci -- --repo coop-collective/mailcheap-private \
  --production-file .env --preview-file .env.preview
```

Replace the repository name with your fork. Add `--dry-run` to validate the
files without changing GitHub. The helper requires repository administration
access and an authenticated [GitHub CLI](https://cli.github.com/).

| GitHub environment secret | Contents |
| --- | --- |
| `MAILCHEAP_ENV` | Filtered dotenv text containing the environment marker, account/resource IDs, public settings, and admin/session secrets. Production also includes SES credentials if configured. |
| `CLOUDFLARE_API_TOKEN` | Deployment API token, stored separately and never bound into the app. |

Both environments use these same secret names with different values. The
helper supplies them; no additional GitHub personal access token is needed by
the workflows. Private files, generated configs and build outputs stay ignored.

The helper creates the `production` and `preview` GitHub Environments when they
do not already exist, preserving any existing environment protections. It uploads
`MAILCHEAP_ENV` and `CLOUDFLARE_API_TOKEN` to each selected environment, and
then enables the corresponding repository variables. Production requires
`DEPLOYMENT_ENVIRONMENT=production`; preview requires the preview marker,
preview-only resource names, valid admin/session credentials, and both sending
modes set to `false`. Existing environment protection settings are preserved.
When both files are supplied, the preview Worker, database, queues, admin
password and session secret must be distinct from production.
New production environments restrict deployments to the `main` branch. Existing
environments keep their protections; ensure production permits `main`, and
preview permits pull request refs (`refs/pull/*/merge`) and `main` for cleanup.

The preview CLI can validate the configuration without deploying, or remove a
single named Preview while keeping the shared test resources:

```sh
pnpm run preview:deploy -- --name pr-123 --dry-run --env-file .env.preview
pnpm run preview:deploy -- --delete --name pr-123 --env-file .env.preview
```

For production only, omit `--preview-file`. To stop automatic deployments while
keeping checks enabled, run:

```sh
pnpm run setup:ci -- --repo coop-collective/mailcheap-private --disable
```

To stop all workflow checks and deployments, use `--disable-ci`. Set
`MAILCHEAP_CI_ENABLED` back to `true` as a repository variable to re-enable
checks. The workflow reads these repository variables:

| Variable | Behavior |
| --- | --- |
| `MAILCHEAP_CI_ENABLED` | Checks and deployments run unless set to the exact string `false`. |
| `MAILCHEAP_DEPLOY_PRODUCTION` | Production deploys only when set to the exact string `true`. |
| `MAILCHEAP_DEPLOY_PREVIEWS` | Same-repository pull request previews and cleanup run only when set to `true`. |

Set these under **Settings → Secrets and variables → Actions → Variables**,
not environment variables. To re-enable deployment, rerun `setup:ci` with the
desired files or set its opt-in to `true` once the secrets are present. Omitting
an environment from a helper run leaves its deployment disabled. Disabling
deployment keeps existing Workers and previews running; remove unwanted
previews manually before disabling cleanup. Disabling CI does not cancel jobs
already running or change branch protection rules that require the `check` job.

Production deploys run after successful checks on `main` pushes or manual runs
on `main`. Preview deploys run only for ready, same-repository pull requests;
fork pull requests never receive deployment secrets. Each deployment checks
that its commit is still current immediately before acting. Preview creation
and cleanup share a concurrency group because they apply migrations to the
same preview database. Closing a same-repository pull request deletes its
Cloudflare Preview while leaving the shared preview resources in place.

The production GitHub Environment URL is taken from `APP_URL`. The preview
environment URL is set from the Preview URL returned by Wrangler. Neither job
posts comments to pull requests.
