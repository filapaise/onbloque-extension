import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { XApiError } from '../src/domain/errors.ts';
import { buildPreview } from '../src/domain/preview.ts';
import { lookupRelationships } from '../src/infra/xRelations.ts';
import { guardTarget } from '../src/application/queueRunner.ts';
import { makeTabFetch } from '../src/infra/tabFetch.ts';
import { assertSenderAllowed, previewEntriesFor } from '../src/background/messageGuard.ts';
import type { BlockList } from '../src/domain/types.ts';
import type { Msg } from '../src/shared/messages.ts';
import { makeCtx, timelinePage } from './helpers.ts';

const EXT_ID = 'abcdefghijklmnop';
function stubChrome(executeResult?: unknown) {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { id: EXT_ID, getURL: (p: string) => `chrome-extension://${EXT_ID}/${p}` },
    scripting: { executeScript: async () => [{ result: executeResult }] },
  };
}

describe('content script → background (bug « liste vide »)', () => {
  beforeEach(() => stubChrome());
  const xTab = { id: EXT_ID, url: 'https://x.com/home', tab: { id: 3, url: 'https://x.com/home' } } as chrome.runtime.MessageSender;
  const page = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/popup.html` } as chrome.runtime.MessageSender;

  it('OPEN_PREVIEW list mode is allowed from x.com', () => {
    assert.doesNotThrow(() => assertSenderAllowed({ type: 'OPEN_PREVIEW', mode: 'list' }, xTab));
  });
  it('privileged messages stay refused from x.com', () => {
    for (const type of ['GET_STATUS', 'START_QUEUE', 'GET_LIST', 'SET_LIST'] as const) {
      assert.throws(() => assertSenderAllowed({ type } as Msg, xTab), /interdit/);
    }
  });
  it('extension pages keep GET_STATUS', () => {
    assert.doesNotThrow(() => assertSenderAllowed({ type: 'GET_STATUS' }, page));
  });
  it('foreign extension refused', () => {
    assert.throws(() => assertSenderAllowed({ type: 'PING' }, { id: 'other' } as chrome.runtime.MessageSender));
  });

  const stored: BlockList = {
    format: 'onbloque-list/1',
    name: 'seed',
    entries: Array.from({ length: 292 }, (_, i) => ({ handle: `compte${i}` })),
  };
  it('list mode uses the stored list (ignores anything sent by the page)', () => {
    const entries = previewEntriesFor({ mode: 'list', entries: [{ handle: 'intrus' }] }, stored);
    assert.equal(entries.length, 292);
    assert.equal(entries.some((e) => e.handle === 'intrus'), false);
  });
  it('list mode with no list → explicit message', () => {
    assert.throws(() => previewEntriesFor({ mode: 'list' }, null), /Aucune liste chargée/);
  });
  it('page mode sanitizes and caps entries', () => {
    const entries = previewEntriesFor({ entries: [{ handle: 'ok_1' }, { handle: 'pas valide!' }, { id: '12' }] }, null);
    assert.deepEqual(entries, [{ handle: 'ok_1' }, { id: '12' }]);
    assert.throws(() => previewEntriesFor({ entries: [{ handle: '!!' }] }, null), /Aucun compte valide/);
  });
});

describe('makeTabFetch', () => {
  it('network failure (status 0) → XApiError network instead of RangeError', async () => {
    stubChrome({ status: 0, body: 'TypeError: Failed to fetch' });
    await assert.rejects(makeTabFetch(1)('https://x.com/i/api/x'), (e: XApiError) => e.code === 'network');
  });
  it('204 → empty response', async () => {
    stubChrome({ status: 204, body: '' });
    const res = await makeTabFetch(1)('https://x.com/i/api/x');
    assert.equal(res.status, 204);
  });
  it('closed tab → no-tab', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      scripting: { executeScript: async () => { throw new Error('No tab with id: 1'); } },
    };
    await assert.rejects(makeTabFetch(1)('https://x.com/i/api/x'), (e: XApiError) => e.code === 'no-tab');
  });
});

describe('guardTarget (dernier garde-fou avant blocks/create)', () => {
  const self = { id: '900', handle: 'moi' };
  const gone = { match: 'friendships/lookup.json', status: 404 };
  it('self by resolved id', async () => {
    const { ctx, calls } = makeCtx([]);
    assert.equal(await guardTarget(ctx, { id: '900', handle: 'autrenom' }, self, []), 'vous');
    assert.equal(calls.length, 0);
  });
  it('whitelist by id', async () => {
    const { ctx } = makeCtx([]);
    assert.equal(await guardTarget(ctx, { id: '5', handle: 'x' }, self, [{ id: '5' }]), 'liste blanche');
  });
  it('followed account (GraphQL Following) is skipped', async () => {
    const { ctx } = makeCtx([gone, { match: '/Following', body: timelinePage([['5', 'Ami']], null) }]);
    assert.equal(await guardTarget(ctx, { id: '5', handle: 'Ami' }, self, []), 'vous le suivez');
  });
  it('not followed → null (block allowed)', async () => {
    const { ctx } = makeCtx([
      gone,
      { match: '/Following', body: timelinePage([['6', 'Ami']], null) },
    ]);
    assert.equal(await guardTarget(ctx, { id: '5', handle: 'Cible' }, self, []), null);
  });
  it('relations down → throws (queue pauses, nothing blocked)', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup.json', status: 500 }]);
    await assert.rejects(guardTarget(ctx, { id: '5', handle: 'c' }, self, []));
  });
  it('1.1 lookup silent about the target → guard-unavailable', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup.json', body: [] }]);
    await assert.rejects(guardTarget(ctx, { id: '5', handle: 'c' }, self, []), (e: XApiError) => e.code === 'guard-unavailable');
  });
});

describe('preview with GraphQL relations', () => {
  it('followed accounts are unchecked, id/@ mismatch flagged', async () => {
    const { ctx } = makeCtx([
      { match: 'friendships/lookup.json', status: 404 },
      { match: '/Following', body: timelinePage([['10', 'Ami']], null) },
      { match: '/Followers', body: timelinePage([], null) },
      { match: '/UsersByRestIds', body: { data: { users: [{ result: { __typename: 'User', rest_id: '30', core: { screen_name: 'VraiNom' } } }] } } },
    ]);
    const entries = [{ handle: 'Ami' }, { handle: 'Cible' }, { id: '30', handle: 'FauxNom' }];
    const { map } = await lookupRelationships(ctx, entries, { id: '900', handle: 'moi' }, { withFollowers: true, verifyIds: true });
    const rows = buildPreview({ entries, whitelist: [], self: { id: '900', handle: 'moi' }, relationships: map });
    assert.deepEqual(
      rows.map((r) => [r.status, r.checked]),
      [['following', false], ['to-block', true], ['mismatch', false]],
    );
  });
});
