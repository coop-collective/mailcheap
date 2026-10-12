import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { assertClosedPullRequest, assertCurrentMain, assertCurrentPullRequest, removeCiEnvironment, validateCiEnvironment, writeCiEnvironment } from '../scripts/ci-env.mjs';
import { configureCi } from '../scripts/setup-ci.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SHA = 'a'.repeat(40);

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-ci-env-'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'wrangler.jsonc'), path.join(root, 'wrangler.jsonc'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function productionEnv(extra = '') {
  return [
    'DEPLOYMENT_ENVIRONMENT=production',
    'CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef',
    'WORKER_NAME=mailcheap',
    'D1_DATABASE_ID=01234567-89ab-cdef-0123-456789abcdef',
    'D1_DATABASE_NAME=mailcheap',
    'R2_ENABLED=false',
    'EMAIL_QUEUE_NAME=mailcheap-email',
    'EMAIL_DEAD_LETTER_QUEUE_NAME=mailcheap-email-dead-letter',
    'APP_URL=https://mailcheap.example.test',
    'ADMIN_EMAIL=admin@example.test',
    'ADMIN_PASSWORD=private-password',
    'SESSION_SECRET=private-session-secret-0123456789abcdef',
    'SENDING_ENABLED=false',
    'TRANSACTIONAL_EMAIL_ENABLED=false',
    extra,
  ].filter(Boolean).join('\n') + '\n';
}

function previewEnv(extra = '') {
  return [
    'DEPLOYMENT_ENVIRONMENT=preview',
    'CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef',
    'WORKER_NAME=mailcheap-preview',
    'D1_DATABASE_ID=01234567-89ab-cdef-0123-456789abcdef',
    'D1_DATABASE_NAME=mailcheap-preview',
    'R2_ENABLED=false',
    'EMAIL_QUEUE_NAME=mailcheap-preview-email',
    'EMAIL_DEAD_LETTER_QUEUE_NAME=mailcheap-preview-dead-letter',
    'APP_URL=https://preview.example.test',
    'ADMIN_EMAIL=admin@example.test',
    'ADMIN_PASSWORD=preview-password',
    'SESSION_SECRET=preview-session-secret-0123456789abcdef',
    'SENDING_ENABLED=false',
    'TRANSACTIONAL_EMAIL_ENABLED=false',
    extra,
  ].filter(Boolean).join('\n') + '\n';
}

function mockGh(t, output) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-mock-gh-'));
  const file = path.join(root, 'gh');
  const log = path.join(root, 'calls.jsonl');
  fs.writeFileSync(file, `#!/usr/bin/env node\nimport fs from 'node:fs';\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (args[0] === 'api' && !args.includes('--method')) process.stdout.write(${JSON.stringify(JSON.stringify(output))});\n`);
  fs.chmodSync(file, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { file, log, env: { PATH: process.env.PATH } };
}

test('CI environment validation filters unknown values and keeps Cloudflare credentials separate', t => {
  const root = temporaryRoot(t);
  const input = productionEnv('CLOUDFLARE_API_TOKEN=wrong-place\nUNKNOWN_PRIVATE_VALUE=discard-me');
  assert.throws(() => validateCiEnvironment(input, 'production', root), /separate GitHub secret/);

  const valid = validateCiEnvironment(productionEnv('UNKNOWN_PRIVATE_VALUE=discard-me'), 'production', root);
  assert.equal(valid.serialized.includes('UNKNOWN_PRIVATE_VALUE'), false);
  assert.equal(valid.serialized.includes('CLOUDFLARE_API_TOKEN'), false);
  assert.match(valid.serialized, /ADMIN_PASSWORD=.*private-password/);
});

test('preview CI environment forces isolated mode and removes SES credentials', t => {
  const root = temporaryRoot(t);
  const valid = validateCiEnvironment(previewEnv('AWS_SECRET_ACCESS_KEY=ses-secret\nSES_ACCESS_KEY_ID=ses-key\nUNKNOWN_VALUE=drop'), 'preview', root);
  assert.equal(valid.serialized.includes('ses-secret'), false);
  assert.equal(valid.serialized.includes('ses-key'), false);
  assert.equal(valid.serialized.includes('UNKNOWN_VALUE'), false);
  assert.match(valid.serialized, /TRANSACTIONAL_EMAIL_ENABLED=(?:'false'|"false`?)/);
  assert.throws(() => validateCiEnvironment(previewEnv().replace('SENDING_ENABLED=false', 'SENDING_ENABLED=true'), 'preview', root), /SENDING_ENABLED=false/);
});

test('writes filtered CI environment with owner-only permissions and exports production URL', t => {
  const root = temporaryRoot(t);
  const target = path.join(root, '.env.ci');
  const output = path.join(root, 'github-output');
  writeCiEnvironment(productionEnv(), 'production', { root, outputFile: target, githubOutput: output });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(target, 'utf8').includes('CLOUDFLARE_API_TOKEN'), false);
  assert.equal(fs.readFileSync(output, 'utf8'), 'app_url=https://mailcheap.example.test\n');
  removeCiEnvironment(target);
  assert.equal(fs.existsSync(target), false);
});

test('deployment freshness checks fail closed for stale commits and changed or forked pull requests', t => {
  const mainGh = mockGh(t, { object: { sha: SHA } });
  assert.equal(assertCurrentMain({ repository: 'coop-collective/mailcheap', expectedSha: SHA, token: 'test-token', ghPath: mainGh.file }), true);
  assert.throws(() => assertCurrentMain({ repository: 'coop-collective/mailcheap', expectedSha: 'b'.repeat(40), token: 'test-token', ghPath: mainGh.file }), /stale commit/);

  const prGh = mockGh(t, {
    state: 'open', draft: false, head: { sha: SHA, repo: { full_name: 'coop-collective/mailcheap' } }, base: { ref: 'main' },
  });
  assert.equal(assertCurrentPullRequest({ repository: 'coop-collective/mailcheap', expectedSha: SHA, pullRequestNumber: 42, token: 'test-token', ghPath: prGh.file }), true);
  const forkGh = mockGh(t, {
    state: 'open', draft: false, head: { sha: SHA, repo: { full_name: 'attacker/mailcheap' } }, base: { ref: 'main' },
  });
  assert.throws(() => assertCurrentPullRequest({ repository: 'coop-collective/mailcheap', expectedSha: SHA, pullRequestNumber: 42, token: 'test-token', ghPath: forkGh.file }), /stale preview/);
});

test('preview cleanup only proceeds while the same pull request remains closed', t => {
  const values = { repository: 'coop-collective/mailcheap', expectedSha: SHA, pullRequestNumber: 42, token: 'test-token' };
  const closedGh = mockGh(t, { state: 'closed', head: { sha: SHA, repo: { full_name: values.repository } }, base: { ref: 'main' } });
  assert.equal(assertClosedPullRequest({ ...values, ghPath: closedGh.file }), true);
  const reopenedGh = mockGh(t, { state: 'open', head: { sha: SHA, repo: { full_name: values.repository } }, base: { ref: 'main' } });
  assert.throws(() => assertClosedPullRequest({ ...values, ghPath: reopenedGh.file }), /no longer closed/);
});

test('GitHub setup passes secret values through stdin and never includes them in gh arguments', t => {
  const mock = mockGh(t, { total_count: 0, environments: [] });
  const result = configureCi({
    repo: 'coop-collective/mailcheap',
    modes: [
      { mode: 'production', token: 'cloudflare-test-token', serialized: 'ADMIN_PASSWORD=production-secret\n', values: { WORKER_NAME: 'mailcheap', D1_DATABASE_ID: 'production-db', ADMIN_EMAIL: 'prod@example.test', ADMIN_PASSWORD: 'production-secret', SESSION_SECRET: 'production-session' } },
      { mode: 'preview', token: 'cloudflare-preview-token', serialized: 'ADMIN_PASSWORD=preview-secret\n', values: { WORKER_NAME: 'mailcheap-preview', D1_DATABASE_ID: 'preview-db', ADMIN_EMAIL: 'preview@example.test', ADMIN_PASSWORD: 'preview-secret', SESSION_SECRET: 'preview-session' } },
    ],
    ghPath: mock.file,
    env: mock.env,
  });
  assert.deepEqual(result.configured, ['production', 'preview']);
  const calls = fs.readFileSync(mock.log, 'utf8');
  for (const secret of ['cloudflare-test-token', 'cloudflare-preview-token', 'production-secret', 'preview-secret']) {
    assert.equal(calls.includes(secret), false);
  }
  assert.equal(calls.includes('MAILCHEAP_DEPLOY_PRODUCTION'), true);
  assert.equal(calls.includes('MAILCHEAP_DEPLOY_PREVIEWS'), true);
  assert.match(calls, /"variable","set","MAILCHEAP_CI_ENABLED","--repo","coop-collective\/mailcheap","--body","true"/);
});

test('GitHub setup leaves existing environment protection settings untouched', t => {
  const mock = mockGh(t, { total_count: 2, environments: [{ name: 'production' }, { name: 'preview' }] });
  configureCi({
    repo: 'coop-collective/mailcheap',
    modes: [{ mode: 'production', token: 'cloudflare-test-token', serialized: 'ADMIN_PASSWORD=private\n', values: { WORKER_NAME: 'mailcheap', D1_DATABASE_ID: 'production-db' } }],
    ghPath: mock.file,
    env: mock.env,
  });
  const calls = fs.readFileSync(mock.log, 'utf8');
  assert.equal(calls.includes('"--method","PUT"'), false);
});

test('new production environment is restricted to main while preview remains available to PR workflows', t => {
  const mock = mockGh(t, { total_count: 0, environments: [] });
  configureCi({
    repo: 'coop-collective/mailcheap',
    modes: [{ mode: 'production', token: 'cloudflare-test-token', serialized: 'ADMIN_PASSWORD=private\n', values: { WORKER_NAME: 'mailcheap', D1_DATABASE_ID: 'production-db' } }],
    ghPath: mock.file,
    env: mock.env,
  });
  const calls = fs.readFileSync(mock.log, 'utf8');
  assert.equal(calls.includes('environments/production/deployment-branch-policies'), true);
  assert.equal(calls.includes('environments/preview/deployment-branch-policies'), false);
});

test('production and preview cannot share worker, data, or admin credentials', () => {
  assert.throws(() => configureCi({
    repo: 'coop-collective/mailcheap',
    dryRun: true,
    modes: [
      { mode: 'production', token: 'token', serialized: '', values: { WORKER_NAME: 'mailcheap', D1_DATABASE_ID: 'same-id' } },
      { mode: 'preview', token: 'token', serialized: '', values: { WORKER_NAME: 'mailcheap-preview', D1_DATABASE_ID: 'same-id' } },
    ],
  }), /different D1_DATABASE_ID/);
});

test('setup-ci CLI dry run validates a selected file without calling GitHub or printing secrets', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-setup-ci-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.env.production');
  fs.writeFileSync(file, productionEnv([
    'CLOUDFLARE_API_TOKEN=cloudflare-token-not-for-output',
    'ADMIN_PASSWORD=admin-password-not-for-output',
  ].join('\n')));
  const script = path.join(PROJECT_ROOT, 'scripts/setup-ci.mjs');
  const result = spawnSync(process.execPath, [script, '--repo', 'coop-collective/mailcheap', '--production-file', file, '--dry-run'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_API_TOKEN: '' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Dry run: validate and configure production/);
  assert.equal(result.stdout.includes('cloudflare-token-not-for-output'), false);
  assert.equal(result.stdout.includes('admin-password-not-for-output'), false);
});
