/**
 * 1.2.4 — file d'attente résiliente : rate limit, résolution groupée, cache @→id,
 * « Ignoré » au lieu de pause, queryId périmé, onglet x.com, diagnostic.
 */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// --- chrome.storage.local en mémoire (avant les imports qui l'utilisent) ---
const mem: Record<string, unknown> = {};
const tabsState: { tabs: chrome.tabs.Tab[]; created: unknown[]; reloaded: number[] } = { tabs: [], created: [], reloaded: [] };
let scriptImpl: (args: unknown[]) => unknown = () => null;
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])]));
      },
      set: async (o: Record<string, unknown>) => Object.assign(mem, structuredClone(o)),
      remove: async (k: string) => void delete mem[k],
    },
  },
  tabs: {
    query: async () => tabsState.tabs,
    get: async (id: number) => {
      const t = tabsState.tabs.find((x) => x.id === id);
      if (!t) throw new Error('No tab');
      return t;
    },
    create: async (o: { url: string; active: boolean }) => {
      tabsState.created.push(o);
      const t = { id: 99, url: o.url, active: o.active, status: 'complete', discarded: false } as chrome.tabs.Tab;
      tabsState.tabs.push(t);
      return t;
    },
    reload: async (id: number) => {
      tabsState.reloaded.push(id);
      const t = tabsState.tabs.find((x) => x.id === id)!;
      t.discarded = false;
      t.status = 'complete';
    },
  },
  scripting: {
    executeScript: async (o: { args?: unknown[] }) => [{ result: scriptImpl(o.args ?? []) }],
  },
};

const { decideOnError, resolveHead } = await import('../src/application/queueRunner.ts');
const { XApiError, fmtClock, parseRateLimitReset, rateLimitResumeAt, TRANSIENT_BACKOFF_MS, frenchError } = await import(
  '../src/domain/errors.ts'
);
const { friendshipsLookup, gqlGet, classifyBlockResponse, resolveUserId } = await import('../src/infra/xClient.ts');
const { guardTarget } = await import('../src/application/queueRunner.ts');
const idc = await import('../src/infra/idCache.ts');
const { makeDiag } = await import('../src/infra/diagnostics.ts');
const { buildPreview } = await import('../src/domain/preview.ts');
const { ensureXTab, makeTabFetch } = await import('../src/infra/tabFetch.ts');
const { FALLBACK_OPERATIONS } = await import('../src/infra/graphqlOps.ts');
const { initialRunState } = await import('../src/domain/queue.ts');
const { gqlUser, makeCtx, staticOps } = await import('./helpers.ts');

const NOW = Date.UTC(2026, 9, 27, 21, 0, 0); // 22:00 Paris
const run0 = () => ({ ...initialRunState(), running: true });
const q = (handle?: string, id?: string) => ({ key: id ? `id:${id}` : `h:${handle}`, handle, id, action: 'block' as const, addedAt: 0, attempts: 0 });
const lookupRoute = (users: Array<[string, string, string[]?]>) => ({
  match: 'friendships/lookup',
  body: users.map(([id, h, c]) => ({ id_str: id, screen_name: h, connections: c ?? ['none'] })),
});

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  tabsState.tabs = [];
  tabsState.created = [];
  tabsState.reloaded = [];
});

describe('rate limit (429)', () => {
  it('parses x-rate-limit-reset (seconds) and rejects absurd values', () => {
    assert.equal(parseRateLimitReset(String(NOW / 1000 + 600), NOW), NOW + 600_000);
    assert.equal(parseRateLimitReset('abc', NOW), undefined);
    assert.equal(parseRateLimitReset(String(NOW / 1000 + 3 * 86400), NOW), undefined);
  });
  it('resume = reset + 30 s, else 15 min, bounded 1 min … 3 h', () => {
    assert.equal(rateLimitResumeAt(NOW + 600_000, NOW), NOW + 630_000);
    assert.equal(rateLimitResumeAt(undefined, NOW), NOW + 15 * 60_000);
    assert.equal(rateLimitResumeAt(NOW - 10_000, NOW), NOW + 60_000);
    assert.equal(rateLimitResumeAt(NOW + 10 * 3600_000, NOW), NOW + 3 * 3600_000);
  });
  it('decision: no error state, automatic resume at HH:MM (Paris)', () => {
    const err = new XApiError('friendships/lookup : rate-limit', 429, 'rate-limit', '', NOW + 600_000);
    const d = decideOnError(err, run0(), 0, NOW);
    assert.equal(d.kind, 'rate-limit');
    assert.ok('resumeAt' in d && d.resumeAt === NOW + 630_000);
    assert.equal(fmtClock(NOW + 630_000), '22:10');
    assert.equal(d.message, 'Limite X atteinte, reprise automatique à 22:10');
    assert.equal(d.run.resumeReason, 'rate-limit');
  });
  it('httpError carries resetAt from the header (friendships/lookup)', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 900);
    const { ctx } = makeCtx([{ match: 'friendships/lookup', status: 429, body: '{}', headers: { 'x-rate-limit-reset': reset } }]);
    await assert.rejects(friendshipsLookup(ctx, [{ handle: 'a' }]), (e: InstanceType<typeof XApiError>) => {
      assert.equal(e.code, 'rate-limit');
      assert.equal(e.resetAt, Number(reset) * 1000);
      return true;
    });
  });
  it('error code 88 in a 200/403 body is also a rate limit', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup', status: 403, body: { errors: [{ code: 88 }] } }]);
    await assert.rejects(friendshipsLookup(ctx, [{ handle: 'a' }]), (e: InstanceType<typeof XApiError>) => e.code === 'rate-limit');
  });
  it('blocks/create 429 keeps resetAt', () => {
    const e = classifyBlockResponse(429, '{}', 'blocks/create', NOW + 1000)!;
    assert.equal(e.code, 'rate-limit');
    assert.equal(e.resetAt, NOW + 1000);
  });
  it('tab fetch forwards only the rate-limit headers', async () => {
    scriptImpl = () => ({ status: 429, body: '{}', rl: { reset: '1800000000', remaining: '0' } });
    const res = await makeTabFetch(1)('https://x.com/i/api/1.1/friendships/lookup.json');
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-rate-limit-reset'), '1800000000');
    assert.equal(res.headers.get('x-rate-limit-remaining'), '0');
  });
});

describe('error policy: skip one account, never pause the whole queue for it', () => {
  it('not-found / suspended / mismatch / protected → skip', () => {
    for (const code of ['not-found', 'suspended', 'mismatch', 'protected'] as const) {
      assert.equal(decideOnError(new XApiError(code, 0, code), run0(), 0, NOW).kind, 'skip');
    }
  });
  it('transient X/tab errors → automatic resume with growing delay, nothing blocked', () => {
    const err = new XApiError('friendships/lookup 503', 503, 'network');
    const d0 = decideOnError(err, run0(), 0, NOW);
    assert.equal(d0.kind, 'retry-later');
    assert.ok('resumeAt' in d0 && d0.resumeAt === NOW + TRANSIENT_BACKOFF_MS[0]!);
    assert.match(d0.message, /HTTP 503/);
    assert.match(d0.message, /reprise automatique à \d\d:\d\d/);
    const d1 = decideOnError(err, { ...run0(), backoffLevel: 1 }, 0, NOW);
    assert.ok('resumeAt' in d1 && d1.resumeAt === NOW + TRANSIENT_BACKOFF_MS[1]!);
  });
  it('after all automatic retries → pause pointing to Diagnostic', () => {
    const d = decideOnError(new XApiError('no-tab', 0, 'no-tab'), { ...run0(), backoffLevel: TRANSIENT_BACKOFF_MS.length }, 0, NOW);
    assert.equal(d.kind, 'pause');
    assert.match(d.message, /Diagnostic/);
    assert.match(d.message, /onglet x\.com/);
  });
  it('auth loss → immediate pause with an accurate message', () => {
    const d = decideOnError(new XApiError('not-logged-in', 401, 'not-logged-in'), run0(), 0, NOW);
    assert.equal(d.kind, 'pause');
    assert.match(d.message, /déconnecté/);
    assert.equal(d.run.resumeAt, null);
  });
  it('403 on one account → 3 spaced tries then ignored', () => {
    const err = new XApiError('forbidden', 403, 'forbidden');
    assert.equal(decideOnError(err, run0(), 0, NOW).kind, 'retry-item');
    assert.equal(decideOnError(err, run0(), 2, NOW).kind, 'skip');
  });
  it('the old 1.2.2 message is gone', () => {
    assert.doesNotMatch(frenchError('resolver-failed'), /rouvrez un onglet/);
  });
});

describe('friendships/lookup 404 code 17 = no matching user (not endpoint gone)', () => {
  it('returns an empty map and keeps friendships/lookup enabled', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup', status: 404, body: { errors: [{ code: 17, message: 'No user matches for specified terms.' }] } }]);
    const map = await friendshipsLookup(ctx, [{ handle: 'compte_supprime' }]);
    assert.equal(map.size, 0);
    assert.equal(ctx.state.lookupGone, false);
  });
  it('resolveUserId by id → not-found (skip) instead of endpoint switch', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup', status: 404, body: { errors: [{ code: 17 }] } }]);
    assert.deepEqual(await resolveUserId(ctx, { id: '5' }), { ok: false, reason: 'not-found' });
    assert.equal(ctx.state.lookupGone, false);
  });
});

describe('batch resolution + persistent cache', () => {
  it('pickBatch: handle-only items, no duplicates, skips cached, max size', () => {
    const cache = { cached: { s: 'ok' as const, id: '1', h: 'cached', at: NOW } };
    const queue = [q('A'), q('a'), q(undefined, '9'), q('cached'), q('B'), q('C')];
    assert.deepEqual(idc.pickBatch(queue, cache, NOW), ['A', 'B', 'C']);
    assert.deepEqual(idc.pickBatch(queue, cache, NOW, 2), ['A', 'B']);
  });
  it('one request resolves 100 handles, absent ones are marked', async () => {
    const { ctx, calls } = makeCtx([lookupRoute([['1', 'Alpha'], ['2', 'beta']])]);
    const got = (await idc.batchResolveHandles(ctx, ['alpha', 'Beta', 'ghost'], NOW))!;
    assert.equal(calls.length, 1);
    assert.deepEqual(got.alpha, { s: 'ok', id: '1', h: 'Alpha', at: NOW });
    assert.deepEqual(got.ghost, { s: 'absent', at: NOW });
  });
  it('250 handles → 3 requests', async () => {
    const { ctx, calls } = makeCtx([lookupRoute([])]);
    await idc.batchResolveHandles(ctx, Array.from({ length: 250 }, (_, i) => `h${i}`), NOW);
    assert.equal(calls.length, 3);
  });
  it('friendships/lookup gone → null (caller resolves one by one)', async () => {
    const { ctx } = makeCtx([{ match: 'friendships/lookup', status: 404, body: '{}' }]);
    assert.equal(await idc.batchResolveHandles(ctx, ['a'], NOW), null);
    assert.equal(ctx.state.lookupGone, true);
  });
  it('TTL: ok 7 days, absent 12 h', () => {
    const c = { a: { s: 'ok' as const, id: '1', h: 'a', at: NOW }, b: { s: 'absent' as const, at: NOW } };
    assert.ok(idc.cacheGet(c, 'A', NOW + 6 * 86400_000));
    assert.equal(idc.cacheGet(c, 'a', NOW + 8 * 86400_000), null);
    assert.equal(idc.cacheGet(c, 'b', NOW + 13 * 3600_000), null);
  });
  it('preview relations seed the cache (absent included)', () => {
    const map = new Map([['h:alpha', { id: '1', handle: 'Alpha' }]]);
    const c = idc.idCacheFromRelations([{ handle: 'alpha' }, { handle: 'ghost' }, { handle: 'x', id: '3' }], map, NOW);
    assert.deepEqual(Object.keys(c).sort(), ['alpha', 'ghost']);
    assert.equal(c.ghost!.s, 'absent');
  });
});

describe('resolveHead (queue head)', () => {
  it('handle-only: batch lookup then id↔@ check, result cached → retry needs no re-resolve', async () => {
    const { ctx, calls } = makeCtx([lookupRoute([['1', 'Alpha'], ['2', 'Beta']])]);
    const queue = [q('Alpha'), q('Beta')];
    assert.deepEqual(await resolveHead(ctx, queue[0]!, queue), { id: '1', handle: 'Alpha' });
    const firstCalls = calls.length;
    assert.ok(firstCalls <= 2);
    assert.equal((mem.resolvedIds as Record<string, { id: string }>).beta!.id, '2');
    ctx.state.relMemo?.clear();
    await resolveHead(ctx, queue[1]!, queue.slice(1));
    // Beta : uniquement la vérification par id, aucune nouvelle résolution groupée.
    const after = calls.slice(firstCalls);
    assert.equal(after.length, 1);
    assert.match(after[0]!.url, /user_id=2/);
  });
  it('v1.2.2 bug: deleted account → GraphQL {"data":{}} → skipped as not-found, queue continues', async () => {
    const { ctx } = makeCtx([
      { match: 'friendships/lookup', status: 404, body: { errors: [{ code: 17 }] } },
      { match: '/UserByScreenName', body: { data: {} } },
    ]);
    const head = q('compte_supprime');
    await assert.rejects(resolveHead(ctx, head, [head]), (e: InstanceType<typeof XApiError>) => {
      assert.equal(e.code, 'not-found');
      assert.equal(decideOnError(e, run0(), 0, NOW).kind, 'skip');
      return true;
    });
    assert.equal((mem.resolvedIds as Record<string, { s: string }>).compte_supprime!.s, 'absent');
  });
  it('absent from lookup + GraphQL broken → still skipped (not a whole-queue pause)', async () => {
    const { ctx } = makeCtx([
      lookupRoute([['1', 'other']]),
      { match: '/UserByScreenName', status: 500, body: '{}' },
    ]);
    const head = q('ghost');
    await assert.rejects(resolveHead(ctx, head, [head, q('other')]), (e: InstanceType<typeof XApiError>) => e.code === 'not-found');
  });
  it('absent + rate limit on confirmation → rate-limit (resume later), not skip', async () => {
    const { ctx } = makeCtx([
      lookupRoute([]),
      { match: '/UserByScreenName', status: 429, body: '{}' },
    ]);
    mem.resolvedIds = { ghost: { s: 'absent', at: Date.now() } };
    const head = q('ghost');
    await assert.rejects(resolveHead(ctx, head, [head]), (e: InstanceType<typeof XApiError>) => e.code === 'rate-limit');
  });
  it('cached id now carries another @ (renamed) → re-resolve by @', async () => {
    mem.resolvedIds = { target: { s: 'ok', id: '7', h: 'target', at: Date.now() } };
    const { ctx } = makeCtx([
      { match: /friendships\/lookup.*user_id=7/, body: [{ id_str: '7', screen_name: 'renamed', connections: ['none'] }] },
      { match: '/UserByScreenName', body: { data: { user: { result: gqlUser('8', 'target') } } } },
    ]);
    const head = q('target');
    assert.deepEqual(await resolveHead(ctx, head, [head]), { id: '8', handle: 'target' });
  });
  it('resolve + following guard share one friendships/lookup (memo 10 s)', async () => {
    const { ctx, calls } = makeCtx([lookupRoute([['1', 'Alpha', ['none']]])]);
    const head = q('Alpha', '1');
    const t = await resolveHead(ctx, head, [head]);
    assert.equal(await guardTarget(ctx, t, { id: '42', handle: 'moi' }, []), null);
    assert.equal(calls.length, 1);
  });
  it('guard still refuses a followed account (fresh relation)', async () => {
    const { ctx } = makeCtx([lookupRoute([['1', 'Alpha', ['following']]])]);
    const head = q('Alpha', '1');
    const t = await resolveHead(ctx, head, [head]);
    assert.equal(await guardTarget(ctx, t, { id: '42', handle: 'moi' }, []), 'vous le suivez');
  });
});

describe('stale GraphQL queryId', () => {
  it('discovered id 404 → re-discover once → retry with the new id', async () => {
    const stale = { ...FALLBACK_OPERATIONS.UserByScreenName, queryId: 'STALEstaleSTALE', fallback: false };
    const { ops } = staticOps({ UserByScreenName: stale });
    const fresh = { ...stale, queryId: 'FRESHfreshFRESH' };
    let refreshes = 0;
    ops.refresh = async () => (refreshes++ === 0 ? fresh : null);
    const { ctx, calls } = makeCtx(
      [
        { match: '/STALEstaleSTALE/', status: 404, body: '' },
        { match: '/FRESHfreshFRESH/', body: { data: { user: { result: gqlUser('1', 'a') } } } },
      ],
      { ops },
    );
    await gqlGet(ctx, 'UserByScreenName', { screen_name: 'a' });
    assert.equal(calls.length, 2);
    assert.equal(refreshes, 1);
  });
  it('embedded id 400 → re-discovery finds a new id → retry', async () => {
    const { ops } = staticOps();
    ops.refresh = async () => ({ ...FALLBACK_OPERATIONS.UserByScreenName, queryId: 'NEWnewNEWnew', fallback: false });
    const { ctx, calls } = makeCtx(
      [
        { match: `/${FALLBACK_OPERATIONS.UserByScreenName.queryId}/`, status: 400, body: '' },
        { match: '/NEWnewNEWnew/', body: { data: { user: { result: gqlUser('1', 'a') } } } },
      ],
      { ops },
    );
    await gqlGet(ctx, 'UserByScreenName', { screen_name: 'a' });
    assert.equal(calls.length, 2);
  });
  it('nothing new → no retry loop, endpoint-gone (transient)', async () => {
    const { ops } = staticOps();
    ops.refresh = async () => null;
    const { ctx, calls } = makeCtx([{ match: '/UserByScreenName', status: 400, body: '' }], { ops });
    await assert.rejects(gqlGet(ctx, 'UserByScreenName', { screen_name: 'a' }), (e: InstanceType<typeof XApiError>) => e.code === 'endpoint-gone');
    assert.equal(calls.length, 1);
  });
});

describe('x.com tab for the background queue', () => {
  it('no x.com tab → opens one in the background (inactive)', async () => {
    const r = await ensureXTab();
    assert.equal(r.opened, true);
    assert.deepEqual(tabsState.created, [{ url: 'https://x.com/home', active: false }]);
  });
  it('tab discarded by Chrome memory saver → reloaded', async () => {
    tabsState.tabs = [{ id: 5, active: false, discarded: true, status: 'unloaded' } as chrome.tabs.Tab];
    const r = await ensureXTab();
    assert.deepEqual(r, { tabId: 5, opened: false, reloaded: true });
    assert.deepEqual(tabsState.reloaded, [5]);
  });
  it('prefers a live tab over a discarded one, no reload', async () => {
    tabsState.tabs = [
      { id: 5, active: false, discarded: true, status: 'unloaded' } as chrome.tabs.Tab,
      { id: 6, active: false, discarded: false, status: 'complete' } as chrome.tabs.Tab,
    ];
    assert.deepEqual(await ensureXTab(), { tabId: 6, opened: false, reloaded: false });
  });
});

describe('preview: accounts absent from X are not pre-checked', () => {
  it('absentMeansNotFound → status not-found, unchecked', () => {
    const rows = buildPreview({
      entries: [{ handle: 'alive' }, { handle: 'ghost' }],
      whitelist: [],
      relationships: new Map([['h:alive', { id: '1', handle: 'alive', following: false, followedBy: false, blocking: false }]]),
      absentMeansNotFound: true,
    });
    assert.equal(rows[0]!.status, 'to-block');
    assert.equal(rows[0]!.checked, true);
    assert.equal(rows[1]!.status, 'not-found');
    assert.equal(rows[1]!.checked, false);
  });
});

describe('diagnostics never store tokens or query strings', () => {
  it('strips query, cookies and bearer', () => {
    const d = makeDiag({
      step: 'retry-later',
      endpoint: 'https://x.com/i/api/1.1/friendships/lookup.json?screen_name=a,b',
      status: 503,
      code: 'network',
      note: 'ct0=SECRET auth_token=SECRET2 Bearer AAAA',
    }, NOW);
    assert.equal(d.endpoint, '/i/api/1.1/friendships/lookup.json');
    assert.doesNotMatch(JSON.stringify(d), /SECRET|AAAA|screen_name/);
  });
});
