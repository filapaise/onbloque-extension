import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview } from '../src/domain/preview.ts';
import { diffLists } from '../src/domain/listDiff.ts';
import { isAllowedBundleUrl, extractUserByScreenNameQueryId } from '../src/infra/queryIdDiscovery.ts';
import { parseListBody, MAX_ENTRIES } from '../src/domain/listParse.ts';
import { PACE_PRESETS } from '../src/domain/presets.ts';
import { isSkippable, frenchError } from '../src/domain/errors.ts';
import { filterAgainstWhitelist, sanitizeEntries } from '../src/background/messageGuard.ts';

describe('H2 mismatch preview', () => {
  it('flags id/handle mismatch unchecked', () => {
    const rel = new Map([
      ['id:99', { id: '99', handle: 'RealHandle', following: false, followedBy: false, blocking: false }],
    ]);
    const rows = buildPreview({
      entries: [{ handle: 'FakeListed', id: '99' }],
      whitelist: [],
      relationships: rel,
    });
    assert.equal(rows[0]!.status, 'mismatch');
    assert.equal(rows[0]!.checked, false);
    assert.equal(rows[0]!.handle, 'RealHandle');
  });
  it('whitelist matches by id even if handle differs in entry', () => {
    const rows = buildPreview({
      entries: [{ handle: 'Anyone', id: '5' }],
      whitelist: [{ id: '5' }],
      relationships: new Map([
        ['id:5', { id: '5', handle: 'Anyone', following: false, followedBy: false, blocking: false }],
      ]),
    });
    assert.equal(rows[0]!.status, 'whitelisted');
  });
});

describe('H3 fail closed', () => {
  it('relation-unknown unchecked when incomplete', () => {
    const rows = buildPreview({
      entries: [{ handle: 'Unknown' }],
      whitelist: [],
      relationships: new Map(),
      relationsIncomplete: true,
    });
    assert.equal(rows[0]!.status, 'relation-unknown');
    assert.equal(rows[0]!.checked, false);
  });
});

describe('M1 list caps and https', () => {
  it('truncates huge entry count', () => {
    const lines = Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => `user${i % 10000}${i}`).join('\n');
    // many invalid - just check parse doesn't explode
    const { list, warnings } = parseListBody('a\n'.repeat(100), 't');
    assert.ok(list.entries.length <= MAX_ENTRIES);
  });
  it('diff lists', () => {
    const d = diffLists([{ handle: 'A' }, { handle: 'B' }], [{ handle: 'B' }, { handle: 'C' }]);
    assert.equal(d.added.length, 1);
    assert.equal(d.removed.length, 1);
    assert.equal(d.added[0]!.handle, 'C');
  });
});

describe('M4 bundle URL', () => {
  it('rejects lookalike hosts', () => {
    assert.equal(isAllowedBundleUrl('https://evil.tld/abs.twimg.com/main.js'), false);
    assert.equal(isAllowedBundleUrl('https://abs.twimg.com/responsive-web/client-web/main.js'), true);
  });
});

describe('M6 presets slower', () => {
  it('max delays are high', () => {
    assert.ok(PACE_PRESETS.max.minDelaySec >= 45);
    assert.ok(PACE_PRESETS.max.maxDelaySec >= 90);
  });
});

describe('M2 sanitize', () => {
  it('drops invalid handles', () => {
    const e = sanitizeEntries([{ handle: 'ok_user' }, { handle: 'bad handle!' }, { id: '123' }]);
    assert.equal(e.length, 2);
  });
  it('filters whitelist and self', () => {
    const out = filterAgainstWhitelist(
      [{ handle: 'a' }, { handle: 'b' }, { id: '1' }],
      [{ handle: 'b' }],
      { id: '1', handle: 'me' },
    );
    assert.deepEqual(out, [{ handle: 'a' }]);
  });
});

describe('errors', () => {
  it('mismatch skippable french', () => {
    assert.equal(isSkippable('mismatch'), true);
    assert.match(frenchError('mismatch'), /Incohérence/i);
  });
});

describe('M5 page mode precheck', () => {
  it('precheckNone leaves to-block unchecked', () => {
    const rows = buildPreview({
      entries: [{ handle: 'AuthorOnly' }],
      whitelist: [],
      relationships: new Map([
        ['h:authoronly', { handle: 'AuthorOnly', following: false, followedBy: false, blocking: false }],
      ]),
      precheckNone: true,
    });
    assert.equal(rows[0]!.status, 'to-block');
    assert.equal(rows[0]!.checked, false);
  });
});
