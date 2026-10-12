import { fileURLToPath } from 'node:url';
import { loadRuntimeConfig, cloudflareCredentials } from './project-config.mjs';
import { validateDeployConfig, wrangler } from './setup-common.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
try {
  if (args.some(arg => ['--env', '-e', '--config', '-c'].includes(arg) || arg.startsWith('--config=') || arg.startsWith('--env='))) throw new Error('Use the private .env to select this installation, not --env or --config.');
  const local = args.includes('--local');
  const { config, values, configPath } = loadRuntimeConfig(root, { local });
  if (args.includes('--remote')) validateDeployConfig(config, values, { target: values.DEPLOYMENT_ENVIRONMENT || 'production' });
  if (local && !args.some(arg => arg === '--persist-to' || arg.startsWith('--persist-to='))) args.push('--persist-to', '.wrangler/state');
  await wrangler(root, [...args, '--config', configPath], { env: { ...cloudflareCredentials(values), ...(config.account_id ? { CLOUDFLARE_ACCOUNT_ID: config.account_id } : {}) } });
} catch (error) { console.error(error.message); process.exitCode = 1; }
