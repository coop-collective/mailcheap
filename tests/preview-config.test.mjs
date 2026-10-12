import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPreviewConfig, previewSecrets, previewUrlFromOutput, validatePreviewEnvironment } from '../scripts/preview-config.mjs';

function fixture() {
  const config = {
    name: 'mailcheap-preview',
    account_id: 'a'.repeat(32),
    vars: {
      APP_URL: 'https://mailcheap-preview.example.workers.dev',
      SENDING_ENABLED: 'true',
      TRANSACTIONAL_EMAIL_ENABLED: 'true',
      TRANSACTIONAL_EMAIL_FROM: 'send@example.test',
      SES_SNS_TOPIC_ARN: 'arn:aws:sns:production',
      ADMIN_PASSWORD: 'should-never-be-a-var',
      AWS_SECRET_ACCESS_KEY: 'should-never-be-a-var',
    },
    d1_databases: [{ binding: 'DB', database_name: 'mailcheap-preview', database_id: 'a1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4', migrations_dir: 'migrations' }],
    r2_buckets: [{ binding: 'IMAGES', bucket_name: 'mailcheap-preview-images' }],
    queues: {
      producers: [{ binding: 'EMAIL_QUEUE', queue: 'mailcheap-preview-email' }],
      consumers: [{ queue: 'mailcheap-preview-email', dead_letter_queue: 'mailcheap-preview-email-dead-letter' }],
    },
    triggers: { crons: ['* * * * *'] },
    routes: [{ pattern: 'mailcheap.coopcollective.com', custom_domain: true }],
    send_email: [{ name: 'TRANSACTIONAL_EMAIL', allowed_sender_addresses: ['send@example.test'] }],
  };
  const values = {
    DEPLOYMENT_ENVIRONMENT: 'preview',
    WORKER_NAME: 'mailcheap-preview',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    D1_DATABASE_NAME: 'mailcheap-preview',
    D1_DATABASE_ID: 'a1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4',
    R2_ENABLED: 'true',
    R2_BUCKET_NAME: 'mailcheap-preview-images',
    EMAIL_QUEUE_NAME: 'mailcheap-preview-email',
    EMAIL_DEAD_LETTER_QUEUE_NAME: 'mailcheap-preview-email-dead-letter',
    ADMIN_EMAIL: 'preview@example.test',
    ADMIN_PASSWORD: 'preview-password-long',
    SESSION_SECRET: 'preview-session-secret-long-enough-for-validation',
  };
  return { config, values };
}

test('preview marker and every remote resource must identify the preview environment', () => {
  const { config, values } = fixture();
  assert.deepEqual(validatePreviewEnvironment(config, values), {
    workerName: 'mailcheap-preview',
    databaseName: 'mailcheap-preview',
    queueName: 'mailcheap-preview-email',
    deadLetterName: 'mailcheap-preview-email-dead-letter',
    r2Enabled: true,
  });

  assert.throws(() => validatePreviewEnvironment(config, { ...values, DEPLOYMENT_ENVIRONMENT: 'production' }), /DEPLOYMENT_ENVIRONMENT=preview/);
  assert.throws(() => validatePreviewEnvironment(config, { ...values, WORKER_NAME: 'mailcheap' }), /WORKER_NAME/);
  assert.throws(() => validatePreviewEnvironment(config, { ...values, D1_DATABASE_NAME: 'mailcheap' }), /D1_DATABASE_NAME/);
  assert.throws(() => validatePreviewEnvironment(config, { ...values, D1_DATABASE_ID: 'b1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4' }), /D1_DATABASE_ID/);
  assert.throws(() => validatePreviewEnvironment(config, { ...values, EMAIL_QUEUE_NAME: 'mailcheap-email' }), /EMAIL_QUEUE_NAME/);
  assert.throws(() => validatePreviewEnvironment(config, { ...values, R2_BUCKET_NAME: 'mailcheap-images' }), /R2_BUCKET_NAME/);
});

test('preview secret payload contains only preview login and session credentials', () => {
  const { values } = fixture();
  const secrets = previewSecrets({
    ...values,
    AWS_ACCESS_KEY_ID: 'prod-access-key',
    AWS_SECRET_ACCESS_KEY: 'prod-secret-key',
    SES_ACCESS_KEY_ID: 'prod-ses-key',
    SES_SECRET_ACCESS_KEY: 'prod-ses-secret',
    CLOUDFLARE_API_TOKEN: 'deploy-token',
  });
  assert.deepEqual(Object.keys(secrets).sort(), ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET']);
  assert.equal(JSON.stringify(secrets).includes('prod-'), false);
});

test('Preview config uses explicit safe bindings and removes production triggers and routes', () => {
  const { config } = fixture();
  const preview = createPreviewConfig(config);
  assert.equal(preview.name, 'mailcheap-preview');
  assert.equal(preview.vars.SENDING_ENABLED, 'false');
  assert.equal(preview.vars.TRANSACTIONAL_EMAIL_ENABLED, 'false');
  assert.equal(preview.vars.APP_URL, 'https://preview.invalid');
  assert.equal('ADMIN_PASSWORD' in preview.vars, false);
  assert.equal('AWS_SECRET_ACCESS_KEY' in preview.vars, false);
  assert.equal('send_email' in preview, false);
  assert.equal('triggers' in preview, false);
  assert.equal('routes' in preview, false);
  assert.deepEqual(preview.queues, { producers: config.queues.producers });
  assert.deepEqual(preview.previews.d1_databases, config.d1_databases);
  assert.deepEqual(preview.previews.r2_buckets, config.r2_buckets);
  assert.deepEqual(preview.previews.queues, { producers: config.queues.producers });
  assert.equal('consumers' in preview.previews.queues, false);
  assert.equal(preview.previews.vars.SENDING_ENABLED, 'false');
  assert.notEqual(preview.previews, config.previews);
  assert.deepEqual(config.queues.consumers.length, 1, 'the helper leaves the caller config untouched');
});

test('Preview URL parser selects an HTTPS stable URL from Wrangler JSON', () => {
  const output = JSON.stringify({ preview: { urls: ['https://pr-123-mailcheap-preview.example.workers.dev'] }, deployment: { id: 'deploy-1' } });
  assert.equal(previewUrlFromOutput(output), 'https://pr-123-mailcheap-preview.example.workers.dev');
  assert.throws(() => previewUrlFromOutput('{bad json'), /valid Preview JSON/);
  assert.throws(() => previewUrlFromOutput(JSON.stringify({ preview: { urls: ['http://localhost:3000'] } })), /HTTPS Preview URL/);
});

function previewCliFixture(t) {
  const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-preview-cli-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['scripts', 'lib', 'node_modules/wrangler/bin', 'node_modules/vite/bin']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  for (const file of ['preview.mjs', 'preview-config.mjs', 'setup-common.mjs', 'setup-cloudflare.mjs', 'project-config.mjs']) {
    fs.copyFileSync(path.join(sourceRoot, 'scripts', file), path.join(root, 'scripts', file));
  }
  for (const file of ['config.js', 'validation.js']) fs.copyFileSync(path.join(sourceRoot, 'lib', file), path.join(root, 'lib', file));
  fs.copyFileSync(path.join(sourceRoot, 'wrangler.jsonc'), path.join(root, 'wrangler.jsonc'));
  fs.symlinkSync(path.join(sourceRoot, 'node_modules/jsonc-parser'), path.join(root, 'node_modules/jsonc-parser'));

  const callsFile = path.join(root, 'calls.jsonl');
  const mock = `import fs from 'node:fs';
const args = process.argv.slice(2);
const index = args.indexOf('--config');
const configPath = index >= 0 ? args[index + 1] : null;
const secretIndex = args.indexOf('--secrets-file');
const secretPath = secretIndex >= 0 ? args[secretIndex + 1] : null;
const call = {
  tool: import.meta.url.includes('/vite/') ? 'vite' : 'wrangler',
  args,
  config: configPath && fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : null,
  secrets: secretPath ? JSON.parse(fs.readFileSync(secretPath, 'utf8')) : null,
  secretPath,
};
fs.appendFileSync('calls.jsonl', JSON.stringify(call) + '\\n');
if (args[0] === 'whoami') console.log(JSON.stringify({ loggedIn: true, accounts: [{ id: '${'a'.repeat(32)}', name: 'Fixture' }] }));
if (args[0] === 'auth') console.log(JSON.stringify({ type: 'api_token', token: 'fixture-cloudflare-token' }));
if (import.meta.url.includes('/vite/')) {
  fs.mkdirSync('dist/server', { recursive: true });
  fs.copyFileSync('.wrangler/mailcheap/production/wrangler.json', 'dist/server/wrangler.json');
}
if (args[0] === 'preview') console.log(JSON.stringify({ preview: { urls: ['https://pr-123-mailcheap-preview.example.workers.dev'] } }));
`;
  fs.writeFileSync(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), mock);
  fs.writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), mock);
  fs.writeFileSync(path.join(root, 'node_modules/wrangler/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'node_modules/vite/package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');

  const env = {
    DEPLOYMENT_ENVIRONMENT: 'preview',
    WORKER_NAME: 'mailcheap-preview',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_API_TOKEN: 'fixture-cloudflare-token',
    D1_DATABASE_ID: 'a1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4',
    D1_DATABASE_NAME: 'mailcheap-preview',
    R2_ENABLED: 'true',
    R2_BUCKET_NAME: 'mailcheap-preview-images',
    EMAIL_QUEUE_NAME: 'mailcheap-preview-email',
    EMAIL_DEAD_LETTER_QUEUE_NAME: 'mailcheap-preview-email-dead-letter',
    APP_URL: 'https://preview.invalid',
    SENDING_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_FROM: '',
    ADMIN_EMAIL: 'preview@example.test',
    ADMIN_PASSWORD: 'preview-admin-password-123',
    SESSION_SECRET: 'preview-session-secret-long-enough-to-test',
    AWS_ACCESS_KEY_ID: 'production-aws-access-key',
    AWS_SECRET_ACCESS_KEY: 'production-aws-secret-key',
    SES_ACCESS_KEY_ID: 'production-ses-access-key',
    SES_SECRET_ACCESS_KEY: 'production-ses-secret-key',
    SES_CONFIGURATION_SET: 'production-ses-config',
    SES_SNS_TOPIC_ARN: 'arn:aws:sns:production',
  };
  fs.writeFileSync(path.join(root, '.env.preview'), `${Object.entries(env).map(([key, value]) => `${key}='${value}'`).join('\n')}\n`, { mode: 0o600 });
  return { root, callsFile };
}

test('preview CLI builds, migrates preview resources, deploys twice with stable APP_URL and filters secrets', t => {
  const { root, callsFile } = previewCliFixture(t);
  const githubOutput = path.join(root, 'github-output');
  const result = spawnSync(process.execPath, ['scripts/preview.mjs', '--name', 'pr-123'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLOUDFLARE_ENV: '', MAILCHEAP_ENV_FILE: '', GITHUB_OUTPUT: githubOutput },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Preview deployed: https:\/\/pr-123-mailcheap-preview\.example\.workers\.dev/);
  assert.match(fs.readFileSync(githubOutput, 'utf8'), /preview_url=https:\/\/pr-123-mailcheap-preview\.example\.workers\.dev/);

  const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.tool === 'vite' ? 'build' : call.args[0]), ['whoami', 'auth', 'build', 'd1', 'preview', 'preview']);
  const build = calls.find(call => call.tool === 'vite');
  assert.equal(build.args[0], 'build');
  const migration = calls.find(call => call.args[0] === 'd1');
  assert.deepEqual(migration.args.slice(0, 5), ['d1', 'migrations', 'apply', 'DB', '--remote']);
  assert.equal(migration.config.name, 'mailcheap-preview');
  assert.equal(migration.config.d1_databases[0].database_name, 'mailcheap-preview');
  assert.equal(migration.config.d1_databases[0].database_id, 'a1b2c3d4-a1b2-c3d4-a1b2-c3d4a1b2c3d4');
  assert.equal(migration.config.r2_buckets[0].bucket_name, 'mailcheap-preview-images');
  assert.equal(migration.config.queues.producers[0].queue, 'mailcheap-preview-email');

  const previews = calls.filter(call => call.args[0] === 'preview');
  assert.equal(previews.length, 2);
  const stableUrl = 'https://pr-123-mailcheap-preview.example.workers.dev';
  assert.equal(previews[0].args.includes('--json'), true);
  assert.equal(previews[1].args.at(-2), '--var');
  assert.equal(previews[1].args.at(-1), `APP_URL:${stableUrl}`);
  for (const preview of previews) {
    const config = preview.config;
    assert.equal(config.name, 'mailcheap-preview');
    assert.equal(config.vars.SENDING_ENABLED, 'false');
    assert.equal(config.vars.TRANSACTIONAL_EMAIL_ENABLED, 'false');
    assert.equal(config.vars.APP_URL, 'https://preview.invalid');
    assert.equal(config.routes, undefined);
    assert.equal(config.triggers, undefined);
    assert.equal(config.send_email, undefined);
    assert.deepEqual(Object.keys(preview.secrets).sort(), ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET']);
    assert.equal(JSON.stringify(preview.secrets).includes('production-'), false);
    assert.equal(fs.existsSync(preview.secretPath), false, 'temporary secret file is removed');
  }
});
