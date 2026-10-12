// Resource setup uses the documented REST API because Wrangler's R2/Queues
// commands print human-readable output. No credentials are written to disk here.
const API = "https://api.cloudflare.com/client/v4";
const PLACEHOLDER_ID = "00000000-0000-0000-0000-000000000000";
const MAX_PAGES = 1000;

/** runWrangler(args) must capture stdout without printing it, including errors. */
export async function readCloudflareAuth(runWrangler) {
  let identity;
  let auth;
  try {
    // whoami refreshes an expired OAuth session before auth token reads it.
    identity = JSON.parse(await runWrangler(["whoami", "--json"]));
    if (identity.loggedIn !== true) throw new Error("Not logged in");
    auth = JSON.parse(await runWrangler(["auth", "token", "--json"]));
  } catch {
    // A subprocess error can include captured credentials; do not propagate it.
    throw new Error("Cloudflare authentication failed. Run `pnpm exec wrangler login` or set CLOUDFLARE_API_TOKEN, then retry.");
  }
  if (!["oauth", "api_token"].includes(auth.type) || typeof auth.token !== "string" || !auth.token.trim()) {
    throw new Error("Setup needs Wrangler OAuth login or CLOUDFLARE_API_TOKEN. Global API keys are not supported.");
  }
  if (!Array.isArray(identity.accounts)) throw new Error("Wrangler did not return a Cloudflare account list.");
  return {
    accounts: identity.accounts.map(({ id, name }) => ({ id, name })),
    token: auth.token,
  };
}

function requireName(name, type) {
  if (typeof name !== "string" || !name.trim() || name !== name.trim() || /[\r\n\0]/.test(name)) {
    throw new Error(`${type} needs an explicit resource name in the Wrangler configuration.`);
  }
}

function client(accountId, token, fetcher) {
  return async (path = "", { method = "GET", body, headers = {} } = {}) => {
    let response;
    let envelope;
    try {
      response = await fetcher(`${API}/accounts/${accountId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
      envelope = await response.json();
    } catch {
      throw new Error(`Cloudflare ${method} ${path || "/account"} failed: network timeout or invalid API response. Retry setup; existing resources are reused.`);
    }
    if (!response.ok || envelope.success !== true) {
      const details = (envelope.errors ?? []).map(({ code, message }) => `${code}: ${message}`).join("; ");
      const safeDetails = details.replaceAll(token, "[redacted]").replace(/[\r\n\0]/g, " ").slice(0, 500);
      const error = new Error(`Cloudflare ${method} ${path || "/account"} failed (HTTP ${response.status})${safeDetails ? `: ${safeDetails}` : "."}`);
      error.status = response.status;
      error.codes = (envelope.errors ?? []).map(({ code }) => code);
      throw error;
    }
    return envelope;
  };
}

async function listPages(request, path, { perPage = 20, sendPageSize = false } = {}) {
  const records = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ page: String(page) });
    if (sendPageSize) query.set("per_page", String(perPage));
    const { result, result_info: info = {} } = await request(`${path}?${query}`);
    if (!Array.isArray(result)) throw new Error(`Cloudflare returned an invalid resource list for ${path}.`);
    records.push(...result);
    if (result.length === 0) return records;
    if (Number.isFinite(info.total_pages)) {
      if (page >= info.total_pages) return records;
    } else if (Number.isFinite(info.total_count)) {
      if (records.length >= info.total_count) return records;
    } else if (result.length < (info.per_page ?? perPage)) {
      return records;
    }
  }
  throw new Error(`Cloudflare pagination exceeded ${MAX_PAGES} pages for ${path}.`);
}

async function listBuckets(request, jurisdiction) {
  const records = [];
  const seen = new Set();
  let cursor;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({ per_page: "100" });
    if (cursor) query.set("cursor", cursor);
    const { result, result_info: info = {} } = await request(`/r2/buckets?${query}`, {
      headers: { "cf-r2-jurisdiction": jurisdiction },
    });
    if (!Array.isArray(result?.buckets)) throw new Error("Cloudflare returned an invalid R2 bucket list.");
    records.push(...result.buckets);
    cursor = info.cursor;
    if (!cursor) return records;
    if (seen.has(cursor)) throw new Error("Cloudflare repeated an R2 pagination cursor; setup stopped.");
    seen.add(cursor);
  }
  throw new Error(`Cloudflare R2 pagination exceeded ${MAX_PAGES} pages.`);
}

function findUnique(records, field, name) {
  const matches = records.filter((record) => record[field] === name);
  if (matches.length > 1) throw new Error(`Cloudflare returned multiple resources named ${name}; choose a unique name.`);
  return matches[0];
}

async function reuseOrCreate({ records, field, name, create, reload, label, log }) {
  let resource = findUnique(records, field, name);
  if (resource) {
    log(`Using ${label}: ${name}`);
    return resource;
  }
  try {
    resource = await create();
  } catch (error) {
    // Another setup may have created the same name between list and create.
    // Permission failures and arbitrary API errors must never count as success.
    if (error.status !== 409 && !error.codes?.includes(7502)) throw error;
    resource = findUnique(await reload(), field, name);
    if (!resource) throw error;
  }
  if (resource?.[field] !== name) throw new Error(`Cloudflare returned an unexpected ${label} after creating ${name}.`);
  records.push(resource);
  log(`Ready ${label}: ${name}`);
  return resource;
}

/**
 * Create/reuse only the resources declared in config. This does not deploy,
 * register a workers.dev subdomain, apply migrations, or alter existing data.
 * The caller persists returned config before building and migrating remotely.
 */
export async function provisionCloudflare({ accountId, config, token = process.env.CLOUDFLARE_API_TOKEN, fetcher = fetch, log = console.log, databaseNamesFromIds = false }) {
  if (typeof accountId !== "string" || !/^[a-f0-9]{32}$/i.test(accountId)) {
    throw new Error("Choose an explicit Cloudflare account ID (32 hexadecimal characters).");
  }
  if (typeof token !== "string" || !token.trim()) throw new Error("A Cloudflare OAuth or API token is required for resource setup.");
  const nextConfig = structuredClone(config);
  const databases = nextConfig.d1_databases ?? [];
  const buckets = nextConfig.r2_buckets ?? [];
  const consumers = nextConfig.queues?.consumers ?? [];
  const producers = nextConfig.queues?.producers ?? [];
  // Ensure dead-letter queues exist before deployment attaches the consumers.
  const queueNames = [...new Set([
    ...consumers.map((consumer) => consumer.dead_letter_queue).filter(Boolean),
    ...producers.map((producer) => producer.queue),
    ...consumers.map((consumer) => consumer.queue),
  ])];
  for (const database of databases) requireName(database.database_name, "D1");
  for (const bucket of buckets) requireName(bucket.bucket_name, "R2");
  for (const name of queueNames) requireName(name, "Queue");

  const request = client(accountId, token, fetcher);
  const account = (await request()).result;
  if (account?.id !== accountId) throw new Error("The selected Cloudflare account is not available to these credentials.");
  nextConfig.account_id = accountId;

  const loadDatabases = () => listPages(request, "/d1/database", { perPage: 100, sendPageSize: true });
  const dbRecords = databases.length ? await loadDatabases() : [];
  // Validate every configured database ID before creating any resource. Never
  // silently replace a database merely because another account was selected.
  for (const database of databases) {
    const id = database.database_id;
    if (id && id !== PLACEHOLDER_ID) {
      const existing = dbRecords.find((record) => record.uuid === id);
      if (existing && databaseNamesFromIds) database.database_name = existing.name;
      if (existing?.name !== database.database_name) {
        throw new Error(`D1 ${database.database_name}: configured database_id does not match that name in the selected account. Check the account and binding before retrying.`);
      }
    }
  }
  const bucketRecords = new Map();
  for (const jurisdiction of new Set(buckets.map((bucket) => bucket.jurisdiction || "default"))) {
    bucketRecords.set(jurisdiction, await listBuckets(request, jurisdiction));
  }
  const loadQueues = () => listPages(request, "/queues");
  const queueRecords = queueNames.length ? await loadQueues() : [];

  for (const database of databases) {
    const resource = await reuseOrCreate({
      records: dbRecords, field: "name", name: database.database_name, label: "D1 database", log,
      reload: loadDatabases,
      create: async () => (await request("/d1/database", {
        method: "POST",
        body: { name: database.database_name, ...(database.jurisdiction ? { jurisdiction: database.jurisdiction } : {}) },
      })).result,
    });
    if (typeof resource.uuid !== "string" || !resource.uuid) throw new Error("Cloudflare did not return a D1 database ID.");
    database.database_id = resource.uuid;
  }
  for (const bucket of buckets) {
    const jurisdiction = bucket.jurisdiction || "default";
    await reuseOrCreate({
      records: bucketRecords.get(jurisdiction), field: "name", name: bucket.bucket_name, label: "R2 bucket", log,
      reload: () => listBuckets(request, jurisdiction),
      create: async () => (await request("/r2/buckets", {
        method: "POST", body: { name: bucket.bucket_name }, headers: { "cf-r2-jurisdiction": jurisdiction },
      })).result,
    });
  }
  for (const name of queueNames) {
    await reuseOrCreate({
      records: queueRecords, field: "queue_name", name, label: "Queue", log, reload: loadQueues,
      create: async () => (await request("/queues", { method: "POST", body: { queue_name: name } })).result,
    });
  }

  let workersSubdomain = null;
  try {
    const result = (await request("/workers/subdomain")).result;
    if (result?.subdomain) {
      if (typeof result.subdomain !== "string" || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(result.subdomain)) {
        throw new Error("Cloudflare returned an invalid workers.dev subdomain.");
      }
      workersSubdomain = result.subdomain;
    }
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  return { config: nextConfig, workersSubdomain };
}
