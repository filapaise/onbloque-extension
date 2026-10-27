import { existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const out = join(root, 'release', `onbloque-${version}.zip`);
mkdirSync(dirname(out), { recursive: true });
if (existsSync(out)) rmSync(out);

if (!existsSync(dist)) throw new Error('dist/ missing — run build first');

let r = spawnSync('zip', ['-r', '-q', out, '.'], { cwd: dist, encoding: 'utf8' });
if (r.status !== 0) {
  r = spawnSync(
    'python3',
    [
      '-c',
      `import zipfile,sys
from pathlib import Path
root=Path(sys.argv[1]); out=Path(sys.argv[2])
with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as z:
  for p in sorted(root.rglob('*')):
    if p.is_file(): z.write(p, p.relative_to(root).as_posix())
print(out)`,
      dist,
      out,
    ],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error('zip failed');
  }
}
console.log('Zipped →', out);
