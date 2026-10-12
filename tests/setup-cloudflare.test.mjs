import assert from 'node:assert/strict';
import test from 'node:test';
import { provisionCloudflare, readCloudflareAuth } from '../scripts/setup-cloudflare.mjs';
import { PLACEHOLDER_ID } from '../scripts/setup-common.mjs';

const accountId = 'a'.repeat(32);
const token = 'fake-test-token-never-log';
const databaseId = '11111111-2222-4333-8444-555555555555';
const configuration = () => ({
  name: 'mailcheap',
  d1_databases: [{ binding: 'DB', database_name: 'mailcheap', database_id: PLACEHOLDER_ID }],
  r2_buckets: [{ binding: 'IMAGES', bucket_name: 'mailcheap-images' }],
  queues: {
    producers: [{ binding: 'EMAIL_QUEUE', queue: 'mailcheap-email' }],
    consumers: [{ queue: 'mailcheap-email', dead_letter_queue: 'mailcheap-email-dead-letter' }],
  },
  vars: { SENDING_ENABLED: 'false' },
});

const success = (result, result_info = {}) => Response.json({ success: true, result, result_info });
const failure = (status, message, code = 10000) => Response.json({ success: false, errors: [{ code, message }] }, { status });

function cloudflare({ intercept } = {}) {
  const state = { databases: [], buckets: [], queues: [], calls: [], logs: [] };
  const fetcher = async (input, options) => {
    const url = new URL(input);
    assert.equal(url.origin, 'https://api.cloudflare.com');
    assert.ok(url.pathname.startsWith(`/client/v4/accounts/${accountId}`));
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
    assert.equal(options.redirect, 'error');
    const route = url.pathname.slice(`/client/v4/accounts/${accountId}`.length);
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { route, query: url.searchParams, method: options.method, body, headers: options.headers };
    state.calls.push(call);
    const intercepted = await intercept?.(call, state);
    if (intercepted) return intercepted;
    if (options.method === 'GET') {
      if (route === '') return success({ id: accountId });
      if (route === '/workers/subdomain') return success({ subdomain: 'my-account' });
      if (route === '/d1/database') return success(state.databases, { total_pages: 1 });
      if (route === '/r2/buckets') return success({ buckets: state.buckets });
      if (route === '/queues') return success(state.queues, { total_pages: 1 });
    }
    if (options.method === 'POST') {
      if (route === '/d1/database') {
        const database = { ...body, uuid: databaseId };
        state.databases.push(database);
        return success(database);
      }
      if (route === '/r2/buckets') { state.buckets.push(body); return success(body); }
      if (route === '/queues') { state.queues.push(body); return success(body); }
    }
    throw new Error(`Unexpected request ${options.method} ${route}`);
  };
  return { state, run: (config, options = {}) => provisionCloudflare({ config, accountId, token, fetcher, log: message => state.logs.push(message), ...options }) };
}

test('Wrangler identity refresh precedes token lookup and auth failures never expose captured output', async () => {
  const calls = [];
  const result = await readCloudflareAuth(async args => {
    calls.push(args);
    return JSON.stringify(args[0] === 'whoami' ? { loggedIn: true, accounts: [{ id: accountId, name: 'Example' }] } : { type: 'oauth', token });
  });
  assert.deepEqual(calls, [['whoami', '--json'], ['auth', 'token', '--json']]);
  assert.deepEqual(result, { accounts: [{ id: accountId, name: 'Example' }], token });
  await assert.rejects(readCloudflareAuth(async () => { throw new Error(token); }), error => {
    assert.match(error.message, /wrangler login/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  await assert.rejects(readCloudflareAuth(async args => JSON.stringify(args[0] === 'whoami'
    ? { loggedIn: true, accounts: [] } : { type: 'global_api_key', token })), /Global API keys/);
});

test('first setup creates D1, R2 and queues in dependency order; reruns reuse everything', async () => {
  const api = cloudflare();
  const original = configuration();
  const result = await api.run(original);
  assert.equal(original.d1_databases[0].database_id, PLACEHOLDER_ID);
  assert.equal(result.config.d1_databases[0].database_id, databaseId);
  assert.equal(result.config.account_id, accountId);
  assert.equal(result.config.vars.SENDING_ENABLED, 'false');
  assert.equal(result.workersSubdomain, 'my-account');
  const creations = () => api.state.calls.filter(call => call.method === 'POST');
  assert.deepEqual(creations().map(call => [call.route, call.body]), [
    ['/d1/database', { name: 'mailcheap' }],
    ['/r2/buckets', { name: 'mailcheap-images' }],
    ['/queues', { queue_name: 'mailcheap-email-dead-letter' }],
    ['/queues', { queue_name: 'mailcheap-email' }],
  ]);
  const rerun = await api.run(result.config);
  assert.deepEqual(rerun.config, result.config);
  assert.equal(creations().length, 4);
  assert.equal(api.state.logs.join('\n').includes(token), false);
});

test('pagination finds existing resources beyond the first page without creating duplicates', async () => {
  const api = cloudflare({ intercept: ({ route, query, method }) => {
    if (method !== 'GET') return;
    const first = query.get('page') === '1';
    if (route === '/d1/database') return success(first ? [{ name: 'another-db', uuid: 'another-id' }] : [{ name: 'mailcheap', uuid: databaseId }], { total_pages: 2 });
    if (route === '/queues') return success(first ? [{ queue_name: 'another-queue' }] : [{ queue_name: 'mailcheap-email' }, { queue_name: 'mailcheap-email-dead-letter' }], { total_pages: 2 });
    if (route === '/r2/buckets') return query.has('cursor')
      ? success({ buckets: [{ name: 'mailcheap-images' }] })
      : success({ buckets: [{ name: 'another-bucket' }] }, { cursor: 'next-page' });
  } });
  const result = await api.run(configuration());
  assert.equal(result.config.d1_databases[0].database_id, databaseId);
  assert.ok(api.state.calls.some(call => call.query.get('cursor') === 'next-page'));
  assert.equal(api.state.calls.filter(call => call.method === 'POST').length, 0);
});

test('omitting the image binding makes no R2 requests', async () => {
  const api = cloudflare();
  const config = configuration();
  config.r2_buckets = [];
  await api.run(config);
  assert.equal(api.state.calls.some(call => call.route.startsWith('/r2')), false);
});

test('a configured D1 ID from another account or name fails before any mutation', async () => {
  const api = cloudflare();
  const config = configuration();
  config.d1_databases[0].database_id = databaseId;
  api.state.databases.push({ name: 'someone-else', uuid: databaseId });
  await assert.rejects(api.run(config), /does not match/);
  assert.equal(api.state.calls.some(call => call.method === 'POST'), false);
});

test('setup can discover the database name from a supplied ID when no name was specified', async () => {
  const api = cloudflare();
  const config = configuration();
  config.d1_databases[0].database_id = databaseId;
  api.state.databases.push({ name: 'my-existing-db', uuid: databaseId });
  const result = await api.run(config, { databaseNamesFromIds: true });
  assert.equal(result.config.d1_databases[0].database_name, 'my-existing-db');
  assert.equal(api.state.calls.some(call => call.method === 'POST' && call.route === '/d1/database'), false);
});

test('permission failures during resource discovery stop before creating anything and redact tokens', async () => {
  const api = cloudflare({ intercept: ({ route }) => route === '/queues' ? failure(403, `Denied ${token}\n`) : undefined });
  await assert.rejects(api.run(configuration()), error => {
    assert.match(error.message, /HTTP 403/);
    assert.equal(error.message.includes(token), false);
    return true;
  });
  assert.equal(api.state.calls.some(call => call.method === 'POST'), false);
});

test('a partially failed setup reuses successful creates on the next attempt', async () => {
  let failOnce = true;
  const api = cloudflare({ intercept: ({ route, method }) => {
    if (route === '/queues' && method === 'POST' && failOnce) { failOnce = false; return failure(503, 'Temporary failure'); }
  } });
  await assert.rejects(api.run(configuration()), /HTTP 503/);
  const result = await api.run(configuration());
  assert.equal(result.config.d1_databases[0].database_id, databaseId);
  for (const route of ['/d1/database', '/r2/buckets']) assert.equal(api.state.calls.filter(call => call.route === route && call.method === 'POST').length, 1);
  assert.equal(api.state.queues.length, 2);
});

test('a concurrent create conflict reuses the exact named resource', async () => {
  const api = cloudflare({ intercept: ({ route, method }, state) => {
    if (route === '/d1/database' && method === 'POST') {
      state.databases.push({ name: 'mailcheap', uuid: databaseId });
      return failure(409, 'Already exists');
    }
  } });
  const result = await api.run(configuration());
  assert.equal(result.config.d1_databases[0].database_id, databaseId);
});

test('a missing workers.dev subdomain is reported without signing up or inventing a URL', async () => {
  const api = cloudflare({ intercept: ({ route }) => route === '/workers/subdomain' ? failure(404, 'Not registered') : undefined });
  const result = await api.run(configuration());
  assert.equal(result.workersSubdomain, null);
  assert.equal(api.state.calls.filter(call => call.route === '/workers/subdomain' && call.method !== 'GET').length, 0);
});
