#!/usr/bin/env bash
# Read-only polling. Runs on GitHub-hosted machines, never the Codex runner.
set -euo pipefail

: "${GITHUB_OUTPUT:?Run from GitHub Actions, or supply an output file}"
: "${GH_TOKEN:?A read-only GitHub token is required}"
fork_repo=coop-collective/mailcheap
sync_branch=automation/upstream-cloudflare
cursor=$(node -e '
  const fs = require("node:fs");
  const value = JSON.parse(fs.readFileSync(".github/upstream-sync.json", "utf8"));
  if (value.repository !== "marclou/mailcheap" || value.branch !== "main" ||
      !/^[a-f0-9]{40}$/.test(value.lastApplied)) throw Error("Invalid upstream cursor");
  process.stdout.write(value.lastApplied);
')

# Never replace a PR being reviewed, even when upstream advances again.
open_count=$(gh pr list --repo "$fork_repo" --head "$sync_branch" --state open --json number --jq length)
if [[ "$open_count" != 0 ]]; then
  echo 'An upstream adaptation PR is already open; preserving its review and edits.'
  echo 'needed=false' >> "$GITHUB_OUTPUT"
  exit 0
fi

git -c core.hooksPath=/dev/null fetch --no-tags https://github.com/marclou/mailcheap.git main
upstream_head=$(git rev-parse FETCH_HEAD)
git merge-base --is-ancestor "$cursor" "$upstream_head" || {
  echo 'Upstream history changed or the cursor is unavailable. Reconcile the cursor manually.' >&2
  exit 1
}
if [[ "$cursor" == "$upstream_head" ]]; then
  echo 'Upstream is current; no Codex usage needed.'
  echo 'needed=false' >> "$GITHUB_OUTPUT"
  exit 0
fi

# Bound each adaptation to the first 20 new first-parent commits.
commits=$(git rev-list --reverse --first-parent "$cursor..$upstream_head")
target=$(printf '%s\n' "$commits" | sed -n '1,20p' | tail -n 1)
[[ "$target" =~ ^[a-f0-9]{40}$ ]]

# A closed, unmerged proposal is a human decision, not a reason to spend again.
# A manual retry allows a maintainer to reconsider it.
if [[ "${RETRY_CLOSED:-false}" != true ]]; then
  closed_count=$(gh pr list --repo "$fork_repo" --head "$sync_branch" --state closed --json title --jq \
    "[.[] | select(.title == \"Adapt upstream ${target:0:12} for Cloudflare\")] | length")
  if [[ "$closed_count" != 0 ]]; then
    echo 'This upstream batch already has a closed proposal; use manual retry to reconsider.'
    echo 'needed=false' >> "$GITHUB_OUTPUT"
    exit 0
  fi
fi

patch_bytes=$(git diff --no-ext-diff --no-textconv --binary "$cursor" "$target" | wc -c)
if (( patch_bytes > 524288 )); then
  echo 'Upstream batch exceeds 512 KiB. Split/review it manually before advancing the cursor.' >&2
  exit 1
fi
{
  echo 'needed=true'
  echo "base=$(git rev-parse HEAD)"
  echo "from=$cursor"
  echo "target=$target"
} >> "$GITHUB_OUTPUT"
echo "Upstream batch: $cursor..$target ($patch_bytes bytes)."
