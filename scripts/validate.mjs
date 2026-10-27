import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const manifest = JSON.parse(readFileSync(join(dist, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('manifest_version != 3');
if (!manifest.background?.service_worker) throw new Error('missing service_worker');
console.log('✓ manifest.json valid, MV3');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const jsFiles = walk(dist).filter((p) => extname(p) === '.js');
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error(`node --check failed: ${f}`);
  }
}
console.log(`✓ node --check OK on ${jsFiles.length} JS file(s)`);

// No remote code loading patterns in bundled JS.
const banned = [/eval\s*\(/, /new\s+Function\s*\(/, /chrome\.runtime\.getURL\(\s*['"]https?:/, /import\s*\(\s*['"]https?:/];
for (const f of jsFiles) {
  const src = readFileSync(f, 'utf8');
  for (const re of banned) {
    if (re.test(src)) throw new Error(`Banned pattern ${re} in ${f}`);
  }
}
console.log('✓ no remote/eval code patterns');

const seed = JSON.parse(readFileSync(join(dist, 'lists/seed.json'), 'utf8'));
if (seed.format !== 'onbloque-list/1') throw new Error('bad seed format');
console.log(`✓ seed.json: ${seed.entries.length} entries`);

console.log('Validation passed.');
