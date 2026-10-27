import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseUserByScreenNameBody } from '../src/infra/xClient.ts';
import { frenchError, isPauseWorthy, isSkippable } from '../src/domain/errors.ts';

describe('parseUserByScreenNameBody', () => {
  it('ok with rest_id (legacy schema)', () => {
    const r = parseUserByScreenNameBody({
      data: { user: { result: { __typename: 'User', rest_id: '42', legacy: { screen_name: 'Foo' } } } },
    });
    assert.equal(r.status, 'ok');
    assert.equal(r.status === 'ok' && r.user.id, '42');
    assert.equal(r.status === 'ok' && r.user.handle, 'Foo');
  });
  it('ok with core.screen_name (2025+ schema)', () => {
    const r = parseUserByScreenNameBody({
      data: { user: { result: { __typename: 'User', rest_id: '7', core: { screen_name: 'Bar' } } } },
    });
    assert.equal(r.status === 'ok' && r.user.handle, 'Bar');
  });
  it('not-found when user null or data empty', () => {
    assert.equal(parseUserByScreenNameBody({ data: { user: null } }).status, 'not-found');
    assert.equal(parseUserByScreenNameBody({ data: {} }).status, 'not-found');
    assert.equal(parseUserByScreenNameBody({ data: { user: {} } }).status, 'not-found');
  });
  it('suspended UserUnavailable', () => {
    const r = parseUserByScreenNameBody({ data: { user: { result: { __typename: 'UserUnavailable' } } } });
    assert.equal(r.status, 'suspended');
  });
  it('throws resolver-failed on garbage (fail closed)', () => {
    assert.throws(() => parseUserByScreenNameBody('nope'), /UserByScreenName/);
    assert.throws(() => parseUserByScreenNameBody({ errors: [{ message: 'x' }] }), /UserByScreenName/);
  });
});

describe('error classification', () => {
  it('skippable vs pause', () => {
    assert.equal(isSkippable('not-found'), true);
    assert.equal(isSkippable('suspended'), true);
    assert.equal(isSkippable('resolver-failed'), false);
    assert.equal(isPauseWorthy('resolver-failed'), true);
    assert.equal(isPauseWorthy('not-found'), false);
  });
  it('french messages', () => {
    assert.match(frenchError('not-found'), /introuvable/i);
    assert.match(frenchError('resolver-failed'), /identifiant/i);
    assert.match(frenchError('network', 'dans 2 min'), /2 min/);
    assert.doesNotMatch(frenchError('not-found'), /not-found/);
  });
});
