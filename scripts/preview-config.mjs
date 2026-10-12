import { validateSecrets } from './setup-common.mjs';

const PREVIEW_MARKER = /(?:^|-)preview(?:-|$)/;
const PREVIEW_SECRET_KEYS = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET'];

function requirePreviewName(value, label, { suffix = false } = {}) {
  const valid = typeof value === 'string' && (suffix
    ? /^[a-z][a-z0-9-]{0,44}$/.test(value) && value.endsWith('-preview')
    : /^[a-z0-9][a-z0-9_-]{0,62}$/.test(value) && PREVIEW_MARKER.test(value));
  if (!valid) {
    throw new Error(`${label} must include the '-preview' segment.`);
  }
}

/** Validate that this private environment can only target preview resources. */
export function validatePreviewEnvironment(config, values) {
  if (values.DEPLOYMENT_ENVIRONMENT !== 'preview') {
    throw new Error('Preview deployment requires DEPLOYMENT_ENVIRONMENT=preview in the selected private environment file.');
  }

  const workerName = values.WORKER_NAME || config.name;
  requirePreviewName(workerName, 'WORKER_NAME', { suffix: true });
  if (config.name !== workerName) throw new Error('Generated Worker name does not match WORKER_NAME.');
  if (!/^[a-f0-9]{32}$/i.test(config.account_id || '')) throw new Error('Set CLOUDFLARE_ACCOUNT_ID in the preview environment.');
  if (values.CLOUDFLARE_ACCOUNT_ID !== config.account_id) throw new Error('Generated account does not match CLOUDFLARE_ACCOUNT_ID.');

  const database = config.d1_databases?.find(item => item.binding === 'DB');
  if (!database?.database_id || !/^[a-f0-9-]{36}$/i.test(database.database_id) || /^0+$/.test(database.database_id.replaceAll('-', ''))) {
    throw new Error('Set a provisioned preview D1_DATABASE_ID.');
  }
  if (database.database_id !== values.D1_DATABASE_ID) throw new Error('Generated D1 database ID does not match D1_DATABASE_ID.');
  const databaseName = values.D1_DATABASE_NAME || database.database_name;
  requirePreviewName(databaseName, 'D1_DATABASE_NAME');
  if (database.database_name !== databaseName) throw new Error('Generated D1 database name does not match D1_DATABASE_NAME.');

  const r2Enabled = values.R2_ENABLED === 'true';
  if (!['true', 'false'].includes(values.R2_ENABLED)) throw new Error('Set R2_ENABLED to true or false in the preview environment.');
  const bucket = config.r2_buckets?.find(item => item.binding === 'IMAGES');
  if (r2Enabled) {
    if (!bucket) throw new Error('R2 is enabled but the generated IMAGES binding is missing.');
    const bucketName = values.R2_BUCKET_NAME || bucket.bucket_name;
    requirePreviewName(bucketName, 'R2_BUCKET_NAME');
    if (bucket.bucket_name !== bucketName) throw new Error('Generated R2 bucket name does not match R2_BUCKET_NAME.');
  } else if (bucket) {
    throw new Error('R2 is disabled but the generated IMAGES binding is present.');
  }

  const producer = config.queues?.producers?.find(item => item.binding === 'EMAIL_QUEUE');
  const queueName = values.EMAIL_QUEUE_NAME || producer?.queue;
  requirePreviewName(queueName, 'EMAIL_QUEUE_NAME');
  if (!producer || producer.queue !== queueName) throw new Error('Generated email Queue does not match EMAIL_QUEUE_NAME.');
  const consumer = config.queues?.consumers?.find(item => item.queue === queueName);
  const deadLetterName = values.EMAIL_DEAD_LETTER_QUEUE_NAME || consumer?.dead_letter_queue;
  requirePreviewName(deadLetterName, 'EMAIL_DEAD_LETTER_QUEUE_NAME');
  if (!consumer || consumer.dead_letter_queue !== deadLetterName) throw new Error('Generated dead-letter Queue does not match EMAIL_DEAD_LETTER_QUEUE_NAME.');

  return { workerName, databaseName, queueName, deadLetterName, r2Enabled };
}

/** Return only the preview login/session secrets; never forward SES credentials. */
export function previewSecrets(values) {
  validateSecrets(values);
  return Object.fromEntries(PREVIEW_SECRET_KEYS.map(key => [key, values[key]]));
}

/**
 * Convert a normal generated config into a Preview-only safe config.
 * Preview settings are explicit because Wrangler does not inherit production
 * vars or bindings into a Preview deployment.
 */
export function createPreviewConfig(config) {
  const result = structuredClone(config);
  const safeVars = {
    ...(result.vars || {}),
    APP_URL: 'https://preview.invalid',
    SENDING_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_ENABLED: 'false',
    TRANSACTIONAL_EMAIL_FROM: '',
    SES_CONFIGURATION_SET: '',
    SES_SNS_TOPIC_ARN: '',
  };
  for (const key of [
    'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'SESSION_SECRET',
    'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
    'SES_ACCESS_KEY_ID', 'SES_SECRET_ACCESS_KEY', 'SES_SESSION_TOKEN',
    'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'D1_DATABASE_ID', 'D1_DATABASE_NAME',
    'R2_BUCKET_NAME', 'EMAIL_QUEUE_NAME', 'EMAIL_DEAD_LETTER_QUEUE_NAME', 'WORKER_NAME',
  ]) delete safeVars[key];
  const databaseBindings = (result.d1_databases || []).filter(item => item.binding === 'DB');
  const imageBindings = (result.r2_buckets || []).filter(item => item.binding === 'IMAGES');
  const producers = (result.queues?.producers || []).filter(item => item.binding === 'EMAIL_QUEUE');

  // This config belongs to the isolated parent Worker. Its top-level settings
  // are safe too, so an accidental normal deploy cannot target production.
  result.vars = safeVars;
  result.queues = { producers };
  delete result.triggers;
  delete result.send_email;
  delete result.route;
  delete result.routes;
  delete result.custom_domains;
  result.workers_dev = true;
  result.preview_urls = true;
  result.previews = {
    vars: { ...safeVars },
    d1_databases: databaseBindings,
    r2_buckets: imageBindings,
    queues: { producers: structuredClone(producers) },
  };

  return result;
}

export function previewUrlFromOutput(output) {
  let result;
  try { result = JSON.parse(output); }
  catch { throw new Error('Wrangler did not return valid Preview JSON.'); }
  const url = result?.preview?.urls?.find(value => typeof value === 'string' && /^https:\/\//.test(value));
  if (!url) throw new Error('Wrangler Preview JSON did not include an HTTPS Preview URL.');
  return url;
}
