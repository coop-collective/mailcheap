import fs from 'node:fs';
import path from 'node:path';

// Read source as data; this guard is also used in the privileged publish job.
// Keep it dependency-free and do not import application or build configuration.
const errors = [];
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const forbidden = /^(?:@aws-sdk\/|aws-sdk$|mongoose$|mongodb$|@upstash\/|@vercel\/blob$)/;
for (const group of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[group] || {})) {
    if (forbidden.test(name)) errors.push(`Forbidden ${group} dependency: ${name}`);
  }
}
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
for (const location of Object.keys(lock.packages || {})) {
  const name = location.split('node_modules/').at(-1);
  if (forbidden.test(name)) errors.push(`Forbidden locked dependency: ${name}`);
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
