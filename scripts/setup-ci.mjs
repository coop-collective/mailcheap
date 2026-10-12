import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { environmentFile, readEnvironment } from './setup-common.mjs';
import { validateCiValues } from './ci-env.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function parseFlags(args) {
  return parseArgs({ args, options: {
    repo: { type: 'string' }, 'production-file': { type: 'string' }, 'preview-file': { type: 'string' },
    disable: { type: 'boolean' }, 'disable-ci': { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
  } }).values;
}

function validateRepo(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || '')) throw new Error('Pass --repo owner/name.');
  return value;
}

function invokeGh(args, { input, ghPath = 'gh', env = process.env } = {}) {
  const result = spawnSync(ghPath, args, { input, encoding: 'utf8', env, shell: false, maxBuffer: 256 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`GitHub CLI operation failed (${args[0]}). Check gh authentication and repository access.`);
  return result.stdout;
}

function api(repo, endpoint, { method = 'GET', body, ...options } = {}) {
  const args = ['api', `repos/${repo}/${endpoint}`];
  if (method !== 'GET') args.push('--method', method);
  if (body) args.push('--input', '-');
  return invokeGh(args, { input: body ? JSON.stringify(body) : undefined, ...options });
}

function setEnvironment(repo, name, options) {
  const deploymentBranchPolicy = name === 'production'
    ? { protected_branches: false, custom_branch_policies: true }
    : undefined;
  api(repo, `environments/${name}`, {
    method: 'PUT',
    body: { wait_timer: 0, reviewers: [], ...(deploymentBranchPolicy ? { deployment_branch_policy: deploymentBranchPolicy } : {}) },
    ...options,
  });
  if (name === 'production') {
    api(repo, `environments/${name}/deployment-branch-policies`, { method: 'POST', body: { name: 'main', type: 'branch' }, ...options });
  }
}

function ensureEnvironments(repo, options) {
  const existing = new Set();
  let page = 1;
  let total = Infinity;
  while (existing.size < total) {
    let result;
    try { result = JSON.parse(api(repo, `environments?per_page=100&page=${page}`, options)); }
    catch { throw new Error('Could not list GitHub Environments; refusing to change their protection settings.'); }
    if (!Array.isArray(result.environments) || !Number.isInteger(result.total_count)) throw new Error('GitHub returned an invalid Environments list.');
    total = result.total_count;
    for (const item of result.environments) if (typeof item.name === 'string') existing.add(item.name);
    page += 1;
    if (page > 100) throw new Error('GitHub returned an unexpectedly large Environments list.');
  }
  for (const name of ['production', 'preview']) if (!existing.has(name)) setEnvironment(repo, name, options);
}

function setSecret(repo, environment, name, value, options) {
  invokeGh(['secret', 'set', name, '--repo', repo, '--env', environment], { input: value, ...options });
}

function setVariable(repo, environment, name, value, options) {
  invokeGh(['variable', 'set', name, '--repo', repo, '--body', value], options);
}

function loadMode(fileArg, mode) {
  const file = environmentFile(root, fileArg || (mode === 'production' ? '.env' : '.env.preview'));
  const values = readEnvironment(file);
  const token = values.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
  if (token && (token.trim() !== token || /[\r\n\0]/.test(token))) throw new Error('CLOUDFLARE_API_TOKEN must be one nonempty line.');
  const { CLOUDFLARE_API_TOKEN: _ignored, ...runtimeValues } = values;
  const validated = validateCiValues(runtimeValues, mode, root);
  return { mode, file, token, serialized: validated.serialized, values: validated.values };
}

function checkDistinctEnvironments(modes) {
  const production = modes.find(item => item.mode === 'production')?.values;
  const preview = modes.find(item => item.mode === 'preview')?.values;
  if (!production || !preview) return;
  const resourceKeys = ['WORKER_NAME', 'D1_DATABASE_ID', 'D1_DATABASE_NAME', 'EMAIL_QUEUE_NAME', 'EMAIL_DEAD_LETTER_QUEUE_NAME'];
  if (production.R2_ENABLED === 'true' && preview.R2_ENABLED === 'true') resourceKeys.push('R2_BUCKET_NAME');
  for (const key of [...resourceKeys, 'ADMIN_PASSWORD', 'SESSION_SECRET']) {
    if (production[key] && preview[key] && production[key] === preview[key]) {
      throw new Error(`Production and preview environments must use different ${key} values.`);
    }
  }
}

export function configureCi({ repo, modes, disable = false, disableCi = false, dryRun = false, ghPath = 'gh', env = process.env } = {}) {
  const targetRepo = validateRepo(repo);
  const options = { ghPath, env };
  if (disableCi) {
    if (dryRun) return { disabledCi: true };
    setVariable(targetRepo, null, 'MAILCHEAP_CI_ENABLED', 'false', options);
    return { disabledCi: true };
  }
  if (disable) {
    if (dryRun) return { disabledDeployments: true };
    setVariable(targetRepo, null, 'MAILCHEAP_DEPLOY_PRODUCTION', 'false', options);
    setVariable(targetRepo, null, 'MAILCHEAP_DEPLOY_PREVIEWS', 'false', options);
    return { disabledDeployments: true };
  }
  if (!modes?.length) throw new Error('Select at least one environment file or use --disable.');
  if (!dryRun) for (const mode of modes) if (!mode.token) throw new Error(`Set CLOUDFLARE_API_TOKEN in the ${mode.mode} environment file or shell environment.`);
  checkDistinctEnvironments(modes);
  if (dryRun) return { planned: modes.map(({ mode }) => mode) };

  // Stop deployments before touching credentials. Opt-ins are enabled only
  // after both secrets for every selected environment have been uploaded.
  setVariable(targetRepo, null, 'MAILCHEAP_DEPLOY_PRODUCTION', 'false', options);
  setVariable(targetRepo, null, 'MAILCHEAP_DEPLOY_PREVIEWS', 'false', options);
  ensureEnvironments(targetRepo, options);
  for (const mode of modes) {
    setSecret(targetRepo, mode.mode, 'MAILCHEAP_ENV', mode.serialized, options);
    setSecret(targetRepo, mode.mode, 'CLOUDFLARE_API_TOKEN', mode.token, options);
  }
  for (const mode of modes) {
    setVariable(targetRepo, null, mode.mode === 'production' ? 'MAILCHEAP_DEPLOY_PRODUCTION' : 'MAILCHEAP_DEPLOY_PREVIEWS', 'true', options);
  }
  setVariable(targetRepo, null, 'MAILCHEAP_CI_ENABLED', 'true', options);
  return { configured: modes.map(({ mode }) => mode) };
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();
  const flags = parseFlags(args);
  if (flags.help) {
    console.log('pnpm run setup:ci -- --repo owner/name [--production-file .env] [--preview-file .env.preview] [--dry-run]\npnpm run setup:ci -- --repo owner/name --disable\npnpm run setup:ci -- --repo owner/name --disable-ci');
    return;
  }
  const repo = validateRepo(flags.repo);
  if (flags.disable || flags['disable-ci']) {
    const result = configureCi({ repo, disable: flags.disable, disableCi: flags['disable-ci'], dryRun: flags['dry-run'] });
    if (flags['dry-run']) {
      console.log(flags['disable-ci'] ? 'Dry run: set MAILCHEAP_CI_ENABLED=false.' : 'Dry run: set both deployment opt-ins to false.');
      return;
    }
    console.log(result.disabledCi ? 'GitHub Actions checks and deployments are disabled.' : 'Automated deployments are disabled.');
    return;
  }
  const modes = [];
  if (flags['production-file'] !== undefined) modes.push(loadMode(flags['production-file'], 'production'));
  if (flags['preview-file'] !== undefined) modes.push(loadMode(flags['preview-file'], 'preview'));
  if (!modes.length) modes.push(loadMode('.env', 'production'));
  const result = configureCi({ repo, modes, dryRun: flags['dry-run'] });
  if (flags['dry-run']) console.log(`Dry run: validate and configure ${result.planned.join(', ')} GitHub deployment environment(s); values are not displayed.`);
  else console.log(`Configured GitHub environments: ${result.configured.join(', ')}. Deployment opt-ins were enabled.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
