import fs from 'node:fs';
import path from 'node:path';

// Read source as data; this guard is also used in the privileged publish job.
// Keep it dependency-free and do not import application or build configuration.
const errors = [];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const forbidden = /^(?:@aws-sdk\/|aws-sdk$|mongoose$|mongodb$|@upstash\/|@vercel\/blob$)/;
if (pkg.packageManager !== 'pnpm@11.28.8') errors.push('package.json must pin pnpm@11.28.8');
function forbiddenAlias(specifier) {
  if (typeof specifier !== 'string' || !specifier.startsWith('npm:')) return false;
  let target = specifier.slice(4).replace(/^\//, '');
  const versionSeparator = target.startsWith('@') ? target.indexOf('@', target.indexOf('/') + 1) : target.indexOf('@');
  if (versionSeparator > 0) target = target.slice(0, versionSeparator);
  return forbidden.test(target);
}
for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const [name, specifier] of Object.entries(pkg[group] || {})) {
    if (forbidden.test(name)) errors.push(`Forbidden ${group} dependency: ${name}`);
    if (forbiddenAlias(specifier)) errors.push(`Forbidden ${group} npm alias: ${name} -> ${specifier}`);
  }
}
const lockPath = 'pnpm-lock.yaml';
if (!fs.existsSync(lockPath)) {
  errors.push('Missing pnpm-lock.yaml');
} else {
  if (fs.existsSync('package-lock.json')) errors.push('Remove package-lock.json; pnpm-lock.yaml is the supported lockfile');
  const lockText = fs.readFileSync(lockPath, 'utf8');
  if (!/^lockfileVersion:\s*(?:'9\.0'|"9\.0"|9\.0)\s*$/m.test(lockText)) {
    errors.push('pnpm-lock.yaml must use the supported lockfileVersion 9.0 format');
  }
  const lines = lockText.split(/\r?\n/);
  const packagesStart = lines.findIndex(line => line === 'packages:');
  const snapshotsStart = lines.findIndex((line, index) => index > packagesStart && line === 'snapshots:');
  if (packagesStart < 0 || snapshotsStart < 0) {
    errors.push('pnpm-lock.yaml must contain top-level packages and snapshots sections');
  } else {
    let packageCount = 0;
    for (const line of lines.slice(packagesStart + 1, snapshotsStart)) {
      if (!line.trim() || /^\s*#/.test(line)) continue;
      if (/^\t/.test(line)) {
        errors.push('pnpm-lock.yaml packages section cannot use tabs');
        break;
      }
      const indent = line.match(/^ */)[0].length;
      if (indent === 0) {
        errors.push('pnpm-lock.yaml packages section contains an unexpected top-level section');
        break;
      }
      if (indent % 2 !== 0) {
        errors.push('pnpm-lock.yaml packages section has unsupported indentation');
        break;
      }
      if (indent !== 2) continue;
      const rawKey = line.slice(2).replace(/:\s*(?:\{\})?\s*$/, '');
      let name;
      if (rawKey.startsWith("'") && rawKey.endsWith("'")) name = rawKey.slice(1, -1).replace(/''/g, "'");
      else if (rawKey.startsWith('"') && rawKey.endsWith('"')) {
        try { name = JSON.parse(rawKey); } catch { name = null; }
      } else if (!rawKey.includes('\t') && !/[{}[\],]/.test(rawKey)) name = rawKey;
      if (!name) {
        errors.push(`Unsupported pnpm package key in lockfile: ${line.trim()}`);
        continue;
      }
      packageCount++;
      const versionSeparator = name.startsWith('@') ? name.indexOf('@', name.indexOf('/') + 1) : name.indexOf('@');
      const packageName = versionSeparator > 0 ? name.slice(0, versionSeparator) : '';
      if (!packageName || forbidden.test(packageName)) errors.push(`Forbidden or invalid locked dependency: ${name}`);
      if (forbiddenAlias(name)) errors.push(`Forbidden locked npm alias: ${name}`);
    }
    if (packageCount === 0) errors.push('pnpm-lock.yaml packages section is empty or unreadable');
  }
  // pnpm records npm aliases in importer/package specifiers. Scan only this
  // explicit alias syntax so an alias cannot hide a forbidden resolved name.
  const aliasPattern = /npm:(@aws-sdk\/[^\s'"),]+|@upstash\/[^\s'"),]+|@vercel\/blob(?:@[^\s'"),]+)?|aws-sdk(?:@[^\s'"),]+)?|mongoose(?:@[^\s'"),]+)?|mongodb(?:@[^\s'"),]+)?)/g;
  for (const match of lockText.matchAll(aliasPattern)) errors.push(`Forbidden locked npm alias: ${match[1]}`);
}
if (!pkg.dependencies?.vinext && !pkg.devDependencies?.vinext) {
  errors.push('vinext must remain a direct dependency');
}
if (!/\b(?:vinext|vite)\s+build\b/.test(pkg.scripts?.build || '')) {
  errors.push('The production build must use vinext/Vite');
}
const wranglerFile = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find(file => fs.existsSync(file));
if (!wranglerFile) {
  errors.push('Missing Cloudflare Worker configuration');
} else {
  const config = fs.readFileSync(wranglerFile, 'utf8');
  for (const binding of ['d1_databases', 'r2_buckets', 'queues']) {
    if (!config.includes(binding)) errors.push(`Missing Cloudflare ${binding} configuration`);
  }
}
const legacyImport = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](?:@aws-sdk\/[^'"]*|aws-sdk|mongoose|mongodb|@upstash\/[^'"]*|@vercel\/blob)['"]/;
function inspect(file) {
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(file)) inspect(path.join(file, child));
  } else if (/\.[cm]?[jt]sx?$/.test(file) && legacyImport.test(fs.readFileSync(file, 'utf8'))) {
    errors.push(`Legacy provider import in ${file}`);
  }
}
for (const root of ['app', 'components', 'lib', 'models', 'worker', 'workers', 'worker.js', 'worker.ts']) {
  if (fs.existsSync(root)) inspect(root);
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Cloudflare architecture checks passed.');
}
