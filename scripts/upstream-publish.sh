#!/usr/bin/env bash
# Execute the original trusted script copied outside the candidate checkout.
# This job has a fork-write token and must never run candidate code or npm.
set -euo pipefail
: "${GH_TOKEN:?Missing narrowly scoped fork write token}"
: "${SYNC_BASE:?Missing fork base}"
: "${SYNC_TARGET:?Missing upstream target}"
: "${SYNC_FROM:?Missing upstream cursor}"
: "${SYNC_ARTIFACT:?Missing artifact directory}"
: "${SYNC_TRUSTED_SCRIPTS:?Missing trusted script directory}"
for sha in "$SYNC_BASE" "$SYNC_FROM" "$SYNC_TARGET"; do
  [[ "$sha" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid SHA' >&2; exit 1; }
done
fork_repo=coop-collective/mailcheap
branch=automation/upstream-cloudflare
base_now=$(gh api "repos/$fork_repo/git/ref/heads/main" --jq .object.sha)
[[ "$base_now" == "$SYNC_BASE" ]] || {
  echo 'Fork main changed during adaptation. No PR published; rerun on its new base.' >&2
  exit 1
}
open_count=$(gh pr list --repo "$fork_repo" --head "$branch" --state open --json number --jq length)
[[ "$open_count" == 0 ]] || { echo 'A proposal was opened meanwhile; refusing to replace it.' >&2; exit 1; }
git -c core.hooksPath=/dev/null switch -c "$branch"
if [[ -s "$SYNC_ARTIFACT/candidate.patch" ]]; then
  git -c core.hooksPath=/dev/null apply --index "$SYNC_ARTIFACT/candidate.patch"
fi
node "$SYNC_TRUSTED_SCRIPTS/upstream-paths.mjs" "$SYNC_BASE"
node "$SYNC_TRUSTED_SCRIPTS/check-cloudflare.mjs"

# This is the only automatic write to the cursor. Merging the reviewed PR makes
# the next batch eligible; a failed job or closed PR leaves main's cursor intact.
node --input-type=module -e '
  import fs from "node:fs";
  const cursor = { repository: "marclou/mailcheap", branch: "main", lastApplied: process.env.SYNC_TARGET };
  fs.writeFileSync(".github/upstream-sync.json", JSON.stringify(cursor, null, 2) + "\n");
'
git add .github/upstream-sync.json
git -c user.name='mailcheap-sync[bot]' -c user.email='mailcheap-sync@users.noreply.github.com' \
  -c core.hooksPath=/dev/null commit -m "Adapt upstream ${SYNC_TARGET:0:12} for Cloudflare"

body=$(mktemp)
askpass=$(mktemp)
cleanup() { rm -f -- "$body" "$askpass"; }
trap cleanup EXIT
cat > "$askpass" <<'ASKPASS'
#!/bin/sh
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *) printf '%s\n' "$GH_TOKEN" ;;
esac
ASKPASS
chmod 700 "$askpass"
# Require the current remote branch value so a concurrent human push wins.
old_ref=$(git ls-remote origin "refs/heads/$branch" | cut -f 1)
GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 \
  git -c core.hooksPath=/dev/null push \
    "--force-with-lease=refs/heads/$branch:$old_ref" origin "HEAD:refs/heads/$branch"

{
  printf 'Ports upstream changes while preserving the Cloudflare Workers, vinext, D1, R2 and email architecture.\n\n'
  printf 'Upstream: https://github.com/marclou/mailcheap/compare/%s...%s\n\n' "$SYNC_FROM" "$SYNC_TARGET"
  printf 'Validation passed in a separate GitHub-hosted job: Cloudflare architecture guard, tests, lint and production build.\n\n'
  printf 'Review and merge this draft to accept the upstream cursor. Skipped changes also need review.\n\n'
  node -e '
    const fs = require("node:fs");
    const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    // Avoid mentions or active HTML copied from untrusted upstream content.
    const clean = s => String(s).replace(/@/g, "＠").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    console.log(clean(value.summary));
    for (const key of ["ported", "skipped"]) {
      console.log("\n" + key + ":");
      for (const line of value[key] || []) console.log("- " + clean(line));
    }
  ' "$SYNC_ARTIFACT/summary.json"
} > "$body"
gh pr create --repo "$fork_repo" --base main --head "$branch" --draft \
  --title "Adapt upstream ${SYNC_TARGET:0:12} for Cloudflare" --body-file "$body"
