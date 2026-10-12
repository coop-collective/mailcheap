import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cloudflareCredentials,
  loadRuntimeConfig,
  projectEnvironment,
  resolveConfig,
  RESOURCE_KEYS,
  writeRuntimeConfig,
} from '../scripts/project-config.mjs';
import { readConfig, SECRET_KEYS, SETTING_KEYS } from '../scripts/setup-common.mjs';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const ENV_KEYS = [
  ...RESOURCE_KEYS,
  ...SETTING_KEYS,
  ...SECRET_KEYS,
  'APP_URL', 'SENDING_ENABLED', 'CLOUDFLARE_API_TOKEN',
  'LOCAL_APP_URL', 'LOCAL_SENDING_ENABLED', 'MAILCHEAP_ENV_FILE',
];

function withCleanEnvironment(callback) {
  const previous = new Map(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function temporaryProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-project-config-'));
  fs.copyFileSync(path.join(PROJECT_ROOT, 'wrangler.jsonc'), path.join(root, 'wrangler.jsonc'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readDotenvValues(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^(['"`])|(['"`])$/g, '')];
  }));
}

test('prefers private .env and falls back to legacy .dev.vars', t => {
  const root = temporaryProject(t);
  fs.writeFileSync(path.join(root, '.env'), 'D1_DATABASE_NAME=private-env\n');
  fs.writeFileSync(path.join(root, '.dev.vars'), 'D1_DATABASE_NAME=legacy-vars\n');

  withCleanEnvironment(() => {
    const preferred = projectEnvironment(root);
    assert.equal(preferred.file, path.join(root, '.env'));
    assert.equal(preferred.values.D1_DATABASE_NAME, 'private-env');

    fs.unlinkSync(path.join(root, '.env'));
    const fallback = projectEnvironment(root);
    assert.equal(fallback.file, path.join(root, '.dev.vars'));
    assert.equal(fallback.values.D1_DATABASE_NAME, 'legacy-vars');
  });
});

test('private resource IDs, names, and public settings override the template without mutating it', () => {
  const base = readConfig(PROJECT_ROOT).config;
  const original = structuredClone(base);
  const values = {
    CLOUDFLARE_ACCOUNT_ID: 'fake-account-id',
    WORKER_NAME: 'private-mail-worker',
    D1_DATABASE_ID: 'fake-d1-id',
    D1_DATABASE_NAME: 'private-database',
    R2_ENABLED: 'true',
    R2_BUCKET_NAME: 'private-images',
    EMAIL_QUEUE_NAME: 'private-email-queue',
    EMAIL_DEAD_LETTER_QUEUE_NAME: 'private-dead-letter',
    APP_URL: 'https://newsletter.example.test',
    SENDING_ENABLED: 'true',
    ...Object.fromEntries(SETTING_KEYS.map(key => [key, `private-${key.toLowerCase()}`])),
  };

  const config = resolveConfig(base, values);
  assert.equal(config.name, values.WORKER_NAME);
  assert.equal(config.account_id, values.CLOUDFLARE_ACCOUNT_ID);
  assert.deepEqual(config.d1_databases[0], {
    ...base.d1_databases[0],
    database_name: values.D1_DATABASE_NAME,
    database_id: values.D1_DATABASE_ID,
  });
  assert.deepEqual(config.r2_buckets, [{ binding: 'IMAGES', bucket_name: values.R2_BUCKET_NAME }]);
  assert.equal(config.queues.producers[0].queue, values.EMAIL_QUEUE_NAME);
  assert.equal(config.queues.consumers[0].queue, values.EMAIL_QUEUE_NAME);
  assert.equal(config.queues.consumers[0].dead_letter_queue, values.EMAIL_DEAD_LETTER_QUEUE_NAME);
  for (const key of ['APP_URL', 'SENDING_ENABLED', ...SETTING_KEYS]) assert.equal(config.vars[key], values[key]);
  assert.deepEqual(base, original);
});

test('local config defaults to localhost and sending off instead of inheriting production settings', () => {
  const base = readConfig(PROJECT_ROOT).config;
  const productionValues = {
    APP_URL: 'https://newsletter.example.test',
    SENDING_ENABLED: 'true',
  };

  const safeLocal = resolveConfig(base, productionValues, { local: true });
  assert.equal(safeLocal.vars.APP_URL, 'http://localhost:3000');
  assert.equal(safeLocal.vars.SENDING_ENABLED, 'false');

  const configuredLocal = resolveConfig(base, {
    ...productionValues,
    LOCAL_APP_URL: 'http://127.0.0.1:4100',
    LOCAL_SENDING_ENABLED: 'true',
  }, { local: true });
  assert.equal(configuredLocal.vars.APP_URL, 'http://127.0.0.1:4100');
  assert.equal(configuredLocal.vars.SENDING_ENABLED, 'true');
});

test('generated configs use absolute paths, owner-only permissions, and keep credentials out of config', t => {
  const root = temporaryProject(t);
  const base = readConfig(root).config;
  base.vars.ADMIN_PASSWORD = 'template-fake-password';
  base.vars.SESSION_SECRET = 'template-fake-session-secret';
  base.vars.CLOUDFLARE_API_TOKEN = 'template-fake-api-token';
  base.vars.D1_DATABASE_ID = 'template-fake-database-id';
  base.vars.R2_BUCKET_NAME = 'template-fake-bucket';

  const values = {
    ADMIN_EMAIL: 'fake@example.test',
    ADMIN_PASSWORD: 'fake-admin-password',
    SESSION_SECRET: 'fake-session-secret',
    AWS_SECRET_ACCESS_KEY: 'fake-aws-secret',
    CLOUDFLARE_API_TOKEN: 'fake-cloudflare-token',
    CLOUDFLARE_ACCOUNT_ID: 'fake-account-id',
    D1_DATABASE_ID: 'fake-d1-id',
    R2_BUCKET_NAME: 'fake-bucket',
    EMAIL_QUEUE_NAME: 'fake-queue',
    LOCAL_APP_URL: 'http://localhost:3000',
    LOCAL_SENDING_ENABLED: 'false',
    APP_URL: 'https://newsletter.example.test',
    SENDING_ENABLED: 'true',
  };
  const config = resolveConfig(base, values, { local: true });
  const configPath = writeRuntimeConfig(root, config, values, { local: true });
  const generated = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const dotenvPath = path.join(path.dirname(configPath), '.dev.vars');
  const dotenvText = fs.readFileSync(dotenvPath, 'utf8');
  const dotenv = readDotenvValues(dotenvPath);

  assert.equal(generated.main, path.resolve(root, 'worker/index.js'));
  assert.equal(generated.assets.directory, path.resolve(root, 'dist/client'));
  assert.equal(generated.d1_databases[0].migrations_dir, path.resolve(root, 'migrations'));
  for (const file of [configPath, dotenvPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777, 0o700);

  for (const key of [...SECRET_KEYS, 'CLOUDFLARE_API_TOKEN']) {
    assert.equal(Object.hasOwn(generated.vars, key), false, `${key} must not enter generated Wrangler vars`);
  }
  assert.equal(JSON.stringify(generated).includes('fake-admin-password'), false);
  assert.equal(JSON.stringify(generated).includes('fake-aws-secret'), false);
  assert.equal(JSON.stringify(generated).includes('fake-cloudflare-token'), false);

  for (const key of [...RESOURCE_KEYS, 'CLOUDFLARE_API_TOKEN']) {
    assert.equal(Object.hasOwn(dotenv, key), false, `${key} must not enter generated .dev.vars`);
  }
  assert.equal(dotenv.ADMIN_PASSWORD, values.ADMIN_PASSWORD);
  assert.equal(dotenv.SESSION_SECRET, values.SESSION_SECRET);
  assert.equal(dotenv.AWS_SECRET_ACCESS_KEY, values.AWS_SECRET_ACCESS_KEY);
  assert.equal(dotenvText.includes('fake-cloudflare-token'), false);
});

test('unknown environment keys do not appear in generated runtime config or dev vars', t => {
  const root = temporaryProject(t);
  fs.writeFileSync(path.join(root, '.env'), [
    'APP_URL=https://newsletter.example.test',
    'SENDING_ENABLED=false',
    'UNKNOWN_FAKE_SETTING=must-not-be-used',
  ].join('\n') + '\n');

  withCleanEnvironment(() => {
    process.env.MAILCHEAP_UNKNOWN_TEST = 'shell-value-must-not-be-used';
    try {
      const { config, values, configPath } = loadRuntimeConfig(root, { local: true });
      const dotenvPath = path.join(path.dirname(configPath), '.dev.vars');
      assert.equal(config.vars.UNKNOWN_FAKE_SETTING, undefined);
      assert.equal(config.vars.MAILCHEAP_UNKNOWN_TEST, undefined);
      assert.equal(values.UNKNOWN_FAKE_SETTING, undefined);
      assert.equal(readDotenvValues(dotenvPath).UNKNOWN_FAKE_SETTING, undefined);
      assert.equal(fs.readFileSync(configPath, 'utf8').includes('must-not-be-used'), false);
      assert.equal(fs.readFileSync(dotenvPath, 'utf8').includes('must-not-be-used'), false);
    } finally {
      delete process.env.MAILCHEAP_UNKNOWN_TEST;
    }
  });
});

test('Cloudflare credentials helper forwards only the API token and account ID', () => {
  assert.deepEqual(cloudflareCredentials({
    CLOUDFLARE_ACCOUNT_ID: 'fake-account-id',
    CLOUDFLARE_API_TOKEN: 'fake-api-token',
    D1_DATABASE_ID: 'fake-d1-id',
    ADMIN_PASSWORD: 'fake-password',
  }), {
    CLOUDFLARE_ACCOUNT_ID: 'fake-account-id',
    CLOUDFLARE_API_TOKEN: 'fake-api-token',
  });
});
