import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const entryPoints = {
  background: join(root, 'src/background/serviceWorker.ts'),
  popup: join(root, 'src/ui/popup.ts'),
  options: join(root, 'src/ui/options.ts'),
  preview: join(root, 'src/ui/preview.ts'),
};

await esbuild.build({
  entryPoints,
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  // chrome.* is provided by the extension runtime.
  external: [],
});

// Content script : script classique en IIFE (pas de const/let au niveau global), pour
// pouvoir être réinjecté après une mise à jour sans « Identifier already declared ».
await esbuild.build({
  entryPoints: { content: join(root, 'src/content/inject.ts') },
  outdir: dist,
  bundle: true,
  format: 'iife',
  target: ['chrome120'],
  platform: 'browser',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
});

// Static assets
for (const f of ['popup.html', 'options.html', 'preview.html', 'styles.css', 'manifest.json']) {
  cpSync(join(root, 'static', f), join(dist, f));
}
cpSync(join(root, 'static/icons'), join(dist, 'icons'), { recursive: true });
cpSync(join(root, 'lists'), join(dist, 'lists'), { recursive: true });
cpSync(join(root, 'README.md'), join(dist, 'README.md'));

// Patch HTML script tags are already correct (popup.js etc.).
console.log('Built →', dist);
