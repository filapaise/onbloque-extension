/** 1.3.0 — seuil d'abonnés : réglage, lecture du compteur, filtre, compteurs « petits comptes ». */
import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const mem: Record<string, unknown> = {};
(globalThis as unknown as { chrome: unknown }).chrome = {
  storage: {
    local: {
      get: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        return Object.fromEntries(keys.filter((x) => x in mem).map((x) => [x, structuredClone(mem[x])]));
      },
      set: async (o: Record<string, unknown>) => void Object.assign(mem, structuredClone(o)),
    },
  },
  alarms: { create: async () => undefined, clear: async () => undefined },
};

const f = await import('../src/domain/followers.ts');
const { normalizeSettings, mergeSettingsPatch } = await import('../src/infra/storage.ts');
const { DEFAULT_SETTINGS } = await import('../src/domain/types.ts');
const { parseUserResult } = await import('../src/infra/xClient.ts');
const fc = await import('../src/infra/followerCounts.ts');
const { followerGate, applySmallSkip, SMALL_SKIP_GAP_MS, decideOnError } = await import('../src/application/queueRunner.ts');
const { XApiError } = await import('../src/domain/errors.ts');
const { computeProgress, countLine, fabProgressOf } = await import('../src/domain/progress.ts');
const { initialRunState, reconcileBatch, startBatch } = await import('../src/domain/queue.ts');
const { makeCtx } = await import('./helpers.ts');

const NNBSP = '\u202f';
const q = (handle?: string, id?: string, action: 'block' | 'unblock' = 'block') => ({
  key: id ? `id:${id}` : `h:${handle}`,
  handle,
  id,
  action,
  addedAt: 0,
  attempts: 0,
});
const user = (id: string, h: string, followers?: number) => ({
  result: {
    __typename: 'User',
    rest_id: id,
    core: { screen_name: h, name: h },
    legacy: followers === undefined ? {} : { followers_count: followers },
  },
});
const usersRoute = (users: unknown[], status = 200) => ({ match: '/UsersByRestIds', status, body: { data: { users } } });
const gqlCalls = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes('/UsersByRestIds'));
const idsOf = (url: string): string[] => JSON.parse(new URL(url).searchParams.get('variables')!).userIds;

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
});

describe('followers — pure helpers', () => {
  it('presets are 1 000 / 10 000 / 50 000 / 100 000', () => {
    assert.deepEqual([...f.FOLLOWER_PRESETS], [1000, 10000, 50000, 100000]);
    assert.ok(f.isPresetThreshold(10000));
    assert.ok(!f.isPresetThreshold(25000));
  });
  it('parses free input (spaces, k/M, thousands separators)', () => {
    assert.equal(f.parseFollowerInput('25000'), 25000);
    assert.equal(f.parseFollowerInput(' 25 000 '), 25000);
    assert.equal(f.parseFollowerInput('25\u202f000'), 25000);
    assert.equal(f.parseFollowerInput('25k'), 25000);
    assert.equal(f.parseFollowerInput('1,5k'), 1500);
    assert.equal(f.parseFollowerInput('1.5K'), 1500);
    assert.equal(f.parseFollowerInput('2M'), 2_000_000);
    assert.equal(f.parseFollowerInput('10.000'), 10000);
    assert.equal(f.parseFollowerInput('1,000,000'), 1_000_000);
    assert.equal(f.parseFollowerInput('0'), 0);
    for (const bad of ['', 'abc', '-5', '10 k abonnés', '1e5']) assert.ok(Number.isNaN(f.parseFollowerInput(bad)), bad);
  });
  it('sanitizes the stored value', () => {
    assert.equal(f.sanitizeMinFollowers(10000), 10000);
    assert.equal(f.sanitizeMinFollowers(1234.9), 1234);
    assert.equal(f.sanitizeMinFollowers(0), 0);
    assert.equal(f.sanitizeMinFollowers(1e12), f.MAX_MIN_FOLLOWERS);
    for (const bad of [-1, NaN, Infinity, '10000', null, undefined, {}]) assert.equal(f.sanitizeMinFollowers(bad), null);
  });
  it('threshold filter: off = never small; strictly below = small; equal = blocked', () => {
    assert.equal(f.isBelowThreshold(3, 0), false);
    assert.equal(f.isBelowThreshold(9_999, 10_000), true);
    assert.equal(f.isBelowThreshold(10_000, 10_000), false);
    assert.equal(f.isBelowThreshold(250_000, 10_000), false);
  });
  it('French wording', () => {
    assert.equal(f.fmtFollowers(10000), `10${NNBSP}000`);
    assert.equal(f.describeThreshold(0), 'Désactivé : toute la liste est bloquée.');
    assert.match(f.describeThreshold(50000), /^Seuls les comptes à partir de 50.000 abonnés sont bloqués\./);
    assert.match(f.smallAccountMessage(812, 10000), /^Petit compte \(812 abonnés < 10.000\) : pas bloqué$/);
  });
});

describe('followers — setting persisted with the other settings', () => {
  it('off by default (current behavior: block everything)', () => {
    assert.equal(DEFAULT_SETTINGS.minFollowers, 0);
    assert.equal(normalizeSettings({}).minFollowers, 0);
    assert.equal(normalizeSettings({ pace: 'normal' }).minFollowers, 0); // réglages 1.2.x sans le champ
  });
  it('normalize keeps a valid value and drops garbage', () => {
    assert.equal(normalizeSettings({ minFollowers: 50000 }).minFollowers, 50000);
    assert.equal(normalizeSettings({ minFollowers: -3 } as never).minFollowers, 0);
    assert.equal(normalizeSettings({ minFollowers: '9' } as never).minFollowers, 0);
  });
  it('SET_SETTINGS patch: set, change, disable; garbage keeps the previous value', () => {
    let s = normalizeSettings({});
    s = mergeSettingsPatch(s, { minFollowers: 10000 });
    assert.equal(s.minFollowers, 10000);
    s = mergeSettingsPatch(s, { minFollowers: 'lots' } as never);
    assert.equal(s.minFollowers, 10000);
    s = mergeSettingsPatch(s, { minFollowers: 25000.7 });
    assert.equal(s.minFollowers, 25000);
    s = mergeSettingsPatch(s, { minFollowers: 0 });
    assert.equal(s.minFollowers, 0);
  });
  it('changing the pace or delays does not reset the threshold', () => {
    let s = mergeSettingsPatch(normalizeSettings({}), { minFollowers: 100000 });
    s = mergeSettingsPatch(s, { pace: 'max' });
    assert.equal(s.minFollowers, 100000);
    s = mergeSettingsPatch(s, { customDelay: true, minDelaySec: 30, maxDelaySec: 60 });
    assert.equal(s.minFollowers, 100000);
    s = mergeSettingsPatch(s, { listUrl: 'https://exemple.org/l.json' });
    assert.equal(s.minFollowers, 100000);
  });
});

describe('followers — reading the count from X', () => {
  it('parseUserResult reads legacy.followers_count, else relationship_counts.followers', () => {
    const a = parseUserResult(user('1', 'a', 1234).result);
    assert.ok(a?.kind === 'user' && a.followers === 1234);
    const b = parseUserResult({ __typename: 'User', rest_id: '2', core: { screen_name: 'b' }, relationship_counts: { followers: 7 } });
    assert.ok(b?.kind === 'user' && b.followers === 7);
    const c = parseUserResult(user('3', 'c').result);
    assert.ok(c?.kind === 'user' && c.followers === undefined);
    const d = parseUserResult({ __typename: 'User', rest_id: '4', core: { screen_name: 'd' }, legacy: { followers_count: '12' } });
    assert.ok(d?.kind === 'user' && d.followers === undefined, 'string count is not trusted');
  });
  it('fetchFollowerCounts: ok / gone (absent or suspended) / unknown (no count)', async () => {
    const { ctx } = makeCtx([
      usersRoute([user('1', 'gros', 90000), { result: { __typename: 'UserUnavailable', rest_id: '2' } }, user('4', 'sanscompteur')]),
    ]);
    const got = await fc.fetchFollowerCounts(ctx, ['1', '2', '3', '4'], 1000);
    assert.deepEqual(got['1'], { s: 'ok', n: 90000, h: 'gros', at: 1000 });
    assert.equal(got['2']!.s, 'gone');
    assert.equal(got['3']!.s, 'gone');
    assert.equal(got['4']!.s, 'unknown');
  });
  it('pickFollowerBatch: head first, then next known ids, blocks only, cache hits skipped, max 50', () => {
    const now = 10_000;
    const idCache = { b: { s: 'ok' as const, id: '20', h: 'b', at: now }, c: { s: 'absent' as const, at: now } };
    const counts = { '30': { s: 'ok' as const, n: 5, h: 'x', at: now } };
    const queue = [q('a', '10'), q('b'), q('c'), q(undefined, '30'), q(undefined, '40', 'unblock'), q(undefined, '50'), q('nope')];
    assert.deepEqual(fc.pickFollowerBatch('10', queue, idCache, counts, now), ['10', '20', '50']);
    const many = Array.from({ length: 120 }, (_, i) => q(undefined, String(1000 + i)));
    const batch = fc.pickFollowerBatch('1000', many, {}, {}, now);
    assert.equal(batch.length, 50);
    assert.equal(batch[0], '1000');
  });
  it('cache TTL: counts 3 days, gone/unknown 30 min', () => {
    const now = 1e12;
    const c = {
      a: { s: 'ok' as const, n: 1, h: 'a', at: now - 2 * 86400_000 },
      b: { s: 'ok' as const, n: 1, h: 'b', at: now - 4 * 86400_000 },
      g: { s: 'gone' as const, at: now - 40 * 60_000 },
    };
    assert.ok(fc.followerGet(c, 'a', now));
    assert.equal(fc.followerGet(c, 'b', now), null);
    assert.equal(fc.followerGet(c, 'g', now), null);
  });
});

describe('followers — gate in the queue', () => {
  it('pre-check without a known id: no request, normal resolution decides', async () => {
    const { ctx, calls } = makeCtx([usersRoute([])]);
    assert.equal(await followerGate(ctx, q('inconnu'), [q('inconnu')], 10000, 'pre'), null);
    assert.equal(calls.length, 0);
  });
  it('ONE UsersByRestIds request for the next 50 accounts, then cache hits (0 extra requests)', async () => {
    const queue = Array.from({ length: 60 }, (_, i) => q(`u${i}`, String(100 + i)));
    const users = queue.map((x, i) => user(x.id!, x.handle!, i % 2 ? 50 : 200_000));
    const { ctx, calls } = makeCtx([usersRoute(users)]);
    const v0 = await followerGate(ctx, queue[0]!, queue, 10000, 'pre');
    assert.deepEqual(v0, { small: false, followers: 200_000, fetched: true });
    const v1 = await followerGate(ctx, queue[1]!, queue.slice(1), 10000, 'pre');
    assert.deepEqual(v1, { small: true, followers: 50, fetched: false });
    for (let i = 2; i < 50; i++) await followerGate(ctx, queue[i]!, queue.slice(i), 10000, 'pre');
    assert.equal(gqlCalls(calls).length, 1, 'a single request covered 50 accounts');
    assert.equal(idsOf(gqlCalls(calls)[0]!.url).length, 50);
    await followerGate(ctx, queue[50]!, queue.slice(50), 10000, 'pre');
    assert.equal(gqlCalls(calls).length, 2, 'next request only after 50 accounts');
    assert.equal(calls.length, 2, 'nothing else was requested');
  });
  it('pre-check uses the @ → id cache filled by the grouped resolution', async () => {
    mem.resolvedIds = { petit: { s: 'ok', id: '77', h: 'petit', at: Date.now() } };
    const { ctx } = makeCtx([usersRoute([user('77', 'petit', 300)])]);
    const v = await followerGate(ctx, q('petit'), [q('petit')], 1000, 'pre');
    assert.equal(v?.small, true);
  });
  it('pre-check: renamed account (id ↔ @ mismatch) → no verdict, normal resolution decides', async () => {
    const { ctx } = makeCtx([usersRoute([user('5', 'autre', 10)])]);
    assert.equal(await followerGate(ctx, q('ancien', '5'), [q('ancien', '5')], 1000, 'pre'), null);
  });
  it('pre-check: gone / unknown → no verdict (never skip or block on a guess)', async () => {
    const { ctx } = makeCtx([usersRoute([user('6', 'sans')])]);
    assert.equal(await followerGate(ctx, q('sans', '6'), [q('sans', '6'), q('x', '7')], 1000, 'pre'), null);
    assert.equal(await followerGate(ctx, q('x', '7'), [q('x', '7')], 1000, 'pre'), null);
  });
  it('post-check (id confirmed by X): count missing → resolver-failed (auto retry, then pause; nothing blocked)', async () => {
    const { ctx } = makeCtx([usersRoute([user('6', 'sans')])]);
    await assert.rejects(followerGate(ctx, { id: '6', handle: 'sans' }, [], 1000, 'post'), (e: InstanceType<typeof XApiError>) => {
      assert.equal(e.code, 'resolver-failed');
      return true;
    });
    const d = decideOnError(new XApiError('x', 0, 'resolver-failed'), { ...initialRunState(), running: true }, 0);
    assert.equal(d.kind, 'retry-later');
  });
  it('post-check: account gone → skipped as suspended (counted in « ignorés »)', async () => {
    const { ctx } = makeCtx([usersRoute([])]);
    await assert.rejects(followerGate(ctx, { id: '8', handle: 'parti' }, [], 1000, 'post'), (e: InstanceType<typeof XApiError>) => e.code === 'suspended');
  });
  it('post-check: big account → not small, normal flow continues (guard + block)', async () => {
    const { ctx } = makeCtx([usersRoute([user('9', 'gros', 1_000_000)])]);
    assert.deepEqual(await followerGate(ctx, { id: '9', handle: 'gros' }, [], 100000, 'post'), {
      small: false,
      followers: 1_000_000,
      fetched: true,
    });
  });
  it('rate limit on UsersByRestIds propagates as rate-limit (existing backoff)', async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const { ctx } = makeCtx([{ match: '/UsersByRestIds', status: 429, body: '{}', headers: { 'x-rate-limit-reset': reset } }]);
    await assert.rejects(followerGate(ctx, q('a', '1'), [q('a', '1')], 1000, 'pre'), (e: InstanceType<typeof XApiError>) => {
      assert.equal(e.code, 'rate-limit');
      return true;
    });
    assert.equal(mem.followerCounts, undefined, 'nothing cached on error');
  });
  it('threshold raised mid-run: the cached count is re-read against the new value', async () => {
    const { ctx, calls } = makeCtx([usersRoute([user('1', 'moyen', 20_000)])]);
    assert.equal((await followerGate(ctx, q('moyen', '1'), [q('moyen', '1')], 10_000, 'pre'))?.small, false);
    assert.equal((await followerGate(ctx, q('moyen', '1'), [q('moyen', '1')], 50_000, 'pre'))?.small, true);
    assert.equal(calls.length, 1);
  });
});

describe('followers — counters', () => {
  it('a small account is counted apart: not blocked, not « ignoré », not in the daily cap, no backoff', () => {
    const run = { ...initialRunState(), running: true, actionsToday: 4, backoffLevel: 2, totalDone: 4, totalSkipped: 1, lastError: null };
    const now = 1_000_000;
    const next = applySmallSkip(run, 3, now, SMALL_SKIP_GAP_MS, now);
    assert.equal(next.totalSmall, 1);
    assert.equal(next.batchSmall, 1);
    assert.equal(next.totalDone, 4);
    assert.equal(next.totalSkipped, 1);
    assert.equal(next.actionsToday, 4);
    assert.equal(next.backoffLevel, 0);
    assert.equal(next.lastError, null);
    assert.equal(next.nextActionAt, now + SMALL_SKIP_GAP_MS);
    assert.equal(applySmallSkip(next, 0, now, SMALL_SKIP_GAP_MS, now).nextActionAt, null, 'last one: nothing scheduled');
    assert.equal(applySmallSkip(next, 0, now, SMALL_SKIP_GAP_MS, now).totalSmall, 2);
  });
  it('progress: small accounts count as handled, shown separately', () => {
    const run = { ...initialRunState(), running: true, batchDone: 10, batchSkipped: 2, batchSmall: 8 };
    const p = computeProgress(run, 20, DEFAULT_SETTINGS);
    assert.equal(p.small, 8);
    assert.equal(p.total, 40);
    assert.equal(p.pct, 0.5);
    assert.equal(countLine(p), '10 / 40 bloqués · 2 ignorés · 8 petits comptes');
    assert.equal(countLine({ done: 1, skipped: 0, small: 1, total: 3 }), '1 / 3 bloqué · 1 petit compte');
    assert.equal(fabProgressOf(p).done, 20);
    const finished = computeProgress({ ...initialRunState(), batchSmall: 5 }, 0, DEFAULT_SETTINGS);
    assert.equal(finished.state, 'done', 'a batch of only small accounts still ends as « done »');
  });
  it('batch counters survive a reload and reset on a new batch', () => {
    const run = { ...initialRunState(), batchSmall: 7, batchStartedAt: 5 };
    assert.equal(reconcileBatch(run, [q('a')], []).batchSmall, 7);
    assert.equal(reconcileBatch({ ...run, batchSmall: -2 as number }, [q('a')], []).batchSmall, 0);
    assert.equal(startBatch(run).batchSmall, 0);
    assert.equal(initialRunState().totalSmall, 0);
  });
});
