import { execFileSync } from 'node:child_process';

// Invoke the trusted copy outside the candidate tree. Do not execute a candidate
// version of this guard before it has passed review.
const base = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('Expected a base commit SHA');
const changed = execFileSync('git', ['diff', '--no-ext-diff', '--name-only', '-z', base], { encoding: 'utf8' })
  .split('\0').filter(Boolean);
const allowedRoots = /^(app|assets|components|docs|lib|migrations|models|public|tests|worker|workers)\//;
// pnpm-lock.yaml is generated dependency data and can be reviewed with an
// upstream batch. pnpm-workspace.yaml controls package/build policy and stays
// protected so changes to it require a manual adaptation.
const allowedFiles = /^(package\.json|pnpm-lock\.yaml|(?:next|vite|eslint|postcss)\.config\.[cm]?[jt]s|wrangler\.jsonc?|worker\.[cm]?[jt]s|README\.md|\.env\.example|proxy\.[jt]s|instrumentation\.[jt]s|jsconfig\.json)$/;
for (const path of changed) {
  if ((!allowedRoots.test(path) && !allowedFiles.test(path)) ||
      /(^|\/)(?:AGENTS\.md|\.codex|\.agents|\.github|\.git)(\/|$)/.test(path)) {
    throw new Error(`Upstream adaptation changed protected path: ${path}`);
  }
}
const entries = execFileSync('git', ['ls-files', '--stage', '-z'], { encoding: 'utf8' }).split('\0');
for (const entry of entries) {
  const tab = entry.indexOf('\t');
  if (tab < 0 || !changed.includes(entry.slice(tab + 1))) continue;
  if (entry.startsWith('120000 ') || entry.startsWith('160000 ')) {
    throw new Error(`Upstream adaptation introduced a symlink or submodule: ${entry.slice(tab + 1)}`);
  }
}
console.log(`Upstream path checks passed (${changed.length} changed files).`);
