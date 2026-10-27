import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BADGE_COLORS,
  badgeFor,
  computeProgress,
  countLabel,
  estimateEnd,
  etaLine,
  fabProgressOf,
  fmtDuration,
  nextLine,
  parseFabProgress,
} from '../src/domain/progress.ts';
import { initialRunState, todayKey } from '../src/domain/queue.ts';
import { applyPace } from '../src/domain/presets.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';
import type { RunState } from '../src/domain/types.ts';

const NOW = Date.UTC(2026, 9, 27, 20, 0, 0); // 21:00 Paris (UTC+1)
const max = applyPace(DEFAULT_SETTINGS, 'max');
const prudent = applyPace(DEFAULT_SETTINGS, 'prudent');
const run = (o: Partial<RunState> = {}): RunState => ({ ...initialRunState(), dayKey: todayKey(new Date(NOW)), ...o });

describe('progress — states and countdown', () => {
  it('running with a wait → countdown in seconds, never “stuck”', () => {
    const p = computeProgress(run({ running: true, nextActionAt: NOW + 37_000, batchDone: 33 }), 259, max, NOW);
    assert.equal(p.state, 'running');
    assert.equal(p.nextInSec, 37);
    assert.equal(nextLine(p), 'Prochain blocage dans 37 s');
    assert.equal(p.total, 292);
    assert.equal(p.done, 33);
    assert.ok(Math.abs(p.pct - 33 / 292) < 1e-9);
    assert.match(p.reason, /volontairement lent/);
  });
  it('countdown ticks down with time and hits “en cours” at 0', () => {
    const r = run({ running: true, nextActionAt: NOW + 3_000 });
    assert.equal(computeProgress(r, 5, max, NOW + 1_000).nextInSec, 2);
    assert.equal(nextLine(computeProgress(r, 5, max, NOW + 5_000)), 'Blocage en cours…');
  });
  it('long waits are shown in minutes', () => {
    assert.equal(fmtDuration(45), '45 s');
    assert.equal(fmtDuration(125), '2 min 5 s');
    assert.equal(fmtDuration(14 * 60), '14 min');
    assert.equal(fmtDuration(3 * 3600 + 5 * 60), '3 h 05');
  });
  it('idle / done', () => {
    assert.equal(computeProgress(run(), 0, max, NOW).state, 'idle');
    const d = computeProgress(run({ batchDone: 10, batchSkipped: 1 }), 0, max, NOW);
    assert.equal(d.state, 'done');
    assert.equal(d.pct, 1);
  });
  it('last blocked account is exposed', () => {
    const p = computeProgress(run({ running: true, lastBlocked: { handle: 'demo', at: NOW - 5000 } }), 3, max, NOW);
    assert.deepEqual(p.lastBlocked, { handle: 'demo', at: NOW - 5000 });
  });
  it('tolerates a run state saved by 1.2.4 (no new fields)', () => {
    const legacy = { ...run({ running: true }) } as Partial<RunState>;
    delete legacy.batchDone;
    delete legacy.nextActionAt;
    const p = computeProgress(legacy as RunState, 4, max, NOW);
    assert.equal(p.state, 'running');
    assert.equal(p.total, 4);
    assert.equal(p.nextInSec, 0);
  });
});

describe('progress — pause reasons with resume time (Paris)', () => {
  it('rate limit', () => {
    const p = computeProgress(run({ resumeAt: NOW + 14 * 60_000, resumeReason: 'rate-limit' }), 100, max, NOW);
    assert.equal(p.state, 'rate-limit');
    assert.equal(p.reason, 'X limite les requêtes pour l’instant. Reprise automatique à 21:14 (dans 14 min).');
    assert.equal(p.nextAt, NOW + 14 * 60_000);
  });
  it('daily cap → tomorrow 00:00', () => {
    const midnight = Date.UTC(2026, 9, 27, 23, 0, 0);
    const p = computeProgress(run({ resumeAt: midnight, resumeReason: 'cap', actionsToday: 500 }), 100, max, NOW);
    assert.equal(p.state, 'cap');
    assert.match(p.reason, /^Plafond du jour atteint \(500\)\. Reprise automatique demain à 00:00/);
  });
  it('transient error', () => {
    const p = computeProgress(
      run({ resumeAt: NOW + 120_000, resumeReason: 'error', lastError: 'X ne répond pas (HTTP 503).' }),
      10,
      max,
      NOW,
    );
    assert.equal(p.state, 'retry');
    assert.equal(p.reason, 'X ne répond pas (HTTP 503). Nouvel essai à 21:02 (dans 2 min).');
  });
  it('error that needs the user', () => {
    const p = computeProgress(run({ lastError: 'Session X introuvable' }), 10, max, NOW);
    assert.equal(p.state, 'error');
    assert.match(p.reason, /^En pause : Session X introuvable\. Appuyez sur Démarrer/);
  });
  it('manual pause', () => {
    const p = computeProgress(run(), 10, max, NOW);
    assert.equal(p.state, 'paused');
    assert.match(p.reason, /Démarrer pour reprendre/);
  });
  it('a past resumeAt is not shown as a pause reason', () => {
    const p = computeProgress(run({ running: true, resumeAt: NOW - 1000, resumeReason: 'rate-limit' }), 10, max, NOW);
    assert.equal(p.state, 'running');
  });
});

describe('progress — estimated end', () => {
  it('within today’s cap: avg delay × remaining + long pauses', () => {
    const r = run({ running: true, actionsToday: 0 });
    const { etaAt, etaDays } = estimateEnd(10, r, max, NOW);
    assert.equal(etaDays, 0);
    // 9 × 67.5 s ; pas de pause longue (tous les 20).
    assert.equal(etaAt, NOW + 9 * 67_500);
    const withPause = estimateEnd(25, r, max, NOW);
    assert.equal(withPause.etaAt, NOW + 24 * 67_500 + (300_000 - 67_500));
  });
  it('beyond today’s cap → days', () => {
    const r = run({ running: true, actionsToday: 40 });
    const fits = estimateEnd(10, r, prudent, NOW);
    assert.equal(fits.etaDays, 0);
    assert.ok(fits.etaAt && fits.etaAt > NOW);
    assert.equal(estimateEnd(60, r, prudent, NOW).etaDays, 1);
    assert.equal(estimateEnd(200, r, prudent, NOW).etaDays, 4);
  });
  it('eta line in Paris time', () => {
    const p = computeProgress(run({ running: true, nextActionAt: NOW + 30_000 }), 3, max, NOW);
    assert.equal(etaLine(p, max, NOW), 'Fin estimée vers 21:02');
    const many = computeProgress(run({ running: true, actionsToday: 45 }), 100, prudent, NOW);
    assert.equal(etaLine(many, prudent, NOW), 'Fin estimée dans ~2 jours (plafond de 50 par jour)');
    const tomorrow = computeProgress(run({ running: true, actionsToday: 45 }), 20, prudent, NOW);
    assert.equal(etaLine(tomorrow, prudent, NOW), 'Fin estimée demain (plafond de 50 par jour)');
  });
});

describe('progress — toolbar badge', () => {
  it('running: remaining count, blue; seconds when the popup is open', () => {
    const p = computeProgress(run({ running: true, nextActionAt: NOW + 37_000 }), 259, max, NOW);
    assert.deepEqual(
      { text: badgeFor(p).text, color: badgeFor(p).color },
      { text: '259', color: BADGE_COLORS.running },
    );
    assert.equal(badgeFor(p, { withSeconds: true }).text, '37s');
    assert.match(badgeFor(p).title, /259 en attente · prochain blocage dans 37 s/);
  });
  it('waiting for automatic resume: orange; error: red “!”; idle: empty', () => {
    const rl = computeProgress(run({ resumeAt: NOW + 60_000, resumeReason: 'rate-limit' }), 12, max, NOW);
    assert.equal(badgeFor(rl).color, BADGE_COLORS.waiting);
    assert.equal(badgeFor(rl).text, '12');
    const err = computeProgress(run({ lastError: 'x' }), 12, max, NOW);
    assert.equal(badgeFor(err).text, '!');
    assert.equal(badgeFor(err).color, BADGE_COLORS.error);
    assert.equal(badgeFor(computeProgress(run(), 0, max, NOW)).text, '');
  });
  it('badge text stays ≤ 4 chars', () => {
    for (const n of [1, 99, 999, 1000, 9999, 50_000]) assert.ok(countLabel(n).length <= 4, String(n));
  });
});

describe('progress — summary for x.com is counts only and validated', () => {
  it('no handles, no settings', () => {
    const p = computeProgress(
      run({ running: true, lastBlocked: { handle: 'secret_handle', at: NOW }, nextActionAt: NOW + 5000 }),
      3,
      max,
      NOW,
    );
    const fab = fabProgressOf(p);
    assert.deepEqual(Object.keys(fab).sort(), ['done', 'nextAt', 'pct', 'remaining', 'state', 'total']);
    assert.doesNotMatch(JSON.stringify(fab), /secret_handle/);
  });
  it('parseFabProgress rejects junk and clamps', () => {
    assert.equal(parseFabProgress(null), null);
    assert.equal(parseFabProgress({ state: 'hacked', remaining: 1, done: 0, total: 1 }), null);
    assert.equal(parseFabProgress({ state: 'running', remaining: -1, done: 0, total: 1 }), null);
    assert.equal(parseFabProgress({ state: 'running', remaining: '1', done: 0, total: 1 }), null);
    const ok = parseFabProgress({ state: 'running', remaining: 2, done: 1, total: 3, pct: 7, nextAt: 'x', extra: '<b>' });
    assert.deepEqual(ok, { state: 'running', remaining: 2, done: 1, total: 3, pct: 1, nextAt: null });
  });
});

describe('progress — no keep-alive timer in the service worker', () => {
  it('background code has no setInterval', () => {
    for (const f of ['../src/background/serviceWorker.ts', '../src/background/progressUi.ts', '../src/application/queueRunner.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      assert.doesNotMatch(src, /setInterval\(/, f);
    }
  });
  it('popup ticks the countdown itself (1 s)', () => {
    const src = readFileSync(new URL('../src/ui/popup.ts', import.meta.url), 'utf8');
    assert.match(src, /setInterval\(renderLive, 1000\)/);
  });
});
