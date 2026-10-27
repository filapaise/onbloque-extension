import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPace, nearestPace, PACE_PRESETS, DEFAULT_PACE } from '../src/domain/presets.ts';
import { DEFAULT_SETTINGS } from '../src/domain/types.ts';
import { normalizeSettings } from '../src/infra/storage.ts';

describe('pace presets', () => {
  it('maps prudent/normal/max', () => {
    assert.equal(PACE_PRESETS.prudent.dailyCap, 50);
    assert.equal(PACE_PRESETS.normal.dailyCap, 200);
    assert.equal(PACE_PRESETS.max.dailyCap, 500);
  });
  it('applyPace overwrites cap and delays', () => {
    const s = applyPace(DEFAULT_SETTINGS, 'normal');
    assert.equal(s.pace, 'normal');
    assert.equal(s.dailyCap, 200);
    assert.ok(s.minDelaySec >= 5);
    assert.equal(s.transport, 'tab');
  });
  it('nearestPace by cap', () => {
    assert.equal(nearestPace({ dailyCap: 40 }), 'prudent');
    assert.equal(nearestPace({ dailyCap: 180 }), 'normal');
    assert.equal(nearestPace({ dailyCap: 500 }), 'max');
    assert.equal(nearestPace({ pace: 'normal', dailyCap: 500 }), 'normal');
  });
  it('normalize migrates legacy settings without pace', () => {
    const s = normalizeSettings({
      listUrl: 'https://ex.test/l.json',
      dailyCap: 500,
      minDelaySec: 3,
      maxDelaySec: 8,
      transport: 'direct',
      autoRefresh: true,
    } as never);
    assert.equal(s.pace, 'max');
    assert.equal(s.dailyCap, 500);
    assert.equal(s.listUrl, 'https://ex.test/l.json');
    assert.equal(s.transport, 'tab');
    assert.equal(s.autoRefresh, false);
  });
  it('default pace is prudent', () => {
    assert.equal(DEFAULT_PACE, 'prudent');
    assert.equal(DEFAULT_SETTINGS.pace, 'prudent');
    assert.equal(DEFAULT_SETTINGS.dailyCap, 50);
    assert.ok(DEFAULT_SETTINGS.minDelaySec >= 20);
  });
});
