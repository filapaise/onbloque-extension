/**
 * Captures d'écran (1280×800) de l'UI réelle (dist/) avec des données de DÉMO
 * uniquement (@demo_user, comptes fictifs). Un faux objet `chrome` remplace
 * l'API d'extension : aucune session X, aucun réseau.
 * Usage : npm run build && node scripts/screenshots.mjs
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'store/assets');
const work = '/tmp/onbloque-shots';
rmSync(work, { recursive: true, force: true });
cpSync(join(root, 'dist'), work, { recursive: true });

const now = Date.now();
const demoRows = [
  ['compte_demo_01', 'Compte démo 01', 'to-block', true],
  ['compte_demo_02', 'Compte démo 02', 'to-block', true],
  ['compte_demo_03', 'Compte démo 03', 'to-block', false],
  ['compte_demo_04', 'Compte démo 04', 'to-block', true],
  ['compte_demo_05', 'Compte démo 05', 'following', false],
  ['ami_demo', 'Ami démo', 'whitelisted', false],
  ['compte_demo_06', 'Compte démo 06', 'already-blocked', false],
  ['compte_demo_07', 'Compte démo 07', 'not-found', false],
  ['compte_demo_08', 'Compte démo 08', 'to-block', true],
].map(([h, n, status, checked], i) => ({
  key: `h:${h}`, handle: h, id: String(1000 + i), name: n, category: 'Démo', source: 'liste de démonstration',
  status, warnings: status === 'following' ? ['Vous suivez ce compte'] : status === 'not-found' ? ['Introuvable sur X (supprimé, renommé ou suspendu) — non coché'] : [],
  checked,
}));

function shim(scenario) {
  const status = {
    settings: { pace: scenario === 'ratelimit' ? 'max' : 'prudent', listUrl: '', autoRefresh: false, dailyCap: scenario === 'ratelimit' ? 500 : 50, minDelaySec: 20, maxDelaySec: 45, customDelay: false, transport: 'tab' },
    list: { format: 'onbloque-list/1', name: 'Liste de démonstration', entries: demoRows.map((r) => ({ handle: r.handle })) },
    listSource: 'seed', listFetchedAt: now - 3600_000,
    whitelist: [{ handle: 'ami_demo' }, { handle: 'voisin_demo' }],
    queue: Array.from({ length: scenario === 'ratelimit' ? 140 : 38 }, (_, i) => ({ key: `h:q${i}`, handle: `q${i}`, action: 'block', addedAt: 0, attempts: 0 })),
    run: scenario === 'ratelimit'
      ? { running: false, dayKey: 'x', actionsToday: 96, backoffLevel: 0, resumeAt: now + 14 * 60_000, resumeReason: 'rate-limit', lastError: 'Limite X atteinte, reprise automatique à 22:41', totalDone: 96, totalSkipped: 4, lastActionAt: now - 60_000, nextActionAt: null, lastBlocked: { handle: 'compte_demo_08', at: now - 60_000 }, batchDone: 96, batchSkipped: 4 }
      : { running: true, dayKey: 'x', actionsToday: 12, backoffLevel: 0, resumeAt: null, resumeReason: null, lastError: null, totalDone: 12, totalSkipped: 2, lastActionAt: now - 30_000, nextActionAt: now + 37_000, lastBlocked: { handle: 'compte_demo_04', at: now - 30_000 }, batchDone: 12, batchSkipped: 2 },
    blockedByExt: [], sessionOk: true, self: { id: '1', handle: 'demo_user' },
  };
  const counts = {};
  for (const r of demoRows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const preview = { rows: demoRows, counts, self: { id: '1', handle: 'demo_user' }, sessionOk: true, abortReason: null, relationsOk: true, notes: [] };
  const diagnostics = [
    { at: now - 25 * 60_000, step: 'rate-limit', endpoint: '/i/api/1.1/friendships/lookup.json', status: 429, code: 'rate-limit' },
    { at: now - 90 * 60_000, step: 'skip', endpoint: 'not-found', code: 'not-found' },
  ];
  const responses = {
    GET_STATUS: { ok: true, status }, GET_LIST: { ok: true, list: status.list, source: 'seed', fetchedAt: status.listFetchedAt },
    BUILD_PREVIEW: { ok: true, preview }, GET_DIAGNOSTICS: { ok: true, diagnostics },
  };
  return `window.chrome = {
  runtime: { id: 'demo', lastError: undefined, getURL: (p) => '/' + (p || ''),
    sendMessage: (m, cb) => { const r = (${JSON.stringify(responses)})[m.type] || { ok: true }; setTimeout(() => cb && cb(r), 0); } },
  storage: { session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
             local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
             onChanged: { addListener() {} } },
  tabs: { create() {} }, permissions: { contains: async () => true, request: async () => true },
};`;
}

for (const [page, scenario] of [['popup', 'running'], ['popup', 'ratelimit'], ['preview', 'running'], ['options', 'running']]) {
  const html = readFileSync(join(work, `${page}.html`), 'utf8')
    .replace('<script type="module"', `<script src="shim-${scenario}.js"></script>\n<script type="module"`)
    // Capture des réglages : « Réglages avancés » déplié pour le montrer (replié par défaut dans l'extension).
    .replace('<details class="pace-adv" id="pace-adv">', '<details class="pace-adv" id="pace-adv" open>');
  writeFileSync(join(work, `${page}-${scenario}.html`), html);
  writeFileSync(join(work, `shim-${scenario}.js`), shim(scenario));
}

const frame = (src, caption, h) => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{background:linear-gradient(150deg,#0f1419,#15202b 55%,#1d2a38);display:flex;align-items:center;justify-content:center;gap:64px}
.copy{color:#e7e9ea;max-width:440px}.copy h1{font-size:40px;margin:0 0 12px}.copy p{color:#8b98a5;font-size:20px;line-height:1.45;margin:0 0 10px}
.copy .tag{color:#1d9bf0;font-weight:700}
iframe{width:340px;height:520px;border:0;border-radius:16px;box-shadow:0 24px 64px rgba(0,0,0,.55);background:#fff}
</style></head><body><div class="copy">${caption}</div><iframe src="${src}" style="height:${h}px"></iframe></body></html>`;
writeFileSync(join(work, 'frame-popup.html'), frame('popup-running.html',
  '<h1>OnBloque</h1><p>La file avance toute seule, au rythme choisi, avec un plafond journalier.</p><p class="tag">#OnBloquelExtremeDroite</p><p style="font-size:14px">Démo fictive — @demo_user</p>', 640));
writeFileSync(join(work, 'frame-ratelimit.html'), frame('popup-ratelimit.html',
  '<h1>Pas de panique</h1><p>Si X limite les requêtes, la file se met en attente et reprend automatiquement à l’heure indiquée.</p><p class="tag">#OnBloquelExtremeDroite</p><p style="font-size:14px">Démo fictive — @demo_user</p>', 640));
writeFileSync(join(work, 'features.html'), `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1419;color:#e7e9ea}
main{padding:70px 110px}h1{font-size:44px;margin:0}h1 span{color:#1d9bf0}.sub{color:#8b98a5;font-size:20px;margin:10px 0 40px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}.c{background:#16202a;border:1px solid #2f3336;border-radius:16px;padding:24px 26px}
.c h2{margin:0 0 8px;font-size:22px}.c p{margin:0;color:#8b98a5;font-size:17px;line-height:1.45}</style></head><body><main>
<h1>OnBloque <span>#OnBloquelExtremeDroite</span></h1><p class="sub">Bloquer sur X une liste de comptes d’extrême droite, en gardant le contrôle.</p>
<div class="grid">
<div class="c"><h2>1. Une liste partagée</h2><p>Liste communautaire embarquée, ou la vôtre (fichier, collage, URL https).</p></div>
<div class="c"><h2>2. Aperçu obligatoire</h2><p>Rien ne part sans votre confirmation : vous cochez et décochez chaque compte.</p></div>
<div class="c"><h2>3. Comptes protégés</h2><p>Vous-même, les comptes que vous suivez et votre liste blanche sont toujours exclus.</p></div>
<div class="c"><h2>4. Rythme raisonnable</h2><p>Prudent, Normal ou Max, plafond journalier, pauses, reprise automatique.</p></div>
</div></main></body></html>`);

const server = createServer((req, res) => {
  const p = join(work, decodeURIComponent((req.url || '/').split('?')[0]));
  try {
    const body = readFileSync(p);
    const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.png') ? 'image/png' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const shots = [
  ['frame-popup.html', 'screenshot-01-popup.png'],
  ['options-running.html', 'screenshot-02-options.png'],
  ['preview-running.html', 'screenshot-03-preview.png'],
  ['frame-ratelimit.html', 'screenshot-04-reprise-auto.png'],
  ['features.html', 'screenshot-05-features.png'],
];
mkdirSync(out, { recursive: true });
for (const [page, file] of shots) {
  const r = await new Promise((resolve) => {
    const p = spawn('google-chrome', [
      // Profil jetable : ne jamais réutiliser (ni ouvrir d'onglet dans) un Chrome déjà lancé.
      `--user-data-dir=${work}/chrome-profile`,
      '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
      '--virtual-time-budget=8000', '--window-size=1280,800', `--screenshot=${join(out, file)}`,
      `http://127.0.0.1:${port}/${page}`,
    ], { stdio: 'ignore' });
    p.on('exit', resolve);
  });
  console.log(file, r === 0 ? 'ok' : `exit ${r}`);
}
server.close();
