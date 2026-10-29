import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isAllowedTabFetchUrl, makeTabFetch, TAB_FETCH_REFUSED } from '../src/infra/tabFetch.ts';
import {
  assertSenderAllowed,
  isContentAllowed,
  MAX_FAB_OFFSET,
  sanitizeFabPos,
} from '../src/background/messageGuard.ts';
import type { Msg } from '../src/shared/messages.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const EXT_ID = 'abcdefghijklmnop';

describe('1.3.2 F1 — bouton x.com dans un Shadow DOM fermé, hôte neutre', () => {
  const src = read('../src/content/inject.ts');
  it('Shadow DOM fermé', () => {
    assert.match(src, /attachShadow\(\{ mode: 'closed' \}\)/);
    assert.doesNotMatch(src, /mode: 'open'/);
  });
  it('aucune balise <style> ni id/classe/attribut sur un élément de la page', () => {
    // Le style est ajouté à la racine fantôme, jamais au document.
    assert.match(src, /shadow\.append\(buildStyle\(\), root\)/);
    assert.doesNotMatch(src, /document\.(documentElement|head|body)\.appendChild\(style\)/);
    // L'hôte : un <div> nu, ajouté tel quel.
    const build = src.slice(src.indexOf('function buildUi()'), src.indexOf('/** Applique une position'));
    assert.match(build, /const h = document\.createElement\('div'\);/);
    assert.doesNotMatch(build, /\bh\.(id|className|title|dataset|setAttribute|style|classList)\b/);
    // Plus de « onbloque » dans le DOM : seuls les anciens identifiants restent, pour être retirés.
    assert.doesNotMatch(src, /\.id = /);
    assert.doesNotMatch(src, /\bROOT_ID\b(?!_)/);
    assert.match(src, /getElementById\(LEGACY_STYLE_ID\)\?\.remove\(\)/);
  });
  it('sélecteurs CSS internes à la racine fantôme (plus de #onbloque-fab-root)', () => {
    assert.doesNotMatch(src, /#\$\{/);
    assert.match(src, /:host\{all:initial\}/);
  });
  it('les compteurs ne sont jamais posés sur l’hôte (title dans la racine fermée)', () => {
    assert.doesNotMatch(src, /host\??\.(title|setAttribute|dataset)/);
    assert.match(src, /main\.title = `OnBloque — \$\{p\.done\}/);
  });
  it('anti double injection : référence du monde isolé, pas de recherche par id', () => {
    assert.match(src, /w\[GUARD_KEY\] = \{ instance: INSTANCE, alive: contextAlive, shutdown, retire \}/);
    assert.match(src, /guard && guard\.instance !== INSTANCE/);
    assert.match(src, /if \(!host\?\.isConnected\) mount\(\)/);
  });
  it('clic extérieur détecté via composedPath (le Shadow DOM est vu comme l’hôte)', () => {
    assert.match(src, /e\.composedPath\(\)\.includes\(host\)/);
  });
});

describe('1.3.2 F2 — actions du menu : clics de confiance + anti-rafale', () => {
  const src = read('../src/content/inject.ts');
  it('ignore les événements synthétiques (!isTrusted)', () => {
    const actions = src.slice(src.indexOf(".ob-action').forEach"), src.indexOf("document.addEventListener(\n    'click'"));
    assert.match(actions, /if \(!e\.isTrusted\) return;/);
  });
  it('OPEN_PREVIEW limité à une ouverture toutes les 2 s', () => {
    assert.match(src, /OPEN_PREVIEW_DEBOUNCE_MS = 2000/);
    assert.match(src, /now - lastPreviewOpen < OPEN_PREVIEW_DEBOUNCE_MS\) return;/);
  });
});

describe('1.3.2 F3 — position du bouton via le service worker', () => {
  beforeEach(() => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { id: EXT_ID, getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}` },
    };
  });
  const xTab = { id: EXT_ID, url: 'https://x.com/home', tab: { id: 3, url: 'https://x.com/home' } } as chrome.runtime.MessageSender;

  it('le content script n’utilise plus chrome.storage', () => {
    for (const f of ['inject.ts', 'collect.ts', 'contentErrors.ts']) {
      const code = read(`../src/content/${f}`).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      assert.doesNotMatch(code, /chrome\??\.storage|\.storage\??\.local/, f);
    }
  });
  it('GET_FAB_POS / SET_FAB_POS autorisés depuis x.com, rien d’autre de nouveau', () => {
    assert.equal(isContentAllowed('GET_FAB_POS'), true);
    assert.equal(isContentAllowed('SET_FAB_POS'), true);
    assert.doesNotThrow(() => assertSenderAllowed({ type: 'GET_FAB_POS' }, xTab));
    assert.doesNotThrow(() => assertSenderAllowed({ type: 'SET_FAB_POS', pos: { right: 10, bottom: 10 } }, xTab));
    for (const type of ['GET_STATUS', 'GET_LOGS', 'SET_SETTINGS', 'RESET_HISTORY']) {
      assert.throws(() => assertSenderAllowed({ type } as Msg, xTab), /interdit/);
    }
  });
  it('position validée : deux nombres finis, 0–10 000, arrondis ; le reste est rejeté', () => {
    assert.deepEqual(sanitizeFabPos({ right: 24.4, bottom: 168.6, evil: '<img>' }), { right: 24, bottom: 169 });
    assert.deepEqual(sanitizeFabPos({ right: 0, bottom: MAX_FAB_OFFSET }), { right: 0, bottom: 10_000 });
    for (const bad of [
      null, undefined, 'x', 42, [], [1, 2], {},
      { right: -1, bottom: 5 }, { right: 5, bottom: 10_001 },
      { right: Number.NaN, bottom: 5 }, { right: Infinity, bottom: 5 },
      { right: '5', bottom: 5 }, { right: 5 },
    ]) {
      assert.throws(() => sanitizeFabPos(bad), /Position invalide/, JSON.stringify(bad));
    }
  });
  it('le service worker lit / écrit la clé de position après validation', () => {
    const sw = read('../src/background/serviceWorker.ts');
    assert.match(sw, /case 'SET_FAB_POS': \{\s*const fabPos = sanitizeFabPos\(/);
    assert.match(sw, /chrome\.storage\.local\.set\(\{ \[POS_KEY\]: fabPos \}\)/);
    assert.match(sw, /case 'GET_FAB_POS'/);
  });
});

describe('1.3.2 F4 — fetch depuis l’onglet x.com : liste blanche d’URL', () => {
  let injected = 0;
  beforeEach(() => {
    injected = 0;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      scripting: {
        executeScript: async () => {
          injected++;
          return [{ result: { status: 200, body: '{}' } }];
        },
      },
    };
  });
  it('autorise l’API web de X et les bundles abs.twimg.com', () => {
    for (const u of [
      'https://x.com/i/api/1.1/blocks/create.json',
      'https://x.com/i/api/graphql/abc/UsersByRestIds?variables=%7B%7D',
      'https://abs.twimg.com/responsive-web/client-web/main.abc.js',
    ]) assert.equal(isAllowedTabFetchUrl(u), true, u);
  });
  it('refuse tout le reste', () => {
    for (const u of [
      'http://x.com/i/api/1.1/blocks/create.json',
      'https://x.com/home',
      'https://x.com/i/apix',
      'https://x.com/i/api/../settings',
      'https://x.com.evil.tld/i/api/x',
      'https://evil.tld/https://x.com/i/api/x',
      'https://user:pw@x.com/i/api/x',
      'https://x.com:8443/i/api/x',
      'https://twitter.com/i/api/x',
      'https://api.x.com/1.1/x',
      'https://evil.abs.twimg.com/x.js',
      'javascript:alert(1)',
      'data:text/html,hi',
      'pas une url',
    ]) assert.equal(isAllowedTabFetchUrl(u), false, u);
  });
  it('makeTabFetch rejette avant toute injection dans l’onglet', async () => {
    await assert.rejects(makeTabFetch(1)('https://evil.tld/steal'), (e: Error) => e.message === TAB_FETCH_REFUSED);
    assert.equal(injected, 0);
    const ok = await makeTabFetch(1)('https://x.com/i/api/1.1/account/settings.json');
    assert.equal(ok.status, 200);
    assert.equal(injected, 1);
  });
});

describe('1.3.2 F7 — plus de permission d’hôte pour le site de la liste', () => {
  const manifest = JSON.parse(read('../static/manifest.json')) as {
    version: string;
    permissions: string[];
    host_permissions: string[];
    optional_host_permissions: string[];
  };
  it('manifest : x.com / twitter.com seulement, aucune nouvelle permission', () => {
    assert.equal(manifest.version, '1.3.2');
    assert.deepEqual(manifest.host_permissions, ['https://x.com/*', 'https://twitter.com/*']);
    assert.deepEqual(manifest.permissions, ['storage', 'alarms', 'scripting']);
    assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
  });
  it('plus d’origine « intégrée » pour le domaine de la liste (permission demandée au besoin)', () => {
    for (const f of ['../src/ui/listHost.ts', '../src/application/listService.ts']) {
      assert.doesNotMatch(read(f), /onbloquelextremedroite/, f);
    }
  });
  it('une URL de liste sur ce domaine passe par la permission optionnelle', async () => {
    const asked: string[][] = [];
    (globalThis as unknown as { chrome: unknown }).chrome = {
      permissions: {
        contains: async () => false,
        request: async (p: { origins: string[] }) => {
          asked.push(p.origins);
          return true;
        },
      },
    };
    const { ensureListHostFromUi } = await import('../src/ui/listHost.ts');
    await ensureListHostFromUi('https://onbloquelextremedroite.fun/liste.json');
    assert.deepEqual(asked, [['https://onbloquelextremedroite.fun/*']]);
    const { ensureListHostPermission } = await import('../src/application/listService.ts');
    await assert.rejects(ensureListHostPermission('https://onbloquelextremedroite.fun/liste.json'), /Permission manquante/);
  });
});
