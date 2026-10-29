import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  accountLabel,
  batchCaption,
  blockedAccounts,
  profileUrl,
  totalBlocked,
  totalBlockedLine,
} from '../src/domain/history.ts';
import type { BlockedRecord } from '../src/domain/types.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('1.3.2 — total bloqué depuis le début (domaine)', () => {
  it('compte les comptes de blockedByExt, sans doublon (id ou @, casse ignorée)', () => {
    const recs: BlockedRecord[] = [
      { id: '1', handle: 'Alpha', at: 300 },
      { handle: 'alpha', at: 100 },
      { id: '1', at: 50 },
      { id: '2', handle: 'beta', at: 200 },
      { handle: 'gamma', at: 150 },
    ];
    assert.equal(totalBlocked(recs), 3);
    assert.deepEqual(
      blockedAccounts(recs).map((r) => r.handle ?? r.id),
      ['Alpha', 'beta', 'gamma'],
    );
  });

  it('du plus récent au plus ancien', () => {
    const out = blockedAccounts([
      { handle: 'old', at: 1 },
      { handle: 'new', at: 3 },
      { handle: 'mid', at: 2 },
    ]);
    assert.deepEqual(out.map((r) => r.handle), ['new', 'mid', 'old']);
  });

  it('robuste aux données invalides en stockage (0, jamais de NaN)', () => {
    assert.equal(totalBlocked(undefined), 0);
    assert.equal(totalBlocked(null), 0);
    assert.equal(totalBlocked('x' as unknown as BlockedRecord[]), 0);
    const weird = [
      null,
      {},
      { handle: '<img src=x onerror=alert(1)>', at: 1 },
      { id: 'abc', at: 1 },
      { handle: 'ok_1', at: Number.NaN },
    ] as unknown as BlockedRecord[];
    const out = blockedAccounts(weird);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.handle, 'ok_1');
    assert.equal(out[0]!.at, 0);
  });

  it('libellés : total, légende des tuiles, compte', () => {
    assert.equal(totalBlockedLine(0), 'Total bloqué depuis le début : 0');
    assert.match(totalBlockedLine(1234), /^Total bloqué depuis le début : 1\s?234$/);
    assert.equal(batchCaption(3), 'Lot en cours');
    assert.equal(batchCaption(0), 'Dernier lot');
    assert.equal(accountLabel({ handle: 'abc' }), '@abc');
    assert.equal(accountLabel({ id: '42' }), 'id 42');
  });

  it('liens de profil : x.com uniquement, @ valide ou id numérique', () => {
    assert.equal(profileUrl({ handle: 'abc_1' }), 'https://x.com/abc_1');
    assert.equal(profileUrl({ id: '42' }), 'https://x.com/i/user/42');
    assert.equal(profileUrl({ handle: 'javascript:alert(1)' }), null);
    assert.equal(profileUrl({ handle: '../evil' }), null);
    assert.equal(profileUrl({ handle: 'settings' }), null);
    assert.equal(profileUrl({}), null);
  });
});

describe('1.3.2 — stockage existant réutilisé (pushBlocked → total)', () => {
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

  it('chaque blocage réussi incrémente le total ; un historique existant est repris tel quel', async () => {
    const { pushBlocked } = await import('../src/infra/storage.ts');
    // Installation déjà utilisée (versions ≤ 1.3.1) : l'historique existant compte d'emblée.
    data.blockedByExt = [{ handle: 'ancien', at: 10 }];
    await pushBlocked({ id: '7', handle: 'nouveau', at: 20 }, ['id:7', 'h:nouveau']);
    await pushBlocked({ id: '8', handle: 'autre', at: 30 }, ['id:8', 'h:autre']);
    assert.equal(totalBlocked(data.blockedByExt as BlockedRecord[]), 3);
  });
});

describe('1.3.2 — popup et options', () => {
  const html = read('../static/popup.html');
  const src = read('../src/ui/popup.ts');

  it('le popup affiche le total et un lien « voir la liste » vers les options', () => {
    assert.match(html, /id="total-blocked-line"[^>]*>Total bloqué depuis le début : 0</);
    assert.match(html, /<a[^>]*id="total-link"[^>]*href="options\.html#bloques"[^>]*hidden[^>]*>voir la liste ›<\/a>/);
    assert.match(src, /totalBlockedUnion\(s\.blockedByExt, s\.blockedOnAccount\)/);
    assert.match(src, /\$\('total-link'\)\.hidden = total === 0/);
  });

  it('les tuiles décrivent le lot (légende « Lot en cours » / « Dernier lot »)', () => {
    assert.match(html, /id="stats-caption"/);
    assert.match(src, /s\.run\.batchDone/);
    assert.match(src, /s\.run\.batchSkipped/);
    assert.match(src, /s\.run\.batchSmall/);
    assert.doesNotMatch(src, /s\.run\.totalDone/);
  });

  it('le popup se rafraîchit quand l’historique change', () => {
    assert.match(src, /changes\.blockedByExt/);
  });

  it('les options ont la liste dépliable #bloques, rendue sans innerHTML', () => {
    const opt = read('../static/options.html');
    assert.match(opt, /<details class="blocked-list" id="bloques">/);
    const osrc = read('../src/ui/options.ts');
    assert.match(osrc, /renderAccountList\('ext'/);
    assert.match(osrc, /renderAccountList\('account'/);
    assert.match(osrc, /noopener noreferrer/);
    assert.doesNotMatch(osrc, /innerHTML/);
  });

  it('RESET_HISTORY vide l’historique (donc le total) et les compteurs du lot', () => {
    const sw = read('../src/background/serviceWorker.ts');
    const block = sw.slice(sw.indexOf("case 'RESET_HISTORY'"), sw.indexOf("case 'OPEN_PREVIEW'"));
    assert.match(block, /blockedByExt: \[\]/);
    assert.match(block, /alreadyBlockedKeys: \[\]/);
    assert.match(block, /blockedOnAccount: \[\]/);
    assert.match(block, /batchDone: 0/);
    assert.match(block, /batchSkipped: 0/);
    assert.match(block, /batchSmall: 0/);
  });
});
