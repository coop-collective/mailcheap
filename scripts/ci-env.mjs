import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { RESOURCE_KEYS, resolveConfig } from './project-config.mjs';
import { deploymentSecrets, publicAppUrl, readConfig, SECRET_KEYS, SETTING_KEYS, validateDeployConfig } from './setup-common.mjs';
import { previewSecrets, validatePreviewEnvironment } from './preview-config.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_FILE = path.join(ROOT, '.env.ci');
const MAX_SECRET_BYTES = 48 * 1024;
const BASE_ENV_KEYS = [
  ...RESOURCE_KEYS,
  ...SETTING_KEYS,
  ...SECRET_KEYS,
  'APP_URL', 'SENDING_ENABLED', 'DEPLOYMENT_ENVIRONMENT',
];
const PREVIEW_EXCLUDED_KEYS = new Set([
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_SESSION_TOKEN',
  'AWS_REGION', 'SES_REGION', 'SES_CONFIGURATION_SET', 'SES_SNS_TOPIC_ARN',
  'SEND_RATE_PER_SECOND', 'ALERT_FROM', 'CUSTOM_DOMAIN',
]);

function parseValues(contents) {
  if (typeof contents !== 'string' || !contents.trim()) throw new Error('MAILCHEAP_ENV is empty.');
  if (Buffer.byteLength(contents) > MAX_SECRET_BYTES) throw new Error('MAILCHEAP_ENV exceeds GitHub’s 48 KiB secret limit.');
  let values;
  try { values = parseEnv(contents); }
  catch { throw new Error('MAILCHEAP_ENV is not valid dotenv text.'); }
  if (Object.hasOwn(values, 'CLOUDFLARE_API_TOKEN')) {
    throw new Error('Keep CLOUDFLARE_API_TOKEN in its separate GitHub secret, not MAILCHEAP_ENV.');
  }
  return values;
}

function serializeValue(value) {
  const text = String(value);
  if (/[\r\n\0]/.test(text)) throw new Error('Runtime environment values must be single-line text.');
  for (const quote of ["'", '`', '"']) {
    if (!text.includes(quote) && (quote !== '"' || !/\\[nr]/.test(text))) return `${quote}${text}${quote}`;
  }
  throw new Error('A runtime environment value contains an unsupported combination of quotes.');
}

function serializeEnvironment(values, mode) {
  const allowed = new Set(BASE_ENV_KEYS);
  const selected = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key)));
  if (mode === 'preview') {
    for (const key of PREVIEW_EXCLUDED_KEYS) delete selected[key];
  }
  const output = Object.entries(selected).map(([key, value]) => `${key}=${serializeValue(value)}`).join('\n') + '\n';
  if (Buffer.byteLength(output) > MAX_SECRET_BYTES) throw new Error('Filtered MAILCHEAP_ENV exceeds GitHub’s 48 KiB secret limit.');
  return output;
}

export function validateCiValues(values, mode, root = ROOT) {
  if (!['production', 'preview'].includes(mode)) throw new Error('Choose production or preview mode.');
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('MAILCHEAP_ENV is not a valid environment map.');
  if (Object.hasOwn(values, 'CLOUDFLARE_API_TOKEN')) {
    throw new Error('Keep CLOUDFLARE_API_TOKEN in its separate GitHub secret, not MAILCHEAP_ENV.');
  }
  if (values.DEPLOYMENT_ENVIRONMENT !== mode) {
    throw new Error(`MAILCHEAP_ENV must contain DEPLOYMENT_ENVIRONMENT=${mode}.`);
  }
  const base = readConfig(root).config;
  const config = resolveConfig(base, values);
  if (mode === 'production') {
    deploymentSecrets(values);
    validateDeployConfig(config, values);
  } else {
    if (values.SENDING_ENABLED !== 'false' || values.TRANSACTIONAL_EMAIL_ENABLED !== 'false') {
      throw new Error('Preview environments must set SENDING_ENABLED=false and TRANSACTIONAL_EMAIL_ENABLED=false.');
    }
    validatePreviewEnvironment(config, values);
    previewSecrets(values);
  }
  return { values, serialized: serializeEnvironment(values, mode) };
}

export function validateCiEnvironment(contents, mode, root = ROOT) {
  return validateCiValues(parseValues(contents), mode, root);
}

export function writeCiEnvironment(contents, mode, {
  root = ROOT,
  outputFile = path.join(root, '.env.ci'),
  githubOutput = process.env.GITHUB_OUTPUT,
} = {}) {
  const { values, serialized } = validateCiEnvironment(contents, mode, root);
  if (fs.existsSync(outputFile) && fs.lstatSync(outputFile).isSymbolicLink()) {
    throw new Error('Refusing to write CI secrets through a symlink.');
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputFile, serialized, { mode: 0o600 });
  fs.chmodSync(outputFile, 0o600);
  if (githubOutput) {
    const url = mode === 'production' ? publicAppUrl(values.APP_URL) : undefined;
    if (url) fs.appendFileSync(githubOutput, `app_url=${url}\n`, { mode: 0o600 });
  }
  return { outputFile, values };
}

export function removeCiEnvironment(file = OUTPUT_FILE) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Refusing to remove an unexpected .env.ci path.');
    fs.rmSync(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function validateRepository(repository) {
  if (typeof repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must be owner/name.');
  }
  return repository;
}

function ghJson(endpoint, { token = process.env.GH_TOKEN, ghPath = 'gh' } = {}) {
  if (!token) throw new Error('GH_TOKEN is required for the read-only deployment freshness check.');
  const result = spawnSync(ghPath, ['api', endpoint], {
    encoding: 'utf8',
    env: { ...process.env, GH_TOKEN: token },
    maxBuffer: 256 * 1024,
    shell: false,
  });
  if (result.error || result.status !== 0) throw new Error('GitHub could not verify the deployment target; refusing to deploy.');
  try { return JSON.parse(result.stdout); }
  catch { throw new Error('GitHub returned an invalid response; refusing to deploy.'); }
}

export function assertCurrentMain({ repository, expectedSha, token, ghPath } = {}) {
  const repo = validateRepository(repository);
  if (!/^[a-f0-9]{40}$/i.test(expectedSha || '')) throw new Error('Expected commit SHA is invalid.');
  const result = ghJson(`repos/${repo}/git/ref/heads/main`, { token, ghPath });
  if (result.object?.sha !== expectedSha) throw new Error('main moved after checks passed; refusing to deploy a stale commit.');
  return true;
}

export function assertCurrentPullRequest({ repository, expectedSha, pullRequestNumber, token, ghPath } = {}) {
  const repo = validateRepository(repository);
  if (!/^[a-f0-9]{40}$/i.test(expectedSha || '') || !/^\d{1,10}$/.test(String(pullRequestNumber || ''))) {
    throw new Error('Pull request deployment identity is invalid.');
  }
  const result = ghJson(`repos/${repo}/pulls/${pullRequestNumber}`, { token, ghPath });
  if (result.state !== 'open' || result.draft !== false || result.head?.sha !== expectedSha ||
      result.head?.repo?.full_name !== repo || result.base?.ref !== 'main') {
    throw new Error('The pull request changed or closed after checks passed; refusing to deploy a stale preview.');
  }
  return true;
}

export function assertClosedPullRequest({ repository, expectedSha, pullRequestNumber, token, ghPath } = {}) {
  const repo = validateRepository(repository);
  if (!/^[a-f0-9]{40}$/i.test(expectedSha || '') || !/^\d{1,10}$/.test(String(pullRequestNumber || ''))) {
    throw new Error('Pull request cleanup identity is invalid.');
  }
  const result = ghJson(`repos/${repo}/pulls/${pullRequestNumber}`, { token, ghPath });
  if (result.state !== 'closed' || result.head?.sha !== expectedSha ||
      result.head?.repo?.full_name !== repo || result.base?.ref !== 'main') {
    throw new Error('The pull request is no longer closed or changed; refusing to delete its Preview.');
  }
  return true;
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--remove')) {
    removeCiEnvironment();
    return;
  }
  if (args.includes('--prepare')) {
    const index = args.indexOf('--prepare');
    const mode = args[index + 1];
    const result = writeCiEnvironment(process.env.MAILCHEAP_ENV, mode);
    console.log(`Prepared filtered ${mode} CI environment (${path.basename(result.outputFile)}).`);
    return;
  }
  if (args.includes('--assert-main')) {
    assertCurrentMain({ repository: process.env.GITHUB_REPOSITORY, expectedSha: process.env.GITHUB_SHA });
    console.log('Current main commit verified.');
    return;
  }
  if (args.includes('--assert-preview')) {
    assertCurrentPullRequest({ repository: process.env.GITHUB_REPOSITORY, expectedSha: process.env.PR_HEAD_SHA, pullRequestNumber: process.env.PR_NUMBER });
    console.log('Current open pull request verified.');
    return;
  }
  if (args.includes('--assert-closed-preview')) {
    assertClosedPullRequest({ repository: process.env.GITHUB_REPOSITORY, expectedSha: process.env.PR_HEAD_SHA, pullRequestNumber: process.env.PR_NUMBER });
    console.log('Pull request is still closed; Preview cleanup is safe.');
    return;
  }
  console.log('ci-env: --prepare production|preview, --assert-main, --assert-preview, --assert-closed-preview, or --remove');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
