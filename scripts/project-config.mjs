import fs from 'node:fs';
import path from 'node:path';
import { environmentFile, readEnvironment, readConfig, SECRET_KEYS, SETTING_KEYS, PLACEHOLDER_ID } from './setup-common.mjs';

export const RESOURCE_KEYS = ['CLOUDFLARE_ACCOUNT_ID', 'WORKER_NAME', 'D1_DATABASE_ID', 'D1_DATABASE_NAME', 'R2_ENABLED', 'R2_BUCKET_NAME', 'EMAIL_QUEUE_NAME', 'EMAIL_DEAD_LETTER_QUEUE_NAME'];
const PUBLIC_KEYS = ['APP_URL', 'SENDING_ENABLED', ...SETTING_KEYS];
const ENV_KEYS = [...RESOURCE_KEYS, ...PUBLIC_KEYS, ...SECRET_KEYS, 'CLOUDFLARE_API_TOKEN', 'LOCAL_APP_URL', 'LOCAL_SENDING_ENABLED'];

export function projectEnvironment(root, requested) {
  const file = environmentFile(root, requested || process.env.MAILCHEAP_ENV_FILE);
  // A private file deliberately overrides public defaults and shell IDs. Shell
  // values remain useful for CI when a key is absent from the selected file.
  const shell = Object.fromEntries(ENV_KEYS.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
  const privateValues = readEnvironment(file);
  const selected = Object.fromEntries(ENV_KEYS.filter(key => privateValues[key] !== undefined).map(key => [key, privateValues[key]]));
  return { file, values: { ...shell, ...selected } };
}

export function resolveConfig(base, values, { local = false } = {}) {
  const config = structuredClone(base);
  const renamed = Boolean(values.WORKER_NAME && values.WORKER_NAME !== base.name);
  config.name = values.WORKER_NAME || config.name;
  if (!/^[a-z][a-z0-9-]{0,44}$/.test(config.name)) throw new Error('WORKER_NAME must be 1–45 lowercase letters, numbers or hyphens, starting with a letter.');
  if (values.CLOUDFLARE_ACCOUNT_ID) config.account_id = values.CLOUDFLARE_ACCOUNT_ID;
  const database = config.d1_databases?.find(item => item.binding === 'DB');
  if (!database) throw new Error('wrangler.jsonc must declare the DB binding.');
  database.database_name = values.D1_DATABASE_NAME || (renamed ? config.name : database.database_name);
  database.database_id = values.D1_DATABASE_ID || (renamed ? PLACEHOLDER_ID : database.database_id);

  if (values.R2_ENABLED && !['true', 'false'].includes(values.R2_ENABLED)) throw new Error('R2_ENABLED must be true or false.');
  const images = config.r2_buckets?.find(item => item.binding === 'IMAGES');
  const useImages = values.R2_ENABLED ? values.R2_ENABLED === 'true' : Boolean(images);
  config.r2_buckets = (config.r2_buckets || []).filter(item => item.binding !== 'IMAGES');
  if (useImages) config.r2_buckets.push({ ...images, binding: 'IMAGES', bucket_name: values.R2_BUCKET_NAME || (!renamed && images?.bucket_name) || `${config.name}-images` });

  const producer = config.queues?.producers?.find(item => item.binding === 'EMAIL_QUEUE');
  if (!producer) throw new Error('wrangler.jsonc must declare the EMAIL_QUEUE binding.');
  const consumer = config.queues.consumers.find(item => item.queue === producer.queue);
  if (!consumer) throw new Error('wrangler.jsonc must declare the email queue consumer.');
  producer.queue = values.EMAIL_QUEUE_NAME || (renamed ? `${config.name}-email` : producer.queue);
  consumer.queue = producer.queue;
  consumer.dead_letter_queue = values.EMAIL_DEAD_LETTER_QUEUE_NAME || (renamed ? `${config.name}-email-dead-letter` : consumer.dead_letter_queue);

  config.vars ??= {};
  for (const key of PUBLIC_KEYS) if (values[key] !== undefined && (key !== 'APP_URL' || values[key])) config.vars[key] = values[key];
  if (local) {
    config.vars.APP_URL = values.LOCAL_APP_URL || 'http://localhost:3000';
    config.vars.SENDING_ENABLED = values.LOCAL_SENDING_ENABLED || 'false';
  }
  if (!['true', 'false'].includes(config.vars.SENDING_ENABLED)) throw new Error('SENDING_ENABLED must be true or false.');
  // Even an accidentally copied secret in the template must not enter a build.
  for (const key of [...SECRET_KEYS, ...RESOURCE_KEYS, 'CLOUDFLARE_API_TOKEN']) delete config.vars[key];
  return config;
}

export function resourceEnvironment(config) {
  const database = config.d1_databases.find(item => item.binding === 'DB');
  const images = config.r2_buckets?.find(item => item.binding === 'IMAGES');
  const producer = config.queues.producers.find(item => item.binding === 'EMAIL_QUEUE');
  const consumer = config.queues.consumers.find(item => item.queue === producer.queue);
  return {
    CLOUDFLARE_ACCOUNT_ID: config.account_id || '', WORKER_NAME: config.name,
    D1_DATABASE_NAME: database.database_name, D1_DATABASE_ID: database.database_id === PLACEHOLDER_ID ? '' : database.database_id,
    R2_ENABLED: String(Boolean(images)), ...(images ? { R2_BUCKET_NAME: images.bucket_name } : {}),
    EMAIL_QUEUE_NAME: producer.queue, EMAIL_DEAD_LETTER_QUEUE_NAME: consumer.dead_letter_queue,
  };
}

function dotenvValue(value) {
  const text = String(value);
  for (const quote of ["'", '`', '"']) {
    if (!text.includes(quote) && (quote !== '"' || !/\\[nr]/.test(text))) return `${quote}${text}${quote}`;
  }
  throw new Error('A runtime secret contains an unsupported combination of quotes for the local environment file.');
}

// The shared Wrangler template is never modified. CLI and Vite consume this
// ignored file, with paths anchored to the repository and only public vars.
export function writeRuntimeConfig(root, config, values, { local = false } = {}) {
  const directory = path.join(root, '.wrangler', 'mailcheap', local ? 'local' : 'production');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const generated = structuredClone(config);
  delete generated.$schema;
  generated.main = path.resolve(root, generated.main);
  if (generated.assets?.directory) generated.assets.directory = path.resolve(root, generated.assets.directory);
  for (const database of generated.d1_databases || []) database.migrations_dir = path.resolve(root, database.migrations_dir || 'migrations');
  const configPath = path.join(directory, 'wrangler.json');
  fs.writeFileSync(configPath, JSON.stringify(generated, null, 2), { mode: 0o600 });
  // Use a filtered .dev.vars next to the generated config so legacy root
  // .dev.vars cannot shadow .env, or bind deployment API tokens into the app.
  const devValues = { ...config.vars, APP_URL: values.LOCAL_APP_URL || 'http://localhost:3000', SENDING_ENABLED: values.LOCAL_SENDING_ENABLED || 'false' };
  for (const key of SECRET_KEYS) if (values[key]) devValues[key] = values[key];
  const varsPath = path.join(directory, '.dev.vars');
  fs.writeFileSync(varsPath, Object.entries(devValues).map(([key, value]) => `${key}=${dotenvValue(value)}`).join('\n') + '\n', { mode: 0o600 });
  fs.chmodSync(configPath, 0o600);
  fs.chmodSync(varsPath, 0o600);
  return configPath;
}

export function loadRuntimeConfig(root, { file, local = false } = {}) {
  if (process.env.CLOUDFLARE_ENV) throw new Error('Project scripts use the top-level configuration; unset CLOUDFLARE_ENV first.');
  const { values } = projectEnvironment(root, file);
  const config = resolveConfig(readConfig(root).config, values, { local });
  return { config, values, configPath: writeRuntimeConfig(root, config, values, { local }) };
}

export function cloudflareCredentials(values) {
  return {
    ...(values.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: values.CLOUDFLARE_ACCOUNT_ID } : {}),
    ...(values.CLOUDFLARE_API_TOKEN ? { CLOUDFLARE_API_TOKEN: values.CLOUDFLARE_API_TOKEN } : {}),
  };
}
