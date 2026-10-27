import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTwidCookie } from '../src/infra/selfIdentity.ts';

describe('parseTwidCookie', () => {
  it('parses u%3D form', () => {
    assert.equal(parseTwidCookie('twid=u%3D123456789'), '123456789');
  });
  it('parses among other cookies', () => {
    assert.equal(
      parseTwidCookie('ct0=abc; twid=u%3D42; lang=fr'),
      '42',
    );
  });
  it('returns null when absent', () => {
    assert.equal(parseTwidCookie('ct0=abc'), null);
  });
});
