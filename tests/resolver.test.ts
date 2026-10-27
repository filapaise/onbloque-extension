import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractUserByScreenNameQueryId } from '../src/infra/queryIdDiscovery.ts';
import { parseUserByScreenNameBody } from '../src/infra/xClient.ts';
import { frenchError, isPauseWorthy, isSkippable } from '../src/domain/errors.ts';

describe('extractUserByScreenNameQueryId', () => {
  it('finds queryId before operationName', () => {
    const id = extractUserByScreenNameQueryId(
      'foo queryId:"AMIBMjtxEEATh4z8V9GtRg",operationName:"UserByScreenName" bar',
    );
    assert.equal(id, 'AMIBMjtxEEATh4z8V9GtRg');
  });
  it('finds graphql path form', () => {
    const id = extractUserByScreenNameQueryId(
      'https://x.com/i/api/graphql/AbCdEfGhIjKlMnOp/UserByScreenName?x=1',
    );
    assert.equal(id, 'AbCdEfGhIjKlMnOp');
  });
  it('returns null when absent', () => {
    assert.equal(extractUserByScreenNameQueryId('nothing here'), null);
  });
});

describe('parseUserByScreenNameBody', () => {
  it('ok with rest_id', () => {
    const r = parseUserByScreenNameBody(
      JSON.stringify({
        data: {
          user: {
            result: {
              __typename: 'User',
              rest_id: '42',
              legacy: { screen_name: 'Foo' },
            },
          },
        },
      }),
    );
    assert.deepEqual(r, { status: 'ok', id: '42', handle: 'Foo' });
  });
  it('not-found when user null', () => {
    const r = parseUserByScreenNameBody(JSON.stringify({ data: { user: null } }));
    assert.equal(r.status, 'not-found');
  });
  it('suspended UserUnavailable', () => {
    const r = parseUserByScreenNameBody(
      JSON.stringify({
        data: { user: { result: { __typename: 'UserUnavailable' } } },
      }),
    );
    assert.equal(r.status, 'suspended');
  });
  it('failed on garbage', () => {
    assert.equal(parseUserByScreenNameBody('nope').status, 'failed');
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
    assert.match(frenchError('resolver-failed'), /résoudre|pause/i);
    assert.match(frenchError('network', 'dans 2 min'), /2 min/);
    assert.doesNotMatch(frenchError('not-found'), /not-found/);
  });
});
