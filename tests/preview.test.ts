import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPreview, countByStatus } from '../src/domain/preview.ts';

describe('preview', () => {
  it('marks whitelist self following', () => {
    const rel = new Map([
      ['h:fol', { handle: 'fol', following: true, followedBy: false, blocking: false }],
      ['h:done', { handle: 'done', following: false, followedBy: false, blocking: true }],
    ]);
    const rows = buildPreview({
      entries: [
        { handle: 'me' },
        { handle: 'safe' },
        { handle: 'fol' },
        { handle: 'done' },
        { handle: 'new' },
      ],
      whitelist: [{ handle: 'safe' }],
      self: { handle: 'me' },
      relationships: rel,
      excludeFollowingByDefault: true,
    });
    const by = Object.fromEntries(rows.map((r) => [r.handle, r]));
    assert.equal(by.me!.status, 'self');
    assert.equal(by.safe!.status, 'whitelisted');
    assert.equal(by.fol!.status, 'following');
    assert.equal(by.fol!.checked, false);
    assert.equal(by.done!.status, 'already-blocked');
    assert.equal(by.new!.status, 'to-block');
    assert.equal(by.new!.checked, true);
    const c = countByStatus(rows);
    assert.equal(c.selected, 1);
  });
});
