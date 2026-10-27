import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyBlockResponse,
  blockUser,
  fetchUserSet,
  friendshipsLookup,
  gqlGet,
  identifySelf,
  parseTwid,
  parseUserTimelinePage,
  resolveUserId,
} from '../src/infra/xClient.ts';
import { lookupRelationships } from '../src/infra/xRelations.ts';
import { extractOperation, mergeOperation, FALLBACK_OPERATIONS } from '../src/infra/graphqlOps.ts';
import { XApiError, describeError } from '../src/domain/errors.ts';
import { gqlUser, makeCtx, staticOps, timelinePage } from './helpers.ts';

const notCalled = (calls: Array<{ url: string }>, frag: string) =>
  assert.equal(calls.some((c) => c.url.includes(frag)), false, `${frag} ne doit pas être appelé`);

describe('parseTwid', () => {
  it('reads encoded, plain and quoted forms', () => {
    assert.equal(parseTwid('u%3D123456789'), '123456789');
    assert.equal(parseTwid('"u=42"'), '42');
    assert.equal(parseTwid('u=7'), '7');
  });
  it('rejects garbage', () => {
    assert.equal(parseTwid(null), null);
    assert.equal(parseTwid('u%3Dabc'), null);
    assert.equal(parseTwid('%E0%A4%A'), null);
    assert.equal(parseTwid('x=1'), null);
  });
});

describe('identifySelf (verify_credentials retiré)', () => {
  it('twid + profile link → no network at all', async () => {
    const { ctx, calls } = makeCtx([]);
    const self = await identifySelf(ctx, { twidId: '111', profileHandle: 'moi' });
    assert.deepEqual(self, { id: '111', handle: 'moi' });
    assert.equal(calls.length, 0);
  });
  it('twid only → account/settings.json for the handle', async () => {
    const { ctx, calls } = makeCtx([{ match: 'account/settings.json', body: { screen_name: 'moi' } }]);
    assert.deepEqual(await identifySelf(ctx, { twidId: '111' }), { id: '111', handle: 'moi' });
    notCalled(calls, 'verify_credentials');
  });
  it('twid only, settings 404 → UsersByRestIds', async () => {
    const { ctx } = makeCtx([
      { match: 'account/settings.json', status: 404 },
      { match: '/UsersByRestIds', body: { data: { users: [{ result: gqlUser('111', 'moi') }] } } },
    ]);
    assert.deepEqual(await identifySelf(ctx, { twidId: '111' }), { id: '111', handle: 'moi' });
  });
  it('twid only, everything else down → id alone (still usable)', async () => {
    const { ctx } = makeCtx([]);
    assert.deepEqual(await identifySelf(ctx, { twidId: '111' }), { id: '111' });
  });
  it('no twid → settings handle → UserByScreenName id', async () => {
    const { ctx } = makeCtx([
      { match: 'account/settings.json', body: { screen_name: 'moi' } },
      { match: '/UserByScreenName', body: { data: { user: { result: gqlUser('222', 'Moi') } } } },
    ]);
    assert.deepEqual(await identifySelf(ctx, {}), { id: '222', handle: 'Moi' });
  });
  it('no twid, profile link → UserByScreenName without settings', async () => {
    const { ctx, calls } = makeCtx([
      { match: '/UserByScreenName', body: { data: { user: { result: gqlUser('333', 'Moi') } } } },
    ]);
    assert.deepEqual(await identifySelf(ctx, { profileHandle: 'Moi' }), { id: '333', handle: 'Moi' });
    notCalled(calls, 'settings.json');
  });
  it('nothing reliable → null (caller fails closed)', async () => {
    const { ctx } = makeCtx([]);
    assert.equal(await identifySelf(ctx, {}), null);
  });
  it('rate-limit propagates', async () => {
    const { ctx } = makeCtx([{ match: 'account/settings.json', status: 429 }]);
    await assert.rejects(identifySelf(ctx, {}), (e: XApiError) => e.code === 'rate-limit');
  });
});

describe('GraphQL operations', () => {
  const bundle =
    'e.exports={queryId:"OTHERqueryId0001",operationName:"Followers",operationType:"query",metadata:{featureSwitches:["a_flag"]}}' +
    ',e.exports={queryId:"NEWqueryIdForUBSN",operationName:"UserByScreenName",operationType:"query",metadata:{featureSwitches:["hidden_profile_subscriptions_enabled","brand_new_flag"],fieldToggles:["withAuxiliaryUserLabels"]}}';
  it('extracts the queryId of the right module and its features', () => {
    const op = extractOperation(bundle, 'UserByScreenName');
    assert.equal(op?.queryId, 'NEWqueryIdForUBSN');
    assert.deepEqual(op?.featureKeys, ['hidden_profile_subscriptions_enabled', 'brand_new_flag']);
    assert.equal(extractOperation(bundle, 'Followers')?.queryId, 'OTHERqueryId0001');
    assert.equal(extractOperation(bundle, 'Following'), null);
  });
  it('operationName-first form', () => {
    const op = extractOperation('{operationName:"Following",queryId:"abcdefghij123"}', 'Following');
    assert.equal(op?.queryId, 'abcdefghij123');
  });
  it('merge keeps known values and sends every required feature', () => {
    const op = mergeOperation('UserByScreenName', extractOperation(bundle, 'UserByScreenName')!);
    assert.deepEqual(op.features, { hidden_profile_subscriptions_enabled: true, brand_new_flag: false });
    assert.equal(op.fallback, false);
  });
  it('stale discovered queryId (404) → invalidate and retry with built-in one', async () => {
    const stale = { ...FALLBACK_OPERATIONS.UserByScreenName, queryId: 'STALEqueryId00', fallback: false };
    const { ops, invalidated } = staticOps({ UserByScreenName: stale });
    const { ctx, calls } = makeCtx(
      [
        { match: 'STALEqueryId00', status: 404, body: '' },
        { match: `${FALLBACK_OPERATIONS.UserByScreenName.queryId}/UserByScreenName`, body: { data: {} } },
      ],
      { ops },
    );
    assert.deepEqual(await gqlGet(ctx, 'UserByScreenName', { screen_name: 'x' }), { data: {} });
    assert.deepEqual(invalidated, ['UserByScreenName']);
    assert.equal(calls.length, 2);
  });
  it('built-in queryId 404 → endpoint-gone (no infinite retry)', async () => {
    const { ctx, calls } = makeCtx([{ match: '/UserByScreenName', status: 404, body: '' }]);
    await assert.rejects(gqlGet(ctx, 'UserByScreenName', {}), (e: XApiError) => e.code === 'endpoint-gone');
    assert.equal(calls.length, 1);
  });
});

describe('Following / Followers timelines', () => {
  it('parses users and bottom cursor', () => {
    const p = parseUserTimelinePage(timelinePage([['1', 'a'], ['2', 'b']], 'C1'));
    assert.deepEqual(p.users, [{ id: '1', handle: 'a' }, { id: '2', handle: 'b' }]);
    assert.equal(p.cursor, 'C1');
  });
  it('malformed timeline → guard-unavailable', () => {
    assert.throws(() => parseUserTimelinePage({ data: { user: { result: { timeline: {} } } } }), /Timeline/);
  });
  it('paginates until an empty page', async () => {
    let page = 0;
    const pages = [timelinePage([['1', 'a']], 'C1'), timelinePage([['2', 'b']], 'C2'), timelinePage([], 'C3')];
    const { ctx } = makeCtx([{ match: '/Following', body: undefined }]);
    ctx.fetchFn = async () => new Response(JSON.stringify(pages[page++]), { status: 200 });
    const set = await fetchUserSet(ctx, 'Following', '9', 10);
    assert.equal(set.complete, true);
    assert.deepEqual([...set.ids], ['1', '2']);
    assert.equal(set.handles.get('b'), '2');
  });
  it('stops at maxPages → incomplete', async () => {
    let n = 0;
    const { ctx } = makeCtx([]);
    ctx.fetchFn = async () => {
      n++;
      return new Response(JSON.stringify(timelinePage([[String(n), `u${n}`]], `C${n}`)), { status: 200 });
    };
    const set = await fetchUserSet(ctx, 'Following', '9', 3);
    assert.equal(set.complete, false);
    assert.equal(n, 3);
  });
});

describe('relationships with friendships/lookup gone', () => {
  const self = { id: '900', handle: 'moi' };
  const routes = [
    { match: 'friendships/lookup.json', status: 404, body: '' },
    { match: '/Following', body: timelinePage([['10', 'Ami']], null) },
    { match: '/Followers', body: timelinePage([['20', 'Fan']], null) },
    {
      match: '/UsersByRestIds',
      body: { data: { users: [{ result: gqlUser('30', 'VraiNom') }, { result: gqlUser('40', 'Bloque', { relationship_perspectives: { blocking: true } }) }] } },
    },
  ];
  it('falls back to GraphQL and keeps every guard', async () => {
    const { ctx } = makeCtx(routes);
    const r = await lookupRelationships(
      ctx,
      [{ handle: 'ami' }, { handle: 'Fan' }, { handle: 'Inconnu' }, { id: '30', handle: 'FauxNom' }, { id: '40' }],
      self,
      { withFollowers: true, verifyIds: true },
    );
    assert.equal(r.source, 'graphql');
    assert.equal(ctx.state.lookupGone, true);
    assert.equal(r.map.get('h:ami')?.following, true);
    assert.equal(r.map.get('h:ami')?.id, '10');
    assert.equal(r.map.get('h:fan')?.followedBy, true);
    assert.equal(r.map.get('h:inconnu')?.following, false);
    // id ↔ @ : X dit VraiNom pour l'id 30 → l'aperçu marquera « incohérence »
    assert.equal(r.map.get('id:30')?.handle, 'VraiNom');
    assert.equal(r.map.get('id:40')?.blocking, true);
    assert.ok(r.notes.length >= 1);
  });
  it('second call skips the dead 1.1 endpoint', async () => {
    const { ctx, calls } = makeCtx(routes, { lookupGone: true });
    await lookupRelationships(ctx, [{ handle: 'ami' }], self, { withFollowers: false, verifyIds: true });
    notCalled(calls, 'friendships/lookup');
    notCalled(calls, '/Followers');
  });
  it('Following unavailable → guard-unavailable (fail closed)', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup.json', status: 404 }, { match: '/Following', status: 500 }]);
    await assert.rejects(
      lookupRelationships(ctx, [{ handle: 'x' }], self, { withFollowers: false, verifyIds: true }),
      (e: XApiError) => e.code === 'guard-unavailable',
    );
  });
  it('UsersByRestIds unavailable with ids in list → refuse (no unchecked id ↔ @)', async () => {
    const { ctx } = makeCtx([
      { match: 'friendships/lookup.json', status: 404 },
      { match: '/Following', body: timelinePage([], null) },
      { match: '/UsersByRestIds', status: 500 },
    ]);
    await assert.rejects(
      lookupRelationships(ctx, [{ id: '1', handle: 'a' }], self, { withFollowers: false, verifyIds: true }),
      (e: XApiError) => e.code === 'resolver-failed',
    );
  });
  it('friendships/lookup 5xx is not mistaken for « gone »', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup.json', status: 503 }]);
    await assert.rejects(friendshipsLookup(ctx, [{ handle: 'a' }]), (e: XApiError) => e.code === 'network');
    assert.equal(ctx.state.lookupGone, false);
  });
});

describe('resolveUserId', () => {
  it('handle → UserByScreenName', async () => {
    const { ctx, calls } = makeCtx([
      { match: '/UserByScreenName', body: { data: { user: { result: gqlUser('5', 'Cible') } } } },
    ]);
    assert.deepEqual(await resolveUserId(ctx, { handle: 'cible' }), { ok: true, id: '5', handle: 'Cible' });
    notCalled(calls, 'friendships/lookup');
  });
  it('unknown handle → not-found (skipped, not paused)', async () => {
    const { ctx } = makeCtx([{ match: '/UserByScreenName', body: { data: {} } }]);
    assert.deepEqual(await resolveUserId(ctx, { handle: 'nobody' }), { ok: false, reason: 'not-found' });
  });
  it('id + wrong handle → mismatch via UsersByRestIds when 1.1 is gone', async () => {
    const { ctx } = makeCtx([
      { match: 'friendships/lookup.json', status: 404 },
      { match: '/UsersByRestIds', body: { data: { users: [{ result: gqlUser('8', 'Autre') }] } } },
    ]);
    assert.deepEqual(await resolveUserId(ctx, { id: '8', handle: 'Liste' }), { ok: false, reason: 'mismatch' });
  });
  it('UserByScreenName gone → falls back to friendships/lookup', async () => {
    const { ctx } = makeCtx([
      { match: '/UserByScreenName', status: 404 },
      { match: 'friendships/lookup.json', body: [{ id_str: '6', screen_name: 'Cible', connections: ['none'] }] },
    ]);
    assert.deepEqual(await resolveUserId(ctx, { handle: 'cible' }), { ok: true, id: '6', handle: 'Cible' });
  });
});

describe('blocks/create', () => {
  it('posts user_id of the resolved account', async () => {
    const { ctx, calls } = makeCtx([{ match: 'blocks/create.json', body: { id_str: '5' } }]);
    await blockUser(ctx, { id: '5', handle: 'Cible' });
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.body, 'user_id=5');
  });
  it('404 without X user error → endpoint-gone (pause, not skip)', () => {
    assert.equal(classifyBlockResponse(404, '<html>Not found</html>', 'blocks/create')?.code, 'endpoint-gone');
    assert.equal(classifyBlockResponse(404, '{"errors":[{"code":34}]}', 'blocks/create')?.code, 'endpoint-gone');
  });
  it('X user errors → skippable codes', () => {
    assert.equal(classifyBlockResponse(404, '{"errors":[{"code":50}]}', 'b')?.code, 'not-found');
    assert.equal(classifyBlockResponse(403, '{"errors":[{"code":63}]}', 'b')?.code, 'suspended');
    assert.equal(classifyBlockResponse(429, '', 'b')?.code, 'rate-limit');
    assert.equal(classifyBlockResponse(401, '', 'b')?.code, 'not-logged-in');
    assert.equal(classifyBlockResponse(200, '{}', 'b'), null);
  });
  it('french message names the dead endpoint', () => {
    const e = classifyBlockResponse(404, '', 'blocks/create')!;
    assert.match(describeError(e), /blocks\/create.*mise à jour/);
  });
});
