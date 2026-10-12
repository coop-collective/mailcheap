import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { prepareEnvironment, saveEnvironment, readConfig, wrangler, publicAppUrl, SETTING_KEYS } from './setup-common.mjs';
import { projectEnvironment, resolveConfig, resourceEnvironment, writeRuntimeConfig, cloudflareCredentials } from './project-config.mjs';
import { readCloudflareAuth, provisionCloudflare } from './setup-cloudflare.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { values: flags } = parseArgs({ args: process.argv.slice(process.argv[2] === '--' ? 3 : 2), options: {
  local: { type: 'boolean' }, cloudflare: { type: 'boolean' }, email: { type: 'string' }, account: { type: 'string' }, name: { type: 'string' },
  'app-url': { type: 'string' }, 'skip-r2': { type: 'boolean' }, 'env-file': { type: 'string' }, help: { type: 'boolean' },
} });

async function ask(question, fallback) {
  if (!process.stdin.isTTY) {
    if (fallback !== undefined) return fallback;
    throw new Error(question + ' Set it in .env or supply the corresponding flag in noninteractive runs.');
  }
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await input.question(question + (fallback ? ' [' + fallback + ']' : '') + ': ')).trim() || fallback; }
  finally { input.close(); }
}

async function migrateLocal(config, values) {
  const localConfig = resolveConfig(config, values, { local: true });
  const configPath = writeRuntimeConfig(root, localConfig, values, { local: true });
  await wrangler(root, ['d1', 'migrations', 'apply', 'DB', '--local', '--config', configPath, '--persist-to', '.wrangler/state'], { env: { CI: 'true' } });
}

async function main() {
  if (flags.help) {
    console.log('pnpm setup\npnpm run setup -- [--email you@example.com] [--env-file .env]\npnpm run setup --local\n\nGuided setup reads private .env overrides, creates/reuses Cloudflare D1, R2 and\nqueues, and saves their IDs/names to .env. Public wrangler.jsonc stays unchanged.\n--local skips Cloudflare login and provisioning. Both modes generate missing\nlogin/signing secrets and apply local migrations. Run pnpm deploy to publish.\nOptional: --account ID --name NAME --app-url https://mail.example.com --skip-r2\nUse pnpm run when passing options, so pnpm forwards them to the script.\nNo setup command enables sending or changes AWS.');
    return;
  }
  if (process.env.CLOUDFLARE_ENV) throw new Error('Setup uses the top-level configuration; unset CLOUDFLARE_ENV first.');
  if (flags.local && flags.cloudflare) throw new Error('Choose --local or --cloudflare, not both.');
  if (flags.local && (flags.account || flags['app-url'])) throw new Error('Account and public URL flags require cloud setup; omit --local.');
  if (flags['app-url']) publicAppUrl(flags['app-url']);
  const { config: base } = readConfig(root);
  const { file, values: initial } = projectEnvironment(root, flags['env-file']);
  const email = flags.email || initial.ADMIN_EMAIL || await ask('Admin login email (--email)');
  const defaults = Object.fromEntries(SETTING_KEYS.filter(key => initial[key] !== undefined || base.vars?.[key] !== undefined).map(key => [key, initial[key] ?? base.vars[key]]));
  const prepared = prepareEnvironment(root, { file, email, defaults });
  const values = { ...initial, ...prepared.values };
  if (flags.local ? values.LOCAL_TRANSACTIONAL_EMAIL_ENABLED === 'true' : values.TRANSACTIONAL_EMAIL_ENABLED === 'true') {
    console.log(`Transactional email is enabled; verify ${values.TRANSACTIONAL_EMAIL_FROM} in Cloudflare Email Service before sending.`);
  }
  if (flags.name) values.WORKER_NAME = flags.name;
  if (flags.account) values.CLOUDFLARE_ACCOUNT_ID = flags.account;
  if (flags['app-url']) values.APP_URL = flags['app-url'];
  if (flags['skip-r2']) values.R2_ENABLED = 'false';
  console.log('Private settings: ' + path.relative(root, file) + ' (owner-only access). Read ADMIN_PASSWORD there to log in; existing credentials are preserved.');

  if (flags.local) {
    const config = resolveConfig(base, values, { local: true });
    saveEnvironment(file, { ...prepared.values, ...resourceEnvironment(config) });
    await migrateLocal(base, values);
    console.log('Local setup complete. Run pnpm dev. No cloud resources were created.');
    return;
  }

  if (!values.WORKER_NAME) values.WORKER_NAME = await ask('Worker name (--name)', base.name);
  let config = resolveConfig(base, values);
  const defaultsForResources = resourceEnvironment(config);
  for (const key of ['D1_DATABASE_NAME', 'R2_BUCKET_NAME', 'EMAIL_QUEUE_NAME', 'EMAIL_DEAD_LETTER_QUEUE_NAME']) {
    if (values[key] || (key === 'D1_DATABASE_NAME' && values.D1_DATABASE_ID) || (key === 'R2_BUCKET_NAME' && defaultsForResources.R2_ENABLED === 'false')) continue;
    values[key] = await ask(key, defaultsForResources[key]);
  }
  config = resolveConfig(base, values);
  const authEnv = cloudflareCredentials(values);
  let identity;
  try { identity = await readCloudflareAuth(args => wrangler(root, args, { capture: true, env: authEnv })); }
  catch (error) {
    if (!process.stdin.isTTY || authEnv.CLOUDFLARE_API_TOKEN) throw error;
    console.log('Opening Wrangler login for Cloudflare authentication.');
    await wrangler(root, ['login']);
    identity = await readCloudflareAuth(args => wrangler(root, args, { capture: true }));
  }
  const { accounts, token } = identity;
  let accountId = values.CLOUDFLARE_ACCOUNT_ID || config.account_id;
  if (!accountId && accounts.length === 1) accountId = accounts[0].id;
  if (!accountId) {
    console.log(accounts.map(({ id, name }) => id + '  ' + name).join('\n'));
    accountId = await ask('Cloudflare account ID (--account)');
  }
  if (!accounts.some(({ id }) => id === accountId)) throw new Error('The selected account is not accessible with this Wrangler login.');
  config.account_id = accountId;
  const requestedUrl = values.APP_URL?.startsWith('https://') ? publicAppUrl(values.APP_URL) : (config.vars.APP_URL?.startsWith('https://') ? publicAppUrl(config.vars.APP_URL) : null);
  const selectedResources = resourceEnvironment(config);
  if (values.D1_DATABASE_ID && !values.D1_DATABASE_NAME) delete selectedResources.D1_DATABASE_NAME;
  saveEnvironment(file, { ...selectedResources, ...(requestedUrl ? { APP_URL: requestedUrl } : {}) });
  console.log('Checking resources for Worker ' + config.name + ' in account ' + accountId + '.');
  const result = await provisionCloudflare({ accountId, config, token, databaseNamesFromIds: !values.D1_DATABASE_NAME });
  // Save resource IDs before prompting for a URL so interruption is recoverable.
  Object.assign(values, resourceEnvironment(result.config));
  saveEnvironment(file, { ...prepared.values, ...resourceEnvironment(result.config) });
  values.APP_URL = requestedUrl || (result.workersSubdomain ? 'https://' + config.name + '.' + result.workersSubdomain + '.workers.dev' : publicAppUrl(await ask('Public HTTPS app URL (--app-url)')));
  saveEnvironment(file, { APP_URL: values.APP_URL });
  await migrateLocal(base, values);
  console.log('Setup complete. Resource IDs and names saved to ' + path.relative(root, file) + '. App URL: ' + values.APP_URL);
  console.log('Run pnpm deploy to build, migrate remote D1 and upload code with secrets. SES/DNS setup is described in README.md.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
