import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { environmentFile, prepareEnvironment, readEnvironment, deploymentSecrets, readConfig, validateDeployConfig, publicAppUrl, PLACEHOLDER_ID } from '../scripts/setup-common.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-setup-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('local setup generates private credentials and reruns preserve every existing secret', t => {
  const root = fixture(t);
  const first = prepareEnvironment(root, { email: 'admin@example.test' });
  assert.equal(first.values.SENDING_ENABLED, 'false');
  assert.ok(first.values.ADMIN_PASSWORD.length >= 24);
  assert.ok(first.values.SESSION_SECRET.length >= 48);
  assert.equal(fs.statSync(first.file).mode & 0o777, 0o600);
  fs.appendFileSync(first.file, "AWS_SECRET_ACCESS_KEY='complex\\value#with\"quotes'\n");
  const before = fs.readFileSync(first.file, 'utf8');
  const second = prepareEnvironment(root);
  assert.equal(second.values.SESSION_SECRET, first.values.SESSION_SECRET);
  assert.equal(second.values.ADMIN_PASSWORD, first.values.ADMIN_PASSWORD);
  assert.equal(second.values.AWS_SECRET_ACCESS_KEY, 'complex\\value#with"quotes');
  assert.equal(fs.readFileSync(first.file, 'utf8'), before);
});

test('existing .env is reused without shadowing it with a second local env file', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.env'), "ADMIN_EMAIL=person@example.test\nSESSION_SECRET='existing-signing-secret-at-least-32-characters'\n");
  const result = prepareEnvironment(root);
  assert.equal(result.file, path.join(root, '.env'));
  assert.equal(result.values.SESSION_SECRET, 'existing-signing-secret-at-least-32-characters');
  assert.equal(fs.existsSync(path.join(root, '.dev.vars')), false);
  assert.throws(() => environmentFile(root, 'secrets.txt'), /ignored/);
  assert.throws(() => environmentFile(root, '.env.example'), /tracked example/);
  assert.throws(() => environmentFile(root, '.dev.vars.example'), /tracked example/);
});

test('blank template fields are filled once, while invalid nonempty secrets are never rotated', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, '.dev.vars'), 'ADMIN_PASSWORD=\nSESSION_SECRET=\n');
  const result = prepareEnvironment(root, { email: 'admin@example.test' });
  assert.ok(readEnvironment(result.file).SESSION_SECRET);
  fs.appendFileSync(result.file, 'ADMIN_PASSWORD=short\n');
  const before = fs.readFileSync(result.file, 'utf8');
  assert.throws(() => prepareEnvironment(root), /12 characters/);
  assert.equal(fs.readFileSync(result.file, 'utf8'), before);
});

test('deployment uploads only runtime secrets, excluding local settings and Cloudflare credentials', t => {
  const { values } = prepareEnvironment(fixture(t), { email: 'admin@example.test' });
  const secrets = deploymentSecrets({ ...values, AWS_ACCESS_KEY_ID: 'test-access', AWS_SECRET_ACCESS_KEY: 'test-secret', CLOUDFLARE_API_TOKEN: 'never-upload', APP_URL: 'http://localhost:3000', VITE_PUBLIC_KEY: 'ignored' });
  assert.deepEqual(Object.keys(secrets).sort(), ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SESSION_SECRET']);
  assert.equal(secrets.SESSION_SECRET, values.SESSION_SECRET);
});

test('JSONC reading supports comments without rewriting the public template', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'wrangler.jsonc'), '{\n  // keep this comment\n  "name": "mailcheap",\n  "custom": {"value": 1},\n  "vars": {"SENDING_ENABLED": "false"},\n}\n');
  const { text, config } = readConfig(root);
  assert.match(text, /keep this comment/);
  assert.equal(config.name, 'mailcheap');
  assert.match(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'), /keep this comment/);
  assert.deepEqual(readConfig(root).config.custom, { value: 1 });
});

test('live deployment rejects placeholders, localhost, and sending without SES feedback configuration', t => {
  const { values } = prepareEnvironment(fixture(t), { email: 'admin@example.test' });
  const config = { account_id: 'a'.repeat(32), d1_databases: [{ binding: 'DB', database_id: 'database-id' }], vars: { APP_URL: 'https://mail.example.test', SENDING_ENABLED: 'false' } };
  assert.doesNotThrow(() => validateDeployConfig(config, values));
  assert.throws(() => validateDeployConfig({ ...config, account_id: undefined }, values), /select/);
  assert.throws(() => validateDeployConfig({ ...config, d1_databases: [{ binding: 'DB', database_id: PLACEHOLDER_ID }] }, values), /provision/);
  assert.throws(() => validateDeployConfig({ ...config, vars: { APP_URL: 'http://localhost:3000' } }, values), /HTTPS/);
  assert.throws(() => validateDeployConfig({ ...config, vars: { ...config.vars, SENDING_ENABLED: 'true' } }, values), /credentials/);
  assert.doesNotThrow(() => validateDeployConfig({}, {}, { dryRun: true }));
  for (const url of ['https://localhost', 'https://127.0.0.1', 'https://user:pass@example.com', 'https://example.com/path']) assert.throws(() => publicAppUrl(url));
});

function cliFixture(t) {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.mkdirSync(path.join(root, 'lib'));
  for (const file of ['setup.mjs', 'setup-common.mjs', 'setup-cloudflare.mjs', 'project-config.mjs', 'deploy.mjs']) fs.copyFileSync(path.join(sourceRoot, 'scripts', file), path.join(root, 'scripts', file));
  fs.copyFileSync(path.join(sourceRoot, 'lib/config.js'), path.join(root, 'lib/config.js'));
  fs.copyFileSync(path.join(sourceRoot, 'wrangler.jsonc'), path.join(root, 'wrangler.jsonc'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8')).scripts }));
  fs.mkdirSync(path.join(root, 'node_modules/wrangler/bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules/vite/bin'), { recursive: true });
  fs.symlinkSync(path.join(sourceRoot, 'node_modules/jsonc-parser'), path.join(root, 'node_modules/jsonc-parser'));
  const mock = `import fs from 'node:fs';
const args=process.argv.slice(2);
const secretIndex=args.indexOf('--secrets-file');
const secretFile=secretIndex >= 0 ? args[secretIndex+1] : null;
const configIndex=args.indexOf('--config');
const configFile=configIndex>=0?args[configIndex+1]:null;
fs.appendFileSync('calls.jsonl',JSON.stringify({tool:import.meta.url.includes('vite')?'vite':'wrangler',args,secretFile,config:configFile?JSON.parse(fs.readFileSync(configFile,'utf8')):null,secrets:secretFile?JSON.parse(fs.readFileSync(secretFile,'utf8')):null})+'\\n');
if(args[0]==='whoami') console.log(JSON.stringify({loggedIn:true,accounts:[{id:'a'.repeat(32),name:'Fixture'}]}));
if(args[0]==='auth') console.log(JSON.stringify({type:'api_token',token:'fake-cloudflare-token'}));
if(import.meta.url.includes('vite')) {
  fs.mkdirSync('dist/server',{recursive:true});
  fs.copyFileSync('.wrangler/mailcheap/production/wrangler.json','dist/server/wrangler.json');
}
`;
  fs.writeFileSync(path.join(root, 'node_modules/wrangler/bin/wrangler.js'), mock);
  fs.writeFileSync(path.join(root, 'node_modules/vite/bin/vite.js'), mock);
  return root;
}

test('checkout setup CLI creates a selected env file without Node treating it as a startup file', t => {
  const root = cliFixture(t);
  const result = spawnSync('npm', ['run', 'setup', '--', '--local', '--email', 'admin@example.test', '--env-file', '.env'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: '', MAILCHEAP_ENV_FILE: '' } });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 5), ['d1', 'migrations', 'apply', 'DB', '--local']);
  assert.ok(calls[0].args.includes(path.join(fs.realpathSync(root), '.wrangler/mailcheap/local/wrangler.json')));
  const env = readEnvironment(path.join(root, '.env'));
  assert.ok(env.ADMIN_PASSWORD);
  assert.equal(fs.existsSync(path.join(root, '.dev.vars')), false);
  assert.equal(result.stdout.includes(env.ADMIN_PASSWORD), false);
  assert.equal(result.stdout.includes(env.SESSION_SECRET), false);
});

test('deploy dry-run builds/packages without auth or remote migration and removes temporary secrets', t => {
  const root = cliFixture(t);
  const { values } = prepareEnvironment(root, { email: 'admin@example.test' });
  const result = spawnSync('npm', ['run', 'deploy', '--', '--dry-run'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: '' } });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].tool, 'vite');
  assert.equal(calls[1].args.includes('--dry-run'), true);
  assert.equal(calls[1].secrets.SESSION_SECRET, values.SESSION_SECRET);
  assert.equal(calls[1].secrets.APP_URL, undefined);
  assert.equal(fs.existsSync(calls[1].secretFile), false);
});

test('fresh checkout deployment uses private IDs/settings for build and migration without setup or template changes', t => {
  const root = cliFixture(t);
  const { file, values } = prepareEnvironment(root, { email: 'admin@example.test' });
  fs.appendFileSync(file, "CLOUDFLARE_ACCOUNT_ID=" + 'a'.repeat(32) + "\nWORKER_NAME=my-private-worker\nD1_DATABASE_ID=11111111-2222-4333-8444-555555555555\nD1_DATABASE_NAME=private-db\nR2_BUCKET_NAME=private-images\nEMAIL_QUEUE_NAME=private-email\nEMAIL_DEAD_LETTER_QUEUE_NAME=private-dlq\nAPP_URL=https://mail.example.test\nCLOUDFLARE_API_TOKEN=fake-cloudflare-token\n");
  const template = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  const result = spawnSync('npm', ['run', 'deploy'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: '', MAILCHEAP_ENV_FILE: '' } });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.tool === 'vite' ? 'build' : call.args[0]), ['whoami', 'auth', 'build', 'd1', 'deploy']);
  for (const call of calls.filter(call => call.config)) {
    assert.equal(call.config.name, 'my-private-worker');
    assert.equal(call.config.account_id, 'a'.repeat(32));
    assert.equal(call.config.d1_databases[0].database_name, 'private-db');
    assert.equal(call.config.d1_databases[0].database_id, '11111111-2222-4333-8444-555555555555');
    assert.equal(call.config.r2_buckets[0].bucket_name, 'private-images');
    assert.equal(call.config.queues.producers[0].queue, 'private-email');
    assert.equal(call.config.vars.APP_URL, 'https://mail.example.test');
    assert.equal(call.config.vars.CLOUDFLARE_API_TOKEN, undefined);
  }
  const deploy = calls.at(-1);
  assert.equal(deploy.secrets.SESSION_SECRET, values.SESSION_SECRET);
  assert.equal(deploy.secrets.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(fs.existsSync(deploy.secretFile), false);
  assert.equal(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'), template);
  assert.equal(result.stdout.includes(values.SESSION_SECRET), false);
});

test('guided cloud setup persists resource IDs privately and reruns preserve credentials and the template', t => {
  const root = cliFixture(t);
  fs.writeFileSync(path.join(root, 'scripts/setup-cloudflare.mjs'), `
export async function readCloudflareAuth() { return {accounts:[{id:'a'.repeat(32),name:'Fixture'}],token:'fake'}; }
export async function provisionCloudflare({accountId,config}) {
  config.account_id=accountId;
  config.d1_databases[0].database_id='11111111-2222-4333-8444-555555555555';
  return {config,workersSubdomain:'fixture-account'};
}`);
  const template = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  const run = () => spawnSync('npm', ['run', 'setup', '--', '--email', 'admin@example.test', '--name', 'private-worker'], { cwd: root, encoding: 'utf8', env: { ...process.env, CLOUDFLARE_ENV: '', MAILCHEAP_ENV_FILE: '' } });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const env = readEnvironment(path.join(root, '.env'));
  assert.equal(env.CLOUDFLARE_ACCOUNT_ID, 'a'.repeat(32));
  assert.equal(env.D1_DATABASE_ID, '11111111-2222-4333-8444-555555555555');
  assert.equal(env.R2_BUCKET_NAME, 'private-worker-images');
  assert.equal(env.APP_URL, 'https://private-worker.fixture-account.workers.dev');
  assert.equal(env.SENDING_ENABLED, 'false');
  const second = run();
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readEnvironment(path.join(root, '.env')), env);
  assert.equal(fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8'), template);
});
