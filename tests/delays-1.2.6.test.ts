/** 1.2.6 — délai réglable, rythme décrit exactement, compteurs du lot persistés, anneau/barre visibles. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  applyCustomDelay,
  applyPace,
  DELAY_CEIL_SEC,
  DELAY_FLOOR_SEC,
  delayAdjustNote,
  describePace,
  PACE_PRESETS,
  parseDelayInput,
  sanitizeDelays,
} from '../src/domain/presets.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';
import type { RunState } from '../src/domain/types.ts';
import { mergeSettingsPatch, normalizeSettings } from '../src/infra/storage.ts';
import { initialRunState, randomDelayMs, reconcileBatch, startBatch, todayKey } from '../src/domain/queue.ts';
import { computeProgress, estimateEnd, ringFraction } from '../src/domain/progress.ts';
import { nextActionTime } from '../src/application/queueRunner.ts';
import { defaultPosition, rectFor, clampPosition } from '../src/content/fabPosition.ts';

const NOW = Date.UTC(2026, 9, 27, 20, 0, 0);
const max = applyPace(DEFAULT_SETTINGS, 'max');

describe('1.2.6 — délais personnalisés : validation', () => {
  it('plancher 15 s, max ≥ min, plafond 900 s, arrondi', () => {
    assert.deepEqual(sanitizeDelays(20, 40), { minDelaySec: 20, maxDelaySec: 40 });
    assert.deepEqual(sanitizeDelays(3, 8), { minDelaySec: DELAY_FLOOR_SEC, maxDelaySec: DELAY_FLOOR_SEC });
    assert.deepEqual(sanitizeDelays(60, 30), { minDelaySec: 60, maxDelaySec: 60 });
    assert.deepEqual(sanitizeDelays(5000, 99999), { minDelaySec: DELAY_CEIL_SEC, maxDelaySec: DELAY_CEIL_SEC });
    assert.deepEqual(sanitizeDelays(17.6, 29.2), { minDelaySec: 18, maxDelaySec: 29 });
    assert.deepEqual(sanitizeDelays(-10, 0), { minDelaySec: 15, maxDelaySec: 15 });
  });
  it('garbage ignoré (texte, NaN, Infinity, null, objet)', () => {
    for (const [a, b] of [['20', 40], [20, '40'], [NaN, 40], [20, Infinity], [null, 40], [{}, []], [undefined, undefined]]) {
      assert.equal(sanitizeDelays(a, b), null, JSON.stringify([a, b]));
    }
  });
  it('saisie UI : nombres seulement', () => {
    assert.equal(parseDelayInput(' 30 '), 30);
    assert.equal(parseDelayInput('22,5'), 22.5);
    for (const bad of ['', 'abc', '-5', '1e3', '30s', '0x20']) assert.ok(Number.isNaN(parseDelayInput(bad)), bad);
  });
  it('message d’ajustement', () => {
    assert.match(delayAdjustNote(5, 30, { minDelaySec: 15, maxDelaySec: 30 }), /minimum 15 s/);
    assert.match(delayAdjustNote(40, 20, { minDelaySec: 40, maxDelaySec: 40 }), /inférieur au minimum/);
    assert.equal(delayAdjustNote(20, 40, { minDelaySec: 20, maxDelaySec: 40 }), '');
  });
});

describe('1.2.6 — délais personnalisés : réglages', () => {
  it('applyCustomDelay garde preset et plafond', () => {
    const s = applyCustomDelay(max, 15, 30);
    assert.equal(s.pace, 'max');
    assert.equal(s.dailyCap, 500);
    assert.equal(s.minDelaySec, 15);
    assert.equal(s.maxDelaySec, 30);
    assert.equal(s.customDelay, true);
  });
  it('choisir un preset remet les valeurs du preset', () => {
    const custom = mergeSettingsPatch(max, { customDelay: true, minDelaySec: 16, maxDelaySec: 20 });
    assert.equal(custom.minDelaySec, 16);
    const back = mergeSettingsPatch(custom, { pace: 'max' });
    assert.equal(back.customDelay, false);
    assert.equal(back.minDelaySec, PACE_PRESETS.max.minDelaySec);
    assert.equal(back.maxDelaySec, PACE_PRESETS.max.maxDelaySec);
    const normal = mergeSettingsPatch(custom, { pace: 'normal' });
    assert.equal(normal.minDelaySec, PACE_PRESETS.normal.minDelaySec);
    assert.equal(normal.customDelay, false);
  });
  it('patch : bornes appliquées, garbage → valeurs précédentes conservées', () => {
    const a = mergeSettingsPatch(max, { customDelay: true, minDelaySec: 2, maxDelaySec: 1 });
    assert.deepEqual([a.minDelaySec, a.maxDelaySec, a.customDelay], [15, 15, true]);
    const b = mergeSettingsPatch(a, { customDelay: true, minDelaySec: 'vite' as never, maxDelaySec: 30 });
    assert.deepEqual([b.minDelaySec, b.maxDelaySec, b.customDelay], [15, 15, true]);
  });
  it('patch : plafond/transport/pace invalide jamais repris du message', () => {
    const s = mergeSettingsPatch(max, { dailyCap: 99999, transport: 'direct', pace: 'turbo' as never } as never);
    assert.equal(s.dailyCap, 500);
    assert.equal(s.transport, 'tab');
    assert.equal(s.pace, 'max');
    assert.throws(() => mergeSettingsPatch(max, { listUrl: 'http://ex.test/l.json' }), /https/);
  });
  it('customDelay:false → retour au preset', () => {
    const c = mergeSettingsPatch(max, { customDelay: true, minDelaySec: 20, maxDelaySec: 25 });
    const d = mergeSettingsPatch(c, { customDelay: false });
    assert.equal(d.minDelaySec, 45);
    assert.equal(d.customDelay, false);
  });
  it('stockage : valeurs personnalisées validées au chargement, garbage ignoré', () => {
    const ok = normalizeSettings({ ...max, customDelay: true, minDelaySec: 18, maxDelaySec: 22 });
    assert.deepEqual([ok.minDelaySec, ok.maxDelaySec, ok.customDelay], [18, 22, true]);
    const clamped = normalizeSettings({ ...max, customDelay: true, minDelaySec: 1, maxDelaySec: 100000 });
    assert.deepEqual([clamped.minDelaySec, clamped.maxDelaySec], [15, 900]);
    const garbage = normalizeSettings({ ...max, customDelay: true, minDelaySec: 'x' as never, maxDelaySec: null as never });
    assert.deepEqual([garbage.minDelaySec, garbage.maxDelaySec, garbage.customDelay], [45, 90, false]);
    // Sans le drapeau, des délais modifiés à la main ne sont pas pris en compte.
    const sneaky = normalizeSettings({ ...max, minDelaySec: 1, maxDelaySec: 2 });
    assert.deepEqual([sneaky.minDelaySec, sneaky.maxDelaySec, sneaky.customDelay], [45, 90, false]);
  });
  it('la file tire ses délais dans les bornes personnalisées', () => {
    const s = applyCustomDelay(max, 15, 20);
    for (let i = 0; i < 300; i++) {
      const d = randomDelayMs(s);
      assert.ok(d >= 15_000 && d <= 20_000, String(d));
    }
  });
  it('compte à rebours / heure de fin utilisent les valeurs personnalisées', () => {
    const run: RunState = { ...initialRunState(), dayKey: todayKey(new Date(NOW)), running: true, actionsToday: 1 };
    const fast = applyCustomDelay(max, 20, 20);
    const slow = applyCustomDelay(max, 100, 100);
    const a = estimateEnd(5, run, fast, NOW).etaAt!;
    const b = estimateEnd(5, run, slow, NOW).etaAt!;
    assert.equal(a, NOW + 4 * 20_000);
    assert.equal(b, NOW + 4 * 100_000);
  });
});

describe('1.2.6 — rythme décrit exactement', () => {
  it('description générée depuis les presets', () => {
    assert.equal(
      describePace(max),
      'Un blocage toutes les 45 à 90 s, une pause de 5 min après chaque série de 20, 500 maximum par jour.',
    );
    assert.match(describePace(applyPace(DEFAULT_SETTINGS, 'prudent')), /20 à 45 s, une pause de 2 min après chaque série de 10, 50 maximum/);
    assert.match(describePace(applyPace(DEFAULT_SETTINGS, 'normal')), /25 à 55 s, une pause de 3 min après chaque série de 15, 200 maximum/);
    assert.match(describePace(applyCustomDelay(max, 15, 30)), /15 à 30 s \(personnalisé\)/);
  });
  it('le README annonce les mêmes valeurs que les presets', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    for (const p of Object.values(PACE_PRESETS)) {
      assert.ok(readme.includes(`${p.minDelaySec} à ${p.maxDelaySec} s`), `${p.id} délais`);
      assert.ok(readme.includes(`pause de ${p.pauseSec / 60} min tous les ${p.pauseEveryN}`), `${p.id} pause`);
    }
    assert.ok(readme.includes('15 s'), 'plancher des réglages avancés');
  });
  it('délai mesuré d’un début de blocage au suivant (pas après la fin des requêtes)', () => {
    assert.equal(nextActionTime(1_000_000, 1_006_000, 45_000), 1_045_000);
    // Requêtes plus longues que le délai : au moins 1 s après la fin.
    assert.equal(nextActionTime(1_000_000, 1_050_000, 45_000), 1_051_000);
  });
});

describe('1.2.6 — compteurs du lot persistés (rechargement)', () => {
  const t0 = NOW - 3600_000;
  const queue = Array.from({ length: 271 }, (_, i) => ({ key: `h:q${i}`, handle: `q${i}`, action: 'block' as const, addedAt: t0, attempts: 0 }));
  const blocked = [
    ...Array.from({ length: 18 }, (_, i) => ({ handle: `b${i}`, at: t0 + (i + 1) * 60_000 })),
    { handle: 'old', at: t0 - 86_400_000 },
  ];
  it('état venu d’une version sans compteur de lot → 18 / 289, pas 0 / 271', () => {
    const legacy = { ...initialRunState(), running: true } as RunState;
    delete legacy.batchDone;
    delete legacy.batchStartedAt;
    const run = reconcileBatch(legacy, queue, blocked);
    assert.equal(run.batchDone, 18);
    assert.equal(run.batchStartedAt, t0);
    const p = computeProgress(run, queue.length, max, NOW);
    assert.equal(p.done, 18);
    assert.equal(p.total, 289);
  });
  it('compteur persisté plus grand (déblocages) conservé ; valeurs invalides → 0', () => {
    assert.equal(reconcileBatch({ ...initialRunState(), batchDone: 40, batchStartedAt: t0 }, queue, blocked).batchDone, 40);
    const bad = reconcileBatch({ ...initialRunState(), batchDone: 'x' as never, batchSkipped: -3 }, [], []);
    assert.equal(bad.batchDone, 0);
    assert.equal(bad.batchSkipped, 0);
  });
  it('nouveau lot : remis à zéro et daté (les anciens blocages ne comptent plus)', () => {
    const run = startBatch({ ...initialRunState(), batchDone: 18 }, NOW);
    assert.equal(run.batchDone, 0);
    assert.equal(run.batchStartedAt, NOW);
    assert.equal(reconcileBatch(run, queue, blocked).batchDone, 0);
  });
  it('file vide : pas de recomptage', () => {
    const run = { ...initialRunState(), batchDone: 0, batchStartedAt: null };
    assert.equal(reconcileBatch(run, [], blocked).batchDone, 0);
  });
  it('survit à un « rechargement » : loadStore relit les compteurs depuis chrome.storage', async () => {
    const mem: Record<string, unknown> = {
      run: { ...initialRunState(), running: true }, // pas de batchDone (ancienne version)
      queue,
      blockedByExt: blocked,
    };
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (k: string[]) => Object.fromEntries(k.filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])])),
          set: async (o: Record<string, unknown>) => void Object.assign(mem, o),
        },
      },
    };
    const { loadStore } = await import('../src/infra/storage.ts');
    const store = await loadStore();
    assert.equal(store.run.batchDone, 18);
  });
});

describe('1.2.6 — visibilité (barre, anneau, position)', () => {
  it('la barre du popup n’utilise plus la classe « .bar » de l’en-tête', () => {
    const html = readFileSync(new URL('../static/popup.html', import.meta.url), 'utf8');
    assert.match(html, /class="pbar"/);
    assert.doesNotMatch(html, /class="bar"/);
    const css = readFileSync(new URL('../static/styles.css', import.meta.url), 'utf8');
    assert.match(css, /\.pbar \{[^}]*height: 10px/);
    assert.match(css, /\.pbar-fg\.some \{ min-width: 10px; \}/);
  });
  it('anneau du bouton : arc toujours visible dès le premier compte', () => {
    assert.equal(ringFraction(0), 0);
    assert.equal(ringFraction(NaN), 0);
    assert.equal(ringFraction(18 / 289), 18 / 289);
    assert.equal(ringFraction(0.001), 0.06);
    assert.equal(ringFraction(2), 1);
    const src = readFileSync(new URL('../src/content/inject.ts', import.meta.url), 'utf8');
    assert.match(src, /const RING_W = 4;/);
    assert.match(src, /\.trk\{stroke:rgba\(15,20,25,\.55\)/);
  });
  it('position par défaut : ≥ 40 px au-dessus de la pastille Grok / du bouton Poster', () => {
    for (const vp of [{ width: 1280, height: 800 }, { width: 1920, height: 1080 }]) {
      const r = rectFor(clampPosition(defaultPosition(vp), vp), vp);
      const grokTop = vp.height - 53 - 12 - 56;
      assert.ok(grokTop - r.bottom >= 40, `${vp.width}: ${grokTop - r.bottom}`);
    }
    const m = { width: 375, height: 667 };
    const r = rectFor(clampPosition(defaultPosition(m), m), m);
    assert.ok(m.height - 53 - 16 - 56 - r.bottom >= 40);
  });
  it('Options : « Réglages avancés » replié, avertissement, bornes 15 s', () => {
    const html = readFileSync(new URL('../static/options.html', import.meta.url), 'utf8');
    assert.match(html, /<details class="pace-adv" id="pace-adv">\s*<summary>Réglages avancés<\/summary>/);
    assert.match(html, /id="delay-min" type="number" min="15"/);
    assert.match(html, /risque de restreindre/);
  });
});
