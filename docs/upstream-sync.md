# Adapting upstream with a subscription-authenticated Codex runner

The parent is [`marclou/mailcheap`](https://github.com/marclou/mailcheap), branch
`main`. This fork records its last accepted upstream commit in
`.github/upstream-sync.json`. The initial cursor is the commit this fork started
from, `67d13b028a6ecae9ec56d49c4b2db58019217eba`.

The repository uses pnpm `11.28.8` and the checked-in `pnpm-lock.yaml`; CI installs
that exact pnpm version and uses frozen-lockfile installs. The public fork runs
ordinary checks on GitHub-hosted runners. The subscription
automation belongs in a **separate private controller repository**. The official
OpenAI CI authentication guide says, “Do not use this workflow for public or
open-source repositories.” Keeping the credentialed runner and workflow private
is a deliberate design choice here; the guide does not specifically endorse this
public-fork/private-controller arrangement. Do not register the credentialed
runner with this public repository. [OpenAI CI authentication guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth)

The implementation is prepared but inactive: it does not provision a VM, create
a controller repository, sign in, register a runner, or publish any changes.

## How it works

1. A weekly scheduled job, or a manual run on the controller's default branch,
   checks the fork's trusted `main` on a GitHub-hosted runner. It stops when
   upstream has not advanced or an adaptation PR is already open.
2. It selects at most 20 first-parent commits and rejects patches over 512 KiB.
   One isolated Codex invocation adapts that batch in a fresh checkout of the
   fork. Upstream is supplied as a diff; it is never checked out on the runner.
3. A separate disposable GitHub-hosted job installs the candidate dependencies
   with pnpm and runs the architecture guard, tests, lint and production build. It has no
   Codex, deployment, database or fork-write credentials.
4. A fresh publishing job rechecks protected paths and architecture, then opens
   a draft PR on `automation/upstream-cloudflare`. Only this job receives a
   narrowly scoped fork-write token. It never runs candidate code.
5. A maintainer reviews both ported and skipped changes and merges the PR. Only
   merging advances the cursor. There is no automatic merge or deployment.

Changes to automation, scripts, agent instructions, symlinks and submodules are
blocked. A batch requiring such changes needs a manual adaptation. The app keeps
vinext/Workers, D1, R2 and Queues/Cron, with Amazon SES for campaigns and
subscriber lifecycle emails and a signature-verified SNS event webhook. A separate
transactional API uses the native Cloudflare Email Service binding. The prompt
preserves those email flows and the Workers-safe signed HTTPS transport while
forbidding the AWS SDK, MongoDB, Upstash and Vercel Blob dependencies. SES/SNS are
intentional exceptions to the Cloudflare infrastructure migration.

## Prepare the private controller

Create a private repository such as `coop-collective/mailcheap-automation` with
access limited to trusted maintainers. Copy
`.github/upstream-controller/workflow.yml` from this fork to
`.github/workflows/upstream-sync.yml` in that repository and commit it to its
default branch. The workflow intentionally refuses to run in a public repository
or from any other branch. No workflow accepts pull requests, comments or arbitrary
repository/ref inputs as triggers.

Configure these settings in the **private controller**:

| Setting | Value |
| --- | --- |
| Repository variable `ENABLE_UPSTREAM_SYNC` | `true`, once setup is complete; `false` pauses future runs |
| Repository variable `CODEX_MODEL` | Optional model available to the subscribed account; omit to use the installed CLI default |
| Repository variable `CODEX_IMAGE` | Optional prebuilt local image name; default `mailcheap-codex:0.162.1` |
| Actions secret `MAILCHEAP_SYNC_TOKEN` | Fine-grained GitHub token limited to `coop-collective/mailcheap`, with Contents and Pull requests read/write |
| Runner labels | `self-hosted`, `linux`, `x64`, `mailcheap-codex` |

The fork-write token does not need Actions, administration, secrets or workflow
permissions. A short-lived GitHub App installation token with the same repository
permissions can replace it by adding token creation only in the publish job.
Protect the fork's `main` branch, require the `Cloudflare checks / check` job, and
allow the bot to push only its adaptation branch. Keep the public fork's checks
on GitHub-hosted runners. Using a separate token also allows the resulting PR to
trigger its normal public CI.

## Prepare a dedicated Linux runner

Use an x86-64 Linux VM with approximately 2 vCPUs, 8 GiB RAM and 25 GiB free disk.
This is an initial sizing estimate, not a service requirement. It runs the Codex
CLI; model inference remains hosted by OpenAI. No inbound Codex API service,
remote-control server or API-billed Agents API is needed.

Install Docker, Git, Node 24, GitHub CLI and GNU coreutils. Create a dedicated
non-root runner user. Register a GitHub Actions runner with **only the private
controller repository**, give it the `mailcheap-codex` label, and install the
runner service as that user using the commands GitHub provides under Settings →
Actions → Runners → New self-hosted runner. If using an organization runner group,
restrict it to the controller repository. The user needs permission to run
Docker; treat that as administrative access to this dedicated VM. Store no
production secrets, personal SSH keys or unrelated repositories there.

On the VM, as that runner user, clone the fork's trusted main and build the image
once. The workflow never installs or upgrades Codex dynamically:

```sh
git clone https://github.com/coop-collective/mailcheap.git
cd mailcheap
docker build -f .github/upstream-controller/Dockerfile \
  -t mailcheap-codex:0.162.1 .github/upstream-controller
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /var/lib/mailcheap-codex
```

The Dockerfile pins the Codex package to the locally verified CLI version
`0.162.1` and includes pnpm `11.13.0`. Its Node base uses a maintenance tag; for reproducible infrastructure,
review updates and pin the base image digest in your controller's managed copy.
The workflow uses the already-built local image with `--pull never`.

Sign in interactively from a trusted terminal connected to that VM. This is the
one human authentication step; do not run it in an Actions log:

```sh
docker run --rm -it --user "$(id -u):$(id -g)" \
  --mount type=bind,src=/var/lib/mailcheap-codex,dst=/codex \
  --env CODEX_HOME=/codex mailcheap-codex:0.162.1 \
  -c 'cli_auth_credentials_store="file"' \
  -c 'forced_login_method="chatgpt"' login --device-auth
chmod 600 /var/lib/mailcheap-codex/auth.json
```

Enable device-code login in the account's ChatGPT security settings or workspace
permissions if needed. Open the displayed link yourself and complete sign-in.
ChatGPT login uses subscription access; availability and usage limits still
depend on the account. The workflow enforces ChatGPT login and supplies no API
key. [OpenAI authentication documentation](https://learn.chatgpt.com/docs/auth)

Use this dedicated login for one serialized job stream. Codex refreshes the
persistent auth file itself, so do not replace it from an old seed on every run
or share it among concurrent machines. Protect it as a password. Reauthenticate
if refresh fails. No auth files or raw session logs are uploaded as artifacts.
[OpenAI CI authentication guidance](https://learn.chatgpt.com/docs/auth/ci-cd-auth)

## Verify and enable

Before enabling the schedule, verify the VM supports Codex's Linux sandbox using
a scratch checkout and the same Docker restrictions as `upstream-adapt.sh`.
The script uses the documented `codex exec --sandbox workspace-write`, explicit
no-approval settings, disabled shell networking, structured output and an
ephemeral session. It retains the sandbox; a VM/container that cannot run it must
be fixed rather than bypassing the restriction. [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)

The Codex container explicitly removes Docker's default seccomp filter because
it blocks the unprivileged namespaces used by Codex's Bubblewrap sandbox. Linux
user namespaces must be available on the VM. The container remains non-root with
all capabilities dropped, no-new-privileges and a read-only root filesystem;
Codex still applies its own filesystem and network sandbox. The trusted base
dependencies are installed in a separate container with pinned pnpm, a frozen
lockfile, lifecycle scripts disabled, Docker's default seccomp filter and no
credentials. Candidate validation uses the same frozen pnpm lockfile on a
disposable GitHub-hosted runner.

For a credential-free image/sandbox smoke test, run:

```sh
docker run --rm --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m \
  --tmpfs /home/node/.codex:rw,nosuid,nodev,size=64m,uid=1000,gid=1000 \
  --cap-drop ALL --security-opt no-new-privileges --security-opt seccomp=unconfined \
  --entrypoint sh mailcheap-codex:0.162.1 -c \
  'codex --version && codex sandbox -- sh -c "printf sandbox-ok"'
```

Then set `ENABLE_UPSTREAM_SYNC=true` and manually dispatch the private workflow.
If upstream has no new commit it should finish after detection, with no Codex
usage. On the next actual upstream update, review the first draft carefully,
including the `ported` and `skipped` explanations and the separate validation
job. The current implementation has static checks, local fixture verification and
a successful credential-free Docker image/sandbox smoke test on Linux ARM64;
a real subscription-authenticated end-to-end run still requires this setup.

## Cost and recovery

The default schedule runs Mondays at 03:23 UTC. Unchanged upstream and open PRs
consume no Codex session. Each batch gets one low-reasoning invocation, at most
20 minutes, with no subagents or automatic repair loop. This bounds time rather
than guaranteeing a token ceiling. The VM and private GitHub-hosted job usage
may have costs separate from the subscription. A model override is optional;
choose one supported by the signed-in account instead of assuming a model name
or unlimited subscription capacity.

Failed/incomplete adaptations, unavailable quota, failed checks, changed upstream
history and oversized patches stop without updating the cursor or publishing.
Failures are visible in the private Actions run; there are no automatic retries
within a run, but a later schedule can try the batch again. Pause the variable
while investigating persistent failures. If the public main branch changes
during a run, publishing aborts and the next run starts from its new commit.

While a PR is open, make any review fixes on that branch; the automation will
leave it alone. Closing an unmerged PR suppresses proposals for that same target
commit. Use the manual `retry_closed` checkbox to reconsider it. If a push
succeeds but PR creation fails, a subsequent run can replace that orphaned bot
branch using a force-with-lease check. No human branch or default branch is
force-pushed.

An accepted upstream change may require edits to protected automation or a new
service choice. Port it manually, validate it, and include the reviewed upstream
cursor update in that PR. Do not advance the cursor merely to silence a failure.
Review controller workflow/image updates separately, and stop its runner service
or set `ENABLE_UPSTREAM_SYNC=false` to disable future automation.

Only trusted maintainers should be able to modify the controller or the fork's
default branch. Container isolation and the Codex shell sandbox reduce exposure,
but the Codex process still holds its account credential; private infrastructure
and review are part of the trust boundary. Candidate tests run elsewhere to avoid
handing that credential to application or dependency code.
