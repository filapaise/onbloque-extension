import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTEXT_INVALIDATED,
  extensionContextAlive,
  isContextInvalidatedError,
  sendMessage,
} from '../src/shared/messages.ts';
import { RELOAD_TOAST, explainContentError } from '../src/content/contentErrors.ts';
import { reinjectContentScripts, shouldReinject, type ReinjectApi } from '../src/background/reinject.ts';

const g = globalThis as unknown as { chrome?: unknown };
const saved = g.chrome;
afterEach(() => {
  g.chrome = saved;
});

describe('1.3.1 — script de page orphelin (extension mise à jour, onglet resté ouvert)', () => {
  it('chrome.runtime absent : code clair, pas de TypeError « reading sendMessage »', async () => {
    g.chrome = {};
    assert.equal(extensionContextAlive(), false);
    const resp = await sendMessage({ type: 'GET_PROGRESS' });
    assert.deepEqual(resp, { ok: false, error: CONTEXT_INVALIDATED });
  });

  it('chrome lui-même absent', async () => {
    delete g.chrome;
    const resp = await sendMessage({ type: 'OPEN_PREVIEW', mode: 'list' });
    assert.deepEqual(resp, { ok: false, error: CONTEXT_INVALIDATED });
  });

  it('runtime sans id (contexte invalidé)', async () => {
    g.chrome = { runtime: { sendMessage: () => assert.fail('ne doit pas être appelé') } };
    const resp = await sendMessage({ type: 'GET_PROGRESS' });
    assert.deepEqual(resp, { ok: false, error: CONTEXT_INVALIDATED });
  });

  it('« Extension context invalidated. » levée par sendMessage', async () => {
    g.chrome = {
      runtime: {
        id: 'abc',
        sendMessage: () => {
          throw new Error('Extension context invalidated.');
        },
      },
    };
    const resp = await sendMessage({ type: 'GET_PROGRESS' });
    assert.deepEqual(resp, { ok: false, error: CONTEXT_INVALIDATED });
  });

  it('lastError « context invalidated » → même code', async () => {
    const runtime: Record<string, unknown> = { id: 'abc' };
    runtime.sendMessage = (_m: unknown, cb: (r: unknown) => void) => {
      runtime.lastError = { message: 'Extension context invalidated.' };
      cb(undefined);
    };
    g.chrome = { runtime };
    const resp = await sendMessage({ type: 'GET_PROGRESS' });
    assert.deepEqual(resp, { ok: false, error: CONTEXT_INVALIDATED });
  });

  it('autres erreurs inchangées, réponse normale transmise', async () => {
    const runtime: Record<string, unknown> = { id: 'abc' };
    runtime.sendMessage = (_m: unknown, cb: (r: unknown) => void) => {
      runtime.lastError = { message: 'Boom' };
      cb(undefined);
    };
    g.chrome = { runtime };
    assert.deepEqual(await sendMessage({ type: 'PING' }), { ok: false, error: 'Boom' });
    g.chrome = { runtime: { id: 'abc', sendMessage: (_m: unknown, cb: (r: unknown) => void) => cb({ ok: true, pong: true }) } };
    assert.deepEqual(await sendMessage({ type: 'PING' }), { ok: true, pong: true });
  });

  it('reconnaît les messages d’erreur typiques', () => {
    assert.ok(isContextInvalidatedError("Cannot read properties of undefined (reading 'sendMessage')"));
    assert.ok(isContextInvalidatedError(new Error('Extension context invalidated.')));
    assert.ok(isContextInvalidatedError(CONTEXT_INVALIDATED));
    assert.ok(!isContextInvalidatedError('Session X introuvable'));
    assert.ok(!isContextInvalidatedError(undefined));
  });

  it('toast lisible en français avec bouton Recharger', () => {
    for (const err of [CONTEXT_INVALIDATED, "Cannot read properties of undefined (reading 'sendMessage')"]) {
      const v = explainContentError(err);
      assert.equal(v.text, RELOAD_TOAST);
      assert.equal(v.text, 'OnBloque a été mis à jour : recharge la page (F5) pour continuer.');
      assert.equal(v.reload, true);
      assert.equal(v.stale, true);
    }
    assert.deepEqual(explainContentError('Aucun compte'), { text: 'Aucun compte', reload: false, stale: false });
    assert.equal(explainContentError('Could not establish connection. Receiving end does not exist.').reload, true);
  });
});

describe('1.3.1 — script de page : idempotent et sans minuteur fou', () => {
  const src = readFileSync(new URL('../src/content/inject.ts', import.meta.url), 'utf8');
  it('garde anti double injection + remplacement de l’ancien bouton', () => {
    assert.match(src, /__onbloqueContentScript/);
    // 1.3.2 : l'ancienne instance est retirée via la référence du monde isolé (plus d'id dans le DOM),
    // et l'interface d'une version ≤ 1.3.1 est nettoyée.
    assert.match(src, /if \(prev\.retire\) prev\.retire\(\);\s*else prev\.shutdown\(\);/);
    assert.match(src, /getElementById\(LEGACY_ROOT_ID\)\?\.remove\(\)/);
  });
  it('arrête minuteur, observateur et écouteurs quand le contexte est mort', () => {
    assert.match(src, /clearInterval\(tickTimer\)/);
    assert.match(src, /obs\?\.disconnect\(\)/);
    assert.match(src, /removeEventListener\('visibilitychange', onVisible\)/);
  });
  it('n’affiche plus l’erreur JS brute', () => {
    assert.match(src, /explainContentError\(/);
    assert.match(src, /location\.reload\(\)/);
  });
});

describe('1.3.1 — réinjection après installation / mise à jour', () => {
  function fakeApi(tabs: Array<{ id?: number; discarded?: boolean }>, failOn?: number) {
    const calls: Array<{ tabId: number; files: string[] }> = [];
    const queries: string[][] = [];
    const api: ReinjectApi = {
      runtime: {
        getManifest: () => ({ content_scripts: [{ matches: ['https://x.com/*', 'https://twitter.com/*'], js: ['content.js'] }] }),
      },
      tabs: {
        query: async (q) => {
          queries.push(q.url);
          return tabs;
        },
      },
      scripting: {
        executeScript: async (o) => {
          if (o.target.tabId === failOn) throw new Error('Cannot access contents of the page');
          calls.push({ tabId: o.target.tabId, files: o.files });
        },
      },
    };
    return { api, calls, queries };
  }

  it('injecte les fichiers du manifeste dans les onglets x.com / twitter.com ouverts', async () => {
    const { api, calls, queries } = fakeApi([{ id: 1 }, { id: 2, discarded: true }, {}, { id: 3 }], 3);
    const n = await reinjectContentScripts(api);
    assert.equal(n, 1);
    assert.deepEqual(queries, [['https://x.com/*', 'https://twitter.com/*']]);
    assert.deepEqual(calls, [{ tabId: 1, files: ['content.js'] }]);
  });

  it('seulement pour install et update', () => {
    assert.ok(shouldReinject('install'));
    assert.ok(shouldReinject('update'));
    assert.ok(!shouldReinject('chrome_update'));
    assert.ok(!shouldReinject('shared_module_update'));
    assert.ok(!shouldReinject(undefined));
  });

  it('le service worker branche la réinjection sur onInstalled', () => {
    const sw = readFileSync(new URL('../src/background/serviceWorker.ts', import.meta.url), 'utf8');
    assert.match(sw, /onInstalled\.addListener\(\(details\)/);
    assert.match(sw, /shouldReinject\(details\?\.reason\)/);
    const manifest = JSON.parse(readFileSync(new URL('../static/manifest.json', import.meta.url), 'utf8'));
    assert.ok(manifest.permissions.includes('scripting'));
    assert.ok(manifest.host_permissions.includes('https://x.com/*'));
  });
});
