import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  enqueue,
  remainingCap,
  applyBackoff,
  rollDay,
  todayKey,
  initialRunState,
  hitCap,
} from '../src/domain/queue.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';

describe('queue', () => {
  it('enqueues uniquely', () => {
    const a = enqueue([], [{ handle: 'A' }, { handle: 'A' }, { handle: 'B' }]);
    assert.equal(a.added, 2);
    assert.equal(a.queue.length, 2);
  });
  it('respects daily cap', () => {
    const state = { ...initialRunState(), actionsToday: 500 };
    assert.equal(remainingCap(state, { ...DEFAULT_SETTINGS, dailyCap: 500 }), 0);
  });
  it('backoff grows', () => {
    let s = initialRunState();
    s = applyBackoff(s, 1_000_000);
    assert.equal(s.backoffLevel, 1);
    assert.ok((s.resumeAt ?? 0) > 1_000_000);
    assert.equal(s.running, false);
  });
  it('rollDay resets', () => {
    const s = rollDay({ ...initialRunState(), dayKey: '1999-01-01', actionsToday: 42 });
    assert.equal(s.dayKey, todayKey());
    assert.equal(s.actionsToday, 0);
  });
  it('hitCap schedules tomorrow', () => {
    const s = hitCap(initialRunState());
    assert.equal(s.resumeReason, 'cap');
    assert.ok((s.resumeAt ?? 0) > Date.now());
  });
});
