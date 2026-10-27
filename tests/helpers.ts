import type { GqlOperation, GqlOperationName, OperationSource } from '../src/infra/graphqlOps.ts';
import { FALLBACK_OPERATIONS } from '../src/infra/graphqlOps.ts';
import type { XContext } from '../src/infra/xClient.ts';

export type Route = { match: string | RegExp; status?: number; body?: unknown; headers?: Record<string, string> };

/** fetch factice : première route dont le motif correspond à l'URL. Journalise les appels. */
export function fakeFetch(routes: Route[]) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
    const r = routes.find((x) => (typeof x.match === 'string' ? url.includes(x.match) : x.match.test(url)));
    if (!r) return new Response('{"errors":[{"code":34}]}', { status: 404 });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  };
  return { fn, calls };
}

export function staticOps(overrides: Partial<Record<GqlOperationName, GqlOperation>> = {}) {
  const invalidated: string[] = [];
  const current = { ...FALLBACK_OPERATIONS, ...overrides };
  const ops: OperationSource = {
    get: async (n) => current[n],
    invalidate: async (n) => {
      invalidated.push(n);
      current[n] = FALLBACK_OPERATIONS[n];
    },
  };
  return { ops, invalidated };
}

export function makeCtx(routes: Route[], opts: { ops?: OperationSource; lookupGone?: boolean } = {}) {
  const f = fakeFetch(routes);
  const ctx: XContext = {
    fetchFn: f.fn,
    csrf: 'csrf-test',
    ops: opts.ops ?? staticOps().ops,
    state: { lookupGone: !!opts.lookupGone },
    throttleMs: 0,
  };
  return { ctx, calls: f.calls };
}

export const gqlUser = (id: string, handle: string, extra: Record<string, unknown> = {}) => ({
  __typename: 'User',
  rest_id: id,
  core: { screen_name: handle, name: handle },
  ...extra,
});

/** Page de timeline Following/Followers. */
export function timelinePage(users: Array<[string, string]>, cursor: string | null) {
  const entries: unknown[] = users.map(([id, h]) => ({
    entryId: `user-${id}`,
    content: { itemContent: { user_results: { result: gqlUser(id, h) } } },
  }));
  if (cursor) entries.push({ entryId: `cursor-bottom-${cursor}`, content: { cursorType: 'Bottom', value: cursor } });
  return {
    data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } } } } },
  };
}
