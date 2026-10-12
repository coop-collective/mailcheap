#!/usr/bin/env bash
# Runs only from the private controller, never a pull_request event.
set -euo pipefail
umask 077

: "${SYNC_BASE:?Missing fork commit}"
: "${SYNC_FROM:?Missing upstream cursor}"
: "${SYNC_TARGET:?Missing upstream target}"
: "${RUNNER_TEMP:?Missing runner temporary directory}"
: "${GITHUB_OUTPUT:?Missing Actions output file}"
for sha in "$SYNC_BASE" "$SYNC_FROM" "$SYNC_TARGET"; do
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid commit SHA' >&2; exit 1; }
done
[[ "$(git rev-parse HEAD)" == "$SYNC_BASE" ]]
[[ -z "$(git status --porcelain)" ]]
auth_dir=/var/lib/mailcheap-codex
codex_image=${CODEX_IMAGE:-mailcheap-codex:0.162.1}
test -s "$auth_dir/auth.json" || { echo 'Runner needs ChatGPT device login; see docs/upstream-sync.md.' >&2; exit 1; }
docker image inspect "$codex_image" > /dev/null

task_dir=$(mktemp -d "$RUNNER_TEMP/mailcheap-sync.XXXXXX")
trusted_scripts=$PWD/scripts
workspace=$task_dir/workspace
context=$task_dir/context
result=$task_dir/result
agent_result=$task_dir/agent-result
container_name=mailcheap-codex-${task_dir##*.}
keep_result=false
cleanup() {
  docker rm -f "$container_name" > /dev/null 2>&1 || true
  rm -rf -- "$workspace" "$context" "$agent_result"
  if [[ "$keep_result" != true ]]; then rm -rf -- "$task_dir"; fi
}
trap cleanup EXIT INT TERM
mkdir -p "$context" "$agent_result"

# Clone only trusted fork main. Upstream stays text, never the checked-out tree.
git -c core.hooksPath=/dev/null clone --quiet --no-local --no-hardlinks "$PWD" "$workspace"
git -C "$workspace" remote remove origin
git -C "$workspace" -c core.hooksPath=/dev/null fetch --no-tags https://github.com/marclou/mailcheap.git main
git -C "$workspace" merge-base --is-ancestor "$SYNC_FROM" "$SYNC_TARGET"
git -C "$workspace" merge-base --is-ancestor "$SYNC_TARGET" FETCH_HEAD
git -C "$workspace" diff --no-ext-diff --no-textconv --binary "$SYNC_FROM" "$SYNC_TARGET" > "$context/upstream.patch"
[[ $(wc -c < "$context/upstream.patch") -le 524288 ]]
git -C "$workspace" log --format='%H %s' "$SYNC_FROM..$SYNC_TARGET" > "$context/commits.txt"
cp .github/upstream-controller/prompt.md "$context/prompt.md"
cp .github/upstream-controller/result.schema.json "$context/result.schema.json"

# Install only the trusted base's dependencies with pinned pnpm, without lifecycle scripts and
# without any Codex/GitHub/cloud credentials. Nothing runs on the host.
docker run --rm --pull never --user "$(id -u):$(id -g)" \
  --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 \
  --memory 4g --cpus 2 --read-only --tmpfs /tmp:rw,nosuid,nodev,size=1g \
  --mount "type=bind,src=$workspace,dst=/workspace" \
  --env HOME=/tmp/pnpm-home \
  --workdir /workspace --entrypoint pnpm "$codex_image" \
  install --frozen-lockfile --ignore-scripts --store-dir /tmp/pnpm-store

model_args=()
if [[ -n "${CODEX_MODEL:-}" ]]; then model_args=(--model "$CODEX_MODEL"); fi

# Agent output is private to the private controller job. Never upload auth,
# session state, raw Codex logs, or the runner filesystem as artifacts.
timeout --signal=TERM --kill-after=30s 20m \
  docker run --rm --pull never --name "$container_name" \
    --user "$(id -u):$(id -g)" --cap-drop ALL --security-opt no-new-privileges \
    --security-opt seccomp=unconfined \
    --pids-limit 256 --memory 4g --cpus 2 --read-only \
    --tmpfs /tmp:rw,nosuid,nodev,size=1g \
    --mount "type=bind,src=$workspace,dst=/workspace" \
    --mount "type=bind,src=$workspace/.git,dst=/workspace/.git,readonly" \
    --mount "type=bind,src=$workspace/.github,dst=/workspace/.github,readonly" \
    --mount "type=bind,src=$workspace/scripts,dst=/workspace/scripts,readonly" \
    --mount "type=bind,src=$workspace/AGENTS.md,dst=/workspace/AGENTS.md,readonly" \
    --mount "type=bind,src=$context,dst=/context,readonly" \
    --mount "type=bind,src=$agent_result,dst=/result" \
    --mount "type=bind,src=$auth_dir,dst=/codex" \
    --env CODEX_HOME=/codex --workdir /workspace \
    "$codex_image" exec --ignore-user-config --ignore-rules --ephemeral \
    --sandbox workspace-write -c 'approval_policy="never"' \
    -c 'forced_login_method="chatgpt"' -c 'cli_auth_credentials_store="file"' \
    -c 'sandbox_workspace_write.network_access=false' -c 'web_search="disabled"' \
    -c 'model_reasoning_effort="low"' "${model_args[@]}" \
    --add-dir /result --output-schema /context/result.schema.json \
    --output-last-message /result/summary.json \
    'Read /context/prompt.md and carry out that task. Source changes are in /context/upstream.patch.'

mkdir "$result"
node -e '
  const fs = require("node:fs");
  const stat = fs.lstatSync(process.argv[1]);
  if (!stat.isFile() || stat.size > 65536) throw Error("Invalid Codex result file");
  const result = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (result.complete !== true || !Array.isArray(result.manual) || result.manual.length ||
      typeof result.summary !== "string" ||
      ![result.ported, result.skipped].every(a => Array.isArray(a) && a.every(v => typeof v === "string")))
    throw Error("Codex reported incomplete work. Review private job logs; cursor was not advanced.");
  fs.writeFileSync(process.argv[2], JSON.stringify({ complete: true, summary: result.summary,
    ported: result.ported, skipped: result.skipped, manual: [] }, null, 2) + "\n", { flag: "wx" });
' "$agent_result/summary.json" "$result/summary.json"

# .git is mounted read-only during the agent run, then trusted host code stages
# the candidate and enforces an allowlist before exporting a patch.
git -C "$workspace" -c core.hooksPath=/dev/null -c core.fsmonitor=false add --all
(cd "$workspace" && node "$trusted_scripts/upstream-paths.mjs" "$SYNC_BASE")
git -C "$workspace" diff --no-ext-diff --no-textconv --binary "$SYNC_BASE" > "$result/candidate.patch"
keep_result=true
echo "artifact=$result" >> "$GITHUB_OUTPUT"
