import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { command, deploymentSecrets, validateDeployConfig, wrangler } from './setup-common.mjs';
import { projectEnvironment, loadRuntimeConfig, cloudflareCredentials } from './project-config.mjs';
import { readCloudflareAuth } from './setup-cloudflare.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: flags } = parseArgs({ options: { 'dry-run': { type: 'boolean' }, 'env-file': { type: 'string' }, help: { type: 'boolean' } } });

async function main() {
  if (flags.help) { console.log('pnpm deploy\npnpm run deploy [--dry-run] [--env-file .env]\nReads private .env IDs/settings, builds, migrates remote D1 and deploys code/secrets.\n--dry-run skips remote migrations and does not upload anything.\nUse pnpm run when passing options, so pnpm forwards them to the script.'); return; }
  if (process.env.CLOUDFLARE_ENV) throw new Error('This deploy command uses the top-level configuration; unset CLOUDFLARE_ENV first.');
  const { file, values } = projectEnvironment(root, flags['env-file']);
  const secrets = deploymentSecrets(values);
  const { config, configPath } = loadRuntimeConfig(root, { file });
  validateDeployConfig(config, secrets, { dryRun: flags['dry-run'] });
  const env = { ...cloudflareCredentials(values), ...(config.account_id ? { CLOUDFLARE_ACCOUNT_ID: config.account_id } : {}), MAILCHEAP_ENV_FILE: file, CI: 'true' };
  if (!flags['dry-run']) {
    const { accounts } = await readCloudflareAuth(args => wrangler(root, args, { capture: true, env }));
    if (!accounts.some(({ id }) => id === config.account_id)) throw new Error('The configured account is not accessible with this Wrangler login.');
    console.log(`Deploying ${config.name} to account ${config.account_id} with secrets from ${path.relative(root, file)}.`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-deploy-'));
  const secretsPath = path.join(temporary, 'secrets.json');
  try {
    fs.writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    await command(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: root, env });
    if (!flags['dry-run']) await wrangler(root, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath], { env });
    await wrangler(root, ['deploy', '--config', 'dist/server/wrangler.json', '--secrets-file', secretsPath, ...(flags['dry-run'] ? ['--dry-run'] : [])], { env });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
