import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseAccountRef, entryKey, dedupeEntries, handleFromHref } from '../src/domain/handle.ts';

describe('parseAccountRef', () => {
  it('parses @handle', () => {
    assert.deepEqual(parseAccountRef('@J_Bardella'), { handle: 'J_Bardella' });
  });
  it('parses url', () => {
    assert.deepEqual(parseAccountRef('https://x.com/MLP_officiel'), { handle: 'MLP_officiel' });
  });
  it('parses numeric id', () => {
    assert.deepEqual(parseAccountRef('123456789'), { id: '123456789' });
  });
  it('rejects reserved path', () => {
    assert.equal(parseAccountRef('https://x.com/home'), null);
  });
  it('parses /i/user/id', () => {
    assert.deepEqual(parseAccountRef('https://x.com/i/user/42'), { id: '42' });
  });
});

describe('entryKey / dedupe', () => {
  it('keys', () => {
    assert.equal(entryKey({ handle: 'AbC' }), 'h:abc');
    assert.equal(entryKey({ id: '1' }), 'id:1');
  });
  it('dedupes merge', () => {
    const out = dedupeEntries([
      { handle: 'Foo' },
      { handle: 'foo', id: '9' },
      { id: '9', name: 'X' },
    ]);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, '9');
    assert.equal(out[0]!.handle, 'Foo');
  });
});

describe('handleFromHref', () => {
  it('relative', () => {
    assert.equal(handleFromHref('/J_Bardella'), 'J_Bardella');
    assert.equal(handleFromHref('/home'), null);
  });
});
