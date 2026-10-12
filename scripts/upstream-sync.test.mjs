import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(root, name, value) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

test('polling skips unchanged/open/closed batches and bounds new work', t => {
  const dir = fixture(t);
  const upstream = path.join(dir, 'upstream');
  const fork = path.join(dir, 'fork');
  fs.mkdirSync(upstream);
  git(upstream, 'init', '-b', 'main');
  write(upstream, 'source.txt', 'initial\n');
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-m', 'Initial');
  const cursor = git(upstream, 'rev-parse', 'HEAD');
  git(dir, 'clone', upstream, fork);
  write(fork, '.github/upstream-sync.json', JSON.stringify({ repository: 'marclou/mailcheap', branch: 'main', lastApplied: cursor }));
  git(fork, 'add', '.');
  git(fork, 'commit', '-m', 'Fork cursor');
  write(dir, 'bin/gh', '#!/bin/sh\ncase "$*" in\n *"--state open"*) echo "${MOCK_OPEN_COUNT:-0}" ;;\n *"--state closed"*) echo "${MOCK_CLOSED_COUNT:-0}" ;;\n *) exit 90 ;;\nesac\n');
  fs.chmodSync(path.join(dir, 'bin/gh'), 0o755);
  const output = path.join(dir, 'output');
  function detect(extra = {}) {
    fs.writeFileSync(output, '');
    const run = spawnSync('bash', [path.join(scripts, 'upstream-detect.sh')], {
      cwd: fork, encoding: 'utf8', env: {
        ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`,
        GH_TOKEN: 'fixture-only', GITHUB_OUTPUT: output,
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${upstream}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/marclou/mailcheap.git', ...extra,
      },
    });
    return { ...run, outputs: Object.fromEntries(fs.readFileSync(output, 'utf8').trim().split('\n').filter(Boolean).map(line => line.split('='))) };
  }
  const current = detect();
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.outputs.needed, 'false');
  const commits = [];
  for (let i = 0; i < 22; i++) {
    write(upstream, 'source.txt', `Update ${i}\n`);
    git(upstream, 'add', '.');
    git(upstream, 'commit', '-m', `Update ${i}`);
    commits.push(git(upstream, 'rev-parse', 'HEAD'));
  }
  const changed = detect();
  assert.equal(changed.status, 0, changed.stderr);
  assert.equal(changed.outputs.needed, 'true');
  assert.equal(changed.outputs.target, commits[19]);
  assert.equal(changed.outputs.from, cursor);
  assert.equal(detect({ MOCK_OPEN_COUNT: '1' }).outputs.needed, 'false');
  assert.equal(detect({ MOCK_CLOSED_COUNT: '1' }).outputs.needed, 'false');
  assert.equal(detect({ MOCK_CLOSED_COUNT: '1', RETRY_CLOSED: 'true' }).outputs.needed, 'true');
  // A rewritten history cannot silently skip unseen upstream changes.
  write(fork, '.github/upstream-sync.json', JSON.stringify({ repository: 'marclou/mailcheap', branch: 'main', lastApplied: 'f'.repeat(40) }));
  assert.notEqual(detect().status, 0);
});

test('candidate guard rejects automation edits and symlinks', t => {
  const dir = fixture(t);
  git(dir, 'init', '-b', 'main');
  write(dir, 'lib/feature.js', 'export const value = 1;\n');
  write(dir, '.github/workflows/ci.yml', 'trusted\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'Initial');
  const base = git(dir, 'rev-parse', 'HEAD');
  const guard = () => spawnSync(process.execPath, [path.join(scripts, 'upstream-paths.mjs'), base], { cwd: dir, encoding: 'utf8' });
  write(dir, 'lib/feature.js', 'export const value = 2;\n');
  git(dir, 'add', '.');
  assert.equal(guard().status, 0);
  write(dir, '.github/workflows/ci.yml', 'untrusted\n');
  git(dir, 'add', '.');
  assert.notEqual(guard().status, 0);
  git(dir, 'reset', '--hard', base);
  fs.symlinkSync('/etc/passwd', path.join(dir, 'lib/link.js'));
  git(dir, 'add', '.');
  assert.notEqual(guard().status, 0);
});

test('architecture guard rejects forbidden direct and locked providers', t => {
  const dir = fixture(t);
  const pkg = { dependencies: { vinext: '1.1.0' }, scripts: { build: 'vite build' } };
  write(dir, 'package.json', JSON.stringify(pkg));
  write(dir, 'package-lock.json', JSON.stringify({ packages: {} }));
  write(dir, 'wrangler.jsonc', '{ "d1_databases": [], "r2_buckets": [], "queues": {} }');
  const guard = () => spawnSync(process.execPath, [path.join(scripts, 'check-cloudflare.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.equal(guard().status, 0);
  write(dir, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/@upstash/redis': {} } }));
  assert.notEqual(guard().status, 0);
  write(dir, 'package-lock.json', JSON.stringify({ packages: {} }));
  pkg.dependencies.mongoose = '9.0.0';
  write(dir, 'package.json', JSON.stringify(pkg));
  assert.notEqual(guard().status, 0);
});

test('publishing advances only the draft branch and safely reuses an orphaned branch', t => {
  const dir = fixture(t);
  const seed = path.join(dir, 'seed');
  const remote = path.join(dir, 'remote.git');
  fs.mkdirSync(seed);
  git(seed, 'init', '-b', 'main');
  write(seed, 'package.json', JSON.stringify({ dependencies: { vinext: '1.1.0' }, scripts: { build: 'vite build' } }));
  write(seed, 'package-lock.json', JSON.stringify({ packages: {} }));
  write(seed, 'wrangler.jsonc', '{ "d1_databases": [], "r2_buckets": [], "queues": {} }');
  write(seed, 'lib/feature.js', 'export const value = 1;\n');
  write(seed, '.github/upstream-sync.json', JSON.stringify({ repository: 'marclou/mailcheap', branch: 'main', lastApplied: 'a'.repeat(40) }));
  git(seed, 'add', '.');
  git(seed, 'commit', '-m', 'Initial');
  const base = git(seed, 'rev-parse', 'HEAD');
  git(dir, 'init', '--bare', '-b', 'main', remote);
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', 'origin', 'main');
  write(seed, 'lib/feature.js', 'export const value = 2;\n');
  write(dir, 'artifact/candidate.patch', git(seed, 'diff', '--binary', base) + '\n');
  write(dir, 'artifact/summary.json', JSON.stringify({ complete: true, summary: 'Adapted', ported: ['Feature'], skipped: [], manual: [] }));
  write(dir, 'bin/gh', '#!/bin/sh\ncase "$1 $2" in\n "api "*) echo "$FIXTURE_BASE" ;;\n "pr list") echo 0 ;;\n "pr create") printf "%s\\n" "$*" > "$FIXTURE_PR_ARGS" ;;\n *) exit 90 ;;\nesac\n');
  fs.chmodSync(path.join(dir, 'bin/gh'), 0o755);
  const env = {
    ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, GH_TOKEN: 'fixture-only',
    FIXTURE_BASE: base, FIXTURE_PR_ARGS: path.join(dir, 'pr-args'), SYNC_BASE: base,
    SYNC_FROM: 'a'.repeat(40), SYNC_TARGET: 'b'.repeat(40),
    SYNC_ARTIFACT: path.join(dir, 'artifact'), SYNC_TRUSTED_SCRIPTS: scripts,
  };
  for (const name of ['first-run', 'retry-orphan']) {
    const cwd = path.join(dir, name);
    git(dir, 'clone', remote, cwd);
    const result = spawnSync('bash', [path.join(scripts, 'upstream-publish.sh')], { cwd, encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(fs.readFileSync(env.FIXTURE_PR_ARGS, 'utf8'), /--draft/);
    assert.equal(git(remote, 'rev-parse', 'main'), base);
    const marker = JSON.parse(git(remote, 'show', 'automation/upstream-cloudflare:.github/upstream-sync.json'));
    assert.equal(marker.lastApplied, env.SYNC_TARGET);
  }
  const cwd = path.join(dir, 'base-moved');
  git(dir, 'clone', remote, cwd);
  const moved = spawnSync('bash', [path.join(scripts, 'upstream-publish.sh')], {
    cwd, encoding: 'utf8', env: { ...env, FIXTURE_BASE: 'c'.repeat(40) },
  });
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /main changed/);
});
