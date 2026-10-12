import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { command, readConfig, SECRET_KEYS, validateDeployConfig, wrangler } from './setup-common.mjs';
import { projectEnvironment, loadRuntimeConfig, resolveConfig, cloudflareCredentials } from './project-config.mjs';
import { readCloudflareAuth } from './setup-cloudflare.mjs';
import { createPreviewConfig, previewSecrets, previewUrlFromOutput, validatePreviewEnvironment } from './preview-config.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const scriptArgs = process.argv.slice(2);
if (scriptArgs[0] === '--') scriptArgs.shift();
const { values: flags } = parseArgs({ args: scriptArgs, options: {
  name: { type: 'string' }, 'env-file': { type: 'string' }, 'dry-run': { type: 'boolean' },
  delete: { type: 'boolean' }, help: { type: 'boolean' },
} });
const API = 'https://api.cloudflare.com/client/v4';

function requirePreviewName(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,57}$/.test(value || '')) throw new Error('Pass --name with a lowercase Preview slug such as pr-123.');
}

async function cloudflareIdentity(root, env, accountId) {
  const identity = await readCloudflareAuth(args => wrangler(root, args, { capture: true, env }));
  if (!identity.accounts.some(({ id }) => id === accountId)) throw new Error('The configured Cloudflare account is not accessible with this Wrangler login.');
  return identity;
}

async function previewExists({ accountId, workerName, previewName, token }) {
  const url = `${API}/accounts/${accountId}/workers/workers/${encodeURIComponent(workerName)}/previews/${encodeURIComponent(previewName)}`;
  let response;
  let body;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    body = await response.json();
  } catch {
    throw new Error('Could not check whether the Cloudflare Preview exists. Retry cleanup.');
  }
  if (response.status === 404 && body.errors?.some(({ code }) => code === 10025)) return false;
  if (!response.ok || body.success !== true) throw new Error(`Cloudflare Preview lookup failed (HTTP ${response.status}).`);
  return true;
}

function writeGithubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`, { mode: 0o600 });
}

function writeBuildEnvironment(directory, values) {
  const buildValues = {
    CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
    WORKER_NAME: values.WORKER_NAME,
    DEPLOYMENT_ENVIRONMENT: 'preview',
    D1_DATABASE_ID: values.D1_DATABASE_ID,
    D1_DATABASE_NAME: values.D1_DATABASE_NAME,
    R2_ENABLED: values.R2_ENABLED,
    ...(values.R2_ENABLED === 'true' ? { R2_BUCKET_NAME: values.R2_BUCKET_NAME } : {}),
    EMAIL_QUEUE_NAME: values.EMAIL_QUEUE_NAME,
    EMAIL_DEAD_LETTER_QUEUE_NAME: values.EMAIL_DEAD_LETTER_QUEUE_NAME,
    APP_URL: 'https://preview.invalid',
    LOCAL_APP_URL: 'http://localhost:3000',
    SENDING_ENABLED: 'false',
    LOCAL_SENDING_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_FROM: '',
    LOCAL_TRANSACTIONAL_EMAIL_ENABLED: 'false',
    AWS_REGION: 'us-east-1',
    SES_REGION: '',
    SES_CONFIGURATION_SET: '',
    SES_SNS_TOPIC_ARN: '',
    SEND_RATE_PER_SECOND: '1',
    ARCHIVE_HOSTS: '',
    ALERT_FROM: '',
    CUSTOM_DOMAIN: '',
    // Blank entries override same-named shell variables while the build
    // config is generated. They are never written to the Worker config.
    ...Object.fromEntries(SECRET_KEYS.map(key => [key, ''])),
    CLOUDFLARE_API_TOKEN: '',
  };
  const lines = Object.entries(buildValues).map(([key, value]) => {
    const text = String(value ?? '');
    if (/[\r\n']/.test(text)) throw new Error(`Preview environment value ${key} contains unsupported characters.`);
    return `${key}='${text}'`;
  });
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
  return file;
}

async function run() {
  if (flags.help) {
    console.log('pnpm run preview:deploy -- --name pr-123 [--env-file .env.preview] [--dry-run]\npnpm run preview:deploy -- --name pr-123 --delete [--env-file .env.preview]\nUses a separate Worker and preview-only resources. Preview deployments share those test resources.');
    return;
  }
  if (process.env.CLOUDFLARE_ENV) throw new Error('Preview scripts use the selected private environment file; unset CLOUDFLARE_ENV first.');
  requirePreviewName(flags.name);
  if (flags.delete && flags['dry-run']) throw new Error('Choose --delete or --dry-run, not both.');

  const { file, values } = projectEnvironment(root, flags['env-file'] || process.env.MAILCHEAP_ENV_FILE || '.env.preview');
  const previewValues = {
    ...values,
    APP_URL: 'https://preview.invalid',
    SENDING_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_FROM: '',
  };
  const initialConfig = resolveConfig(readConfig(root).config, previewValues);
  const target = validatePreviewEnvironment(initialConfig, values);
  const secrets = previewSecrets(values);
  const env = {
    ...cloudflareCredentials(values),
    CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID,
    ...Object.fromEntries(SECRET_KEYS.map(key => [key, ''])),
    CI: 'true',
  };
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mailcheap-preview-'));
  try {
    const buildEnvFile = writeBuildEnvironment(temporary, values);
    const { config, configPath } = loadRuntimeConfig(root, { file: buildEnvFile });
    validateDeployConfig(config, values, { dryRun: flags['dry-run'], target: 'preview' });

    if (flags.delete) {
      const identity = await cloudflareIdentity(root, env, config.account_id);
      if (!await previewExists({ accountId: config.account_id, workerName: target.workerName, previewName: flags.name, token: identity.token })) {
        console.log(`Preview ${flags.name} does not exist on ${target.workerName}; nothing to delete.`);
        return;
      }
      await wrangler(root, ['preview', 'delete', '--name', flags.name, '--worker-name', target.workerName, '--skip-confirmation', '--config', configPath], { env });
      console.log(`Deleted Preview ${flags.name} from ${target.workerName}. Preview resources were left intact.`);
      return;
    }

    if (!flags['dry-run']) await cloudflareIdentity(root, env, config.account_id);

    const secretsPath = path.join(temporary, 'secrets.json');
    fs.writeFileSync(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
    await command(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), 'build'], {
      cwd: root,
      env: {
        CI: 'true',
        MAILCHEAP_ENV_FILE: buildEnvFile,
        ...Object.fromEntries(SECRET_KEYS.map(key => [key, ''])),
        CLOUDFLARE_API_TOKEN: '',
      },
    });

    const builtConfigPath = path.join(root, 'dist/server/wrangler.json');
    const builtConfig = JSON.parse(fs.readFileSync(builtConfigPath, 'utf8'));
    const safeConfig = createPreviewConfig(builtConfig);
    if (safeConfig.name !== target.workerName) throw new Error('Built Worker name does not match the selected preview environment.');
    validateDeployConfig(safeConfig, values, { dryRun: flags['dry-run'], target: 'preview' });
    fs.writeFileSync(builtConfigPath, `${JSON.stringify(safeConfig, null, 2)}\n`, { mode: 0o600 });

    if (flags['dry-run']) {
      await wrangler(root, ['deploy', '--config', builtConfigPath, '--dry-run'], { env });
      console.log(`Preview configuration is valid for ${target.workerName}. Dry run skipped authentication, migrations, and remote deployment.`);
      return;
    }

    await wrangler(root, ['d1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath], { env });
    const previewArgs = ['preview', '--name', flags.name, '--worker-name', target.workerName, '--config', builtConfigPath, '--secrets-file', secretsPath, '--json'];
    const firstOutput = await wrangler(root, previewArgs, { env, capture: true });
    const previewUrl = previewUrlFromOutput(firstOutput);

    // Re-submit with the final stable Preview URL as APP_URL. This keeps all
    // generated canonical, API, and action links inside this Preview.
    const finalOutput = await wrangler(root, [...previewArgs, '--var', `APP_URL:${previewUrl}`], { env, capture: true });
    const finalUrl = previewUrlFromOutput(finalOutput);
    writeGithubOutput('preview_url', finalUrl);
    console.log(`Preview deployed: ${finalUrl}`);
    const images = target.r2Enabled ? `; shared test image bucket: ${values.R2_BUCKET_NAME}` : '';
    console.log(`Worker: ${target.workerName}; shared test database: ${target.databaseName}${images}; producer queue: ${target.queueName}. Queue consumers and Cron do not run in Previews.`);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
