import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ACCOUNT_BLOCKED_CAP,
  ACCOUNT_BLOCKED_KEY,
  alreadyBlockedOnly,
  applyBlockingObservations,
  observationsFromRelations,
  sanitizeAccountBlocked,
  totalBlockedUnion,
} from '../src/domain/history.ts';
import type { BlockedRecord, Relationship } from '../src/domain/types.ts';
import { CONTENT_ALLOWED_TYPES } from '../src/background/messageGuard.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const rel = (id: string, handle: string, blocking: boolean): Relationship => ({
  id,
  handle,
  following: false,
  followedBy: false,
  blocking,
});
const relMap = (rels: Relationship[]) => {
  const m = new Map<string, Relationship>();
  for (const r of rels) {
    if (r.id) m.set(`id:${r.id}`, r);
    if (r.handle) m.set(`h:${r.handle.toLowerCase()}`, r);
  }
  return m;
};

describe('1.3.2 — total = bloqués par l’extension ∪ déjà bloqués sur le compte', () => {
  it('union sans doublon (id prioritaire, @ sans casse)', () => {
    const ext: BlockedRecord[] = [
      { id: '1', handle: 'Alpha', at: 10 },
      { handle: 'beta', at: 20 },
    ];
    const acc: BlockedRecord[] = [
      { id: '1', handle: 'alpha', at: 5 }, // déjà compté (id)
      { id: '2', handle: 'BETA', at: 5 }, // déjà compté (@)
      { id: '3', handle: 'gamma', at: 5 },
      { id: '4', at: 5 },
    ];
    assert.equal(totalBlockedUnion(ext, acc), 4);
    assert.deepEqual(alreadyBlockedOnly(ext, acc).map((r) => r.id), ['3', '4']);
  });

  it('cas de l’utilisateur : 0 par cette copie, 288 déjà bloqués → 288', () => {
    const acc = Array.from({ length: 288 }, (_, i) => ({ id: String(1000 + i), handle: `c${i}`, at: 1 }));
    assert.equal(totalBlockedUnion([], acc), 288);
  });

  it('robuste aux données invalides', () => {
    assert.equal(totalBlockedUnion(undefined, undefined), 0);
    assert.equal(totalBlockedUnion(null, 'x' as unknown as BlockedRecord[]), 0);
    const junk = [null, {}, { handle: '<img onerror=1>' }, { id: 'abc' }, { handle: 'ok', at: 'x' }];
    assert.deepEqual(sanitizeAccountBlocked(junk), [{ handle: 'ok', at: 0 }]);
  });
});

describe('1.3.2 — mise à jour de l’ensemble « déjà bloqués sur le compte »', () => {
  it('ajoute les comptes vus bloqués, retire ceux vus débloqués (source fiable)', () => {
    let cur = applyBlockingObservations(
      [],
      [
        { id: '1', handle: 'a', blocking: true },
        { id: '2', handle: 'b', blocking: true },
        { id: '3', handle: 'c', blocking: false },
      ],
      100,
      { allowRemoval: true },
    );
    assert.deepEqual(cur?.map((r) => r.id).sort(), ['1', '2']);
    cur = applyBlockingObservations(cur, [{ id: '1', handle: 'a', blocking: false }], 200, { allowRemoval: true });
    assert.deepEqual(cur?.map((r) => r.id), ['2']);
  });

  it('source peu fiable (GraphQL) : jamais de retrait', () => {
    const start: BlockedRecord[] = [{ id: '1', handle: 'a', at: 1 }];
    assert.equal(applyBlockingObservations(start, [{ id: '1', blocking: false }], 2, { allowRemoval: false }), null);
  });

  it('aucun changement → null (pas d’écriture) ; date de première observation conservée', () => {
    const start: BlockedRecord[] = [{ id: '1', handle: 'a', at: 50 }];
    assert.equal(applyBlockingObservations(start, [{ id: '1', handle: 'a', blocking: true }], 999, { allowRemoval: true }), null);
    const upd = applyBlockingObservations(start, [{ id: '1', handle: 'renomme', blocking: true }], 999, { allowRemoval: true });
    assert.deepEqual(upd, [{ id: '1', handle: 'renomme', at: 50 }]);
  });

  it('complète un enregistrement @ seul avec l’id ; @ réattribué (autre id) = autre compte', () => {
    const a = applyBlockingObservations([{ handle: 'x', at: 1 }], [{ id: '9', handle: 'x', blocking: true }], 5, { allowRemoval: true });
    assert.deepEqual(a, [{ id: '9', handle: 'x', at: 1 }]);
    const b = applyBlockingObservations([{ id: '9', handle: 'x', at: 1 }], [{ id: '10', handle: 'x', blocking: true }], 5, { allowRemoval: true });
    assert.deepEqual(b, [{ id: '10', handle: 'x', at: 5 }]);
  });

  it('valeurs invalides ignorées (id non numérique, @ invalide)', () => {
    const r = applyBlockingObservations(
      [],
      [
        { id: 'abc', blocking: true },
        { handle: 'javascript:alert(1)', blocking: true },
        null as unknown as { blocking: boolean },
      ],
      1,
      { allowRemoval: true },
    );
    assert.equal(r, null);
  });

  it(`plafonné à ${ACCOUNT_BLOCKED_CAP} (les plus récents gardés)`, () => {
    const old = Array.from({ length: ACCOUNT_BLOCKED_CAP }, (_, i) => ({ id: String(i + 1), at: 10 }));
    const next = applyBlockingObservations(old, [{ id: '999999', blocking: true }], 20, { allowRemoval: true });
    assert.equal(next?.length, ACCOUNT_BLOCKED_CAP);
    assert.equal(next?.[0]?.id, '999999');
    assert.equal(sanitizeAccountBlocked([...old, { id: '424242', at: 1 }]).length, ACCOUNT_BLOCKED_CAP);
  });
});

describe('1.3.2 — observations tirées des relations (aperçu)', () => {
  const list = [{ id: '1', handle: 'a' }, { handle: 'b' }, { id: '3', handle: 'c' }, { id: '4', handle: 'd' }];

  it('seulement les comptes de la liste, avec l’identité confirmée par X', () => {
    const map = relMap([rel('1', 'A', true), rel('2', 'b', true), rel('3', 'c', false), rel('77', 'horsliste', true)]);
    const obs = observationsFromRelations([...list, { handle: 'horsliste' }], list, map);
    assert.deepEqual(obs, [
      { id: '1', handle: 'A', blocking: true },
      { id: '2', handle: 'b', blocking: true },
      { id: '3', handle: 'c', blocking: false },
    ]);
  });

  it('relation absente ou couple id ↔ @ contredit : rien n’est observé', () => {
    const map = relMap([rel('4', 'autre', true)]);
    assert.deepEqual(observationsFromRelations(list, list, map), []);
  });

  it('pas de liste stockée : rien', () => {
    assert.deepEqual(observationsFromRelations(list, null, relMap([rel('1', 'a', true)])), []);
  });
});

describe('1.3.2 — stockage local et réinitialisation', () => {
  let data: Record<string, unknown>;
  beforeEach(() => {
    data = {};
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (keys: string | string[]) => {
            const out: Record<string, unknown> = {};
            for (const k of Array.isArray(keys) ? keys : [keys]) if (k in data) out[k] = data[k];
            return out;
          },
          set: async (patch: Record<string, unknown>) => {
            Object.assign(data, patch);
          },
        },
      },
    };
  });

  it('recordBlockingObservations écrit la clé blockedOnAccount ; loadStore la nettoie', async () => {
    const { recordBlockingObservations, loadStore } = await import('../src/infra/storage.ts');
    await recordBlockingObservations([{ id: '5', handle: 'e', blocking: true }], { allowRemoval: true }, 42);
    assert.deepEqual(data[ACCOUNT_BLOCKED_KEY], [{ id: '5', handle: 'e', at: 42 }]);
    data[ACCOUNT_BLOCKED_KEY] = [...(data[ACCOUNT_BLOCKED_KEY] as unknown[]), { handle: '<b>' }, 'x'];
    const store = await loadStore();
    assert.deepEqual(store.blockedOnAccount, [{ id: '5', handle: 'e', at: 42 }]);
  });

  it('« Réinitialiser » vide aussi blockedOnAccount', () => {
    const sw = read('../src/background/serviceWorker.ts');
    const block = sw.slice(sw.indexOf("case 'RESET_HISTORY'"), sw.indexOf("case 'OPEN_PREVIEW'"));
    assert.match(block, /blockedOnAccount: \[\]/);
  });

  it('un déblocage par l’extension retire le compte de l’ensemble', () => {
    const runner = read('../src/application/queueRunner.ts');
    assert.match(runner, /recordBlockingObservations\(\[\{ id: result\.id, handle: result\.handle, blocking: false \}\]/);
  });

  it('l’aperçu enregistre les relations ; retrait seulement via friendships/lookup', () => {
    const ps = read('../src/application/previewService.ts');
    assert.match(ps, /recordBlockingObservations\(observationsFromRelations\(listEntries, store\.list\?\.entries, relations\.map\)/);
    assert.match(ps, /allowRemoval: relations\.source === 'friendships'/);
  });
});

describe('1.3.2 — confidentialité : jamais exposé au content script ni à la page', () => {
  it('le content script ne lit ni le stockage ni l’état (types autorisés inchangés)', () => {
    assert.deepEqual([...CONTENT_ALLOWED_TYPES], ['OPEN_PREVIEW', 'GET_PROGRESS', 'PING', 'GET_FAB_POS', 'SET_FAB_POS']);
    const content = read('../src/content/inject.ts');
    assert.doesNotMatch(content, /chrome\.storage\.\w/);
    assert.doesNotMatch(content, /blockedOnAccount|GET_STATUS/);
  });

  it('GET_PROGRESS ne contient pas cette liste', () => {
    const pu = read('../src/background/progressUi.ts');
    assert.doesNotMatch(pu, /blockedOnAccount/);
  });

  it('stockage local réservé aux contextes de l’extension quand Chrome le permet', () => {
    const sw = read('../src/background/serviceWorker.ts');
    assert.match(sw, /setAccessLevel\?\.\(\{ accessLevel: 'TRUSTED_CONTEXTS' \}\)/);
  });

  it('aucune nouvelle permission', () => {
    const m = JSON.parse(read('../static/manifest.json'));
    assert.deepEqual(m.permissions, ['storage', 'alarms', 'scripting']);
    assert.deepEqual(m.host_permissions, ['https://x.com/*', 'https://twitter.com/*']);
  });
});

describe('1.3.2 — options : deux groupes cohérents avec le total', () => {
  it('« Bloqués par l’extension » et « Déjà bloqués sur votre compte »', () => {
    const html = read('../static/options.html');
    assert.match(html, /id="blocked-ext-items"/);
    assert.match(html, /id="blocked-account-items"/);
    assert.match(html, /Déjà bloqués sur votre compte/);
    const src = read('../src/ui/options.ts');
    assert.match(src, /alreadyBlockedOnly\(byExt, s\.blockedOnAccount\)/);
    assert.doesNotMatch(src, /innerHTML/);
  });
  it('le popup se met à jour quand l’ensemble change', () => {
    assert.match(read('../src/ui/popup.ts'), /changes\.blockedOnAccount/);
  });
});

describe('1.3.2 — glisser du bouton x.com', () => {
  const src = read('../src/content/inject.ts');
  it('capture du pointeur dès l’appui, fin aussi sur lostpointercapture', () => {
    const drag = src.slice(src.indexOf('function wireDrag'), src.indexOf('let lastPreviewOpen'));
    const down = drag.slice(drag.indexOf("'pointerdown'"), drag.indexOf("'pointermove'"));
    assert.match(down, /setPointerCapture\(e\.pointerId\)/);
    assert.match(drag, /addEventListener\('lostpointercapture', end\)/);
  });
  it('la nouvelle base est posée avant la fin de l’enregistrement', () => {
    const end = src.slice(src.indexOf('const end = '), src.indexOf("addEventListener('pointerup'"));
    assert.ok(end.indexOf('basePos = dropped') < end.indexOf('savePosition('));
  });
});
