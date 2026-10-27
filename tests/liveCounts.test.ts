import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPreview, liveCounts } from '../src/domain/preview.ts';

const rel = new Map([
  ['h:fol', { handle: 'fol', following: true, followedBy: false, blocking: false }],
  ['h:done', { handle: 'done', following: false, followedBy: false, blocking: true }],
]);

function rowsFor() {
  return buildPreview({
    entries: [{ handle: 'a' }, { handle: 'b' }, { handle: 'c' }, { handle: 'fol' }, { handle: 'done' }, { handle: 'safe' }],
    whitelist: [{ handle: 'safe' }],
    relationships: rel,
  });
}

describe('liveCounts (compteurs de l’aperçu)', () => {
  it('reflète l’état initial coché', () => {
    const rows = rowsFor();
    const keys = new Set(rows.filter((r) => r.checked).map((r) => r.key));
    assert.deepEqual(liveCounts(rows, keys), { selected: 3, toBlockChecked: 3, toBlockTotal: 3 });
  });

  it('se met à jour quand on décoche une case', () => {
    const rows = rowsFor();
    const keys = new Set(rows.filter((r) => r.checked).map((r) => r.key));
    keys.delete(rows.find((r) => r.handle === 'b')!.key);
    assert.deepEqual(liveCounts(rows, keys), { selected: 2, toBlockChecked: 2, toBlockTotal: 3 });
  });

  it('Tout décocher → 0, Tout cocher → toutes les lignes cochables', () => {
    const rows = rowsFor();
    assert.deepEqual(liveCounts(rows, new Set()), { selected: 0, toBlockChecked: 0, toBlockTotal: 3 });
    const all = new Set(rows.map((r) => r.key));
    // whitelisted + already-blocked ne comptent jamais ; "fol" (suivi) compte s'il est coché
    assert.deepEqual(liveCounts(rows, all), { selected: 4, toBlockChecked: 3, toBlockTotal: 3 });
  });

  it('l’UI recalcule les compteurs à chaque changement de case', () => {
    const src = readFileSync(new URL('../src/ui/preview.ts', import.meta.url), 'utf8');
    const upd = src.slice(src.indexOf('function updateStartEnabled'));
    assert.match(upd.slice(0, upd.indexOf('}') + 1), /renderCounts\(\)/);
    assert.match(src, /liveCounts\(rows, checkedKeys\(\)\)/);
    // pas de compteur figé issu du service worker pour « Cochés »
    assert.doesNotMatch(src, /counts\[['"]selected['"]\]/);
    assert.doesNotMatch(src, /innerHTML/);
  });
});

describe('règle no-innerHTML', () => {
  it('aucune affectation innerHTML/outerHTML/insertAdjacentHTML dans src/', async () => {
    const { readdirSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../src/', import.meta.url).pathname;
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((f) => {
        const p = join(d, f);
        return statSync(p).isDirectory() ? walk(p) : [p];
      });
    for (const f of walk(root).filter((f) => f.endsWith('.ts'))) {
      const src = readFileSync(f, 'utf8');
      assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/, f);
    }
  });
});
