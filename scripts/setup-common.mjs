import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import { spawn } from 'node:child_process';
import { parse } from 'jsonc-parser';
import { getConfigProblems } from '../lib/config.js';

export const PLACEHOLDER_ID = '00000000-0000-0000-0000-000000000000';
export const SECRET_KEYS = [
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_SESSION_TOKEN',
];
export const SETTING_KEYS = ['AWS_REGION', 'SES_REGION', 'SES_CONFIGURATION_SET', 'SES_SNS_TOPIC_ARN', 'SEND_RATE_PER_SECOND', 'ARCHIVE_HOSTS', 'ALERT_FROM', 'TRANSACTIONAL_EMAIL_ENABLED', 'TRANSACTIONAL_EMAIL_FROM'];

export function readConfig(root) {
  const text = fs.readFileSync(path.join(root, 'wrangler.jsonc'), 'utf8');
  const errors = [];
  const config = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !config || typeof config !== 'object') throw new Error('wrangler.jsonc is not valid JSONC');
  return { text, config };
}

export function environmentFile(root, requested) {
  if (requested) {
    const name = path.basename(requested);
    if (!/^\.(env|dev\.vars)(\..+)?$/.test(name) || ['.env.example', '.dev.vars.example'].includes(name)) throw new Error('Use an ignored .env, .env.* or .dev.vars* filename for secrets, never a tracked example file.');
    return path.resolve(root, requested);
  }
  return path.join(root, fs.existsSync(path.join(root, '.env')) || !fs.existsSync(path.join(root, '.dev.vars')) ? '.env' : '.dev.vars');
}

export function readEnvironment(file) {
  if (!fs.existsSync(file)) return {};
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Use a regular file for local secrets, not a symlink');
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

export function validateSecrets(env) {
  const problems = getConfigProblems(env);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL || '')) problems.unshift('Set ADMIN_EMAIL to your login email address.');
  if (problems.length) throw new Error(problems.join('\n'));
}

// Append only missing/blank values. Existing passwords, signing keys and arbitrary
// quoted secrets remain byte-for-byte intact; reruns never rotate credentials.
export function prepareEnvironment(root, { file = environmentFile(root), email, defaults = {} } = {}) {
  const existing = readEnvironment(file);
  const values = {
    ...existing,
    ADMIN_EMAIL: email || existing.ADMIN_EMAIL || '',
    ADMIN_PASSWORD: existing.ADMIN_PASSWORD || randomBytes(24).toString('base64url'),
    SESSION_SECRET: existing.SESSION_SECRET || randomBytes(48).toString('base64url'),
  };
  for (const [key, value] of Object.entries({
    APP_URL: '', LOCAL_APP_URL: 'http://localhost:3000', SENDING_ENABLED: 'false', LOCAL_SENDING_ENABLED: 'false',
    LOCAL_TRANSACTIONAL_EMAIL_ENABLED: 'false', TRANSACTIONAL_EMAIL_ENABLED: 'false', TRANSACTIONAL_EMAIL_FROM: '', AWS_REGION: 'us-east-1',
    AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '', AWS_SESSION_TOKEN: '',
    SES_CONFIGURATION_SET: 'mailcheap', SES_SNS_TOPIC_ARN: '', SEND_RATE_PER_SECOND: '1', ARCHIVE_HOSTS: '', ALERT_FROM: '',
    ...defaults,
  })) if (values[key] === undefined) values[key] = String(value);
  validateSecrets(values);
  saveEnvironment(file, values);
  return { file, values };
}

export function saveEnvironment(file, values) {
  const existing = readEnvironment(file);
  const additions = Object.entries(values).filter(([key, value]) => existing[key] !== value);
  for (const [key, value] of additions) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n']/.test(value)) throw new Error(`Cannot write ${key}: expected a single-line value without single quotes`);
  }
  if (additions.length || !fs.existsSync(file)) {
    const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Local runtime configuration. Keep this file private; never commit it.\n';
    fs.writeFileSync(file, `${original.endsWith('\n') ? original : `${original}\n`}${additions.map(([key, value]) => `${key}='${value}'`).join('\n')}\n`, { mode: 0o600 });
  }
  fs.chmodSync(file, 0o600);
}

export function deploymentSecrets(env) {
  validateSecrets(env);
  return Object.fromEntries(SECRET_KEYS.filter(key => env[key]).map(key => [key, env[key]]));
}

export function validateDeployConfig(config, env, { dryRun = false, target = 'production' } = {}) {
  if ((env.DEPLOYMENT_ENVIRONMENT || 'production') !== target) throw new Error(`This command requires DEPLOYMENT_ENVIRONMENT=${target}. Use the matching environment file and deployment command.`);
  if (dryRun) return;
  if (!/^[a-f0-9]{32}$/i.test(config.account_id || '')) throw new Error('Run pnpm setup first to select the Cloudflare account.');
  const db = config.d1_databases?.find(item => item.binding === 'DB');
  if (!db?.database_id || db.database_id === PLACEHOLDER_ID) throw new Error('Run pnpm setup first to provision D1.');
  publicAppUrl(config.vars?.APP_URL);
  if (config.vars?.SENDING_ENABLED === 'true') {
    if (!(env.SES_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID) || !(env.SES_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY)) throw new Error('Sending is enabled but SES credentials are missing from the secrets file.');
    if (!config.vars.SES_CONFIGURATION_SET || !config.vars.SES_SNS_TOPIC_ARN) throw new Error('Configure SES_CONFIGURATION_SET and SES_SNS_TOPIC_ARN before enabling sending.');
  }
}

export function publicAppUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('APP_URL must be a public HTTPS origin.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || /^(localhost|127\.|\[::1\])/.test(url.hostname)) throw new Error('APP_URL must be a public HTTPS origin without a path.');
  return url.origin;
}

// Arguments are passed directly, never through a shell. Captured output is used
// for auth commands and must never be logged: it can contain an OAuth/API token.
export function command(commandName, args, { cwd, env = {}, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, { cwd, env: { ...process.env, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', shell: false });
    let stdout = '';
    if (capture) { child.stdout.on('data', data => { stdout += data; }); child.stderr.resume(); }
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`${path.basename(commandName)} ${args[0] || ''} failed (exit ${code}).${capture ? ' Check Wrangler login and account permissions.' : ''}`)));
  });
}

export function wrangler(root, args, options = {}) {
  return command(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), ...args], { cwd: root, ...options });
}
