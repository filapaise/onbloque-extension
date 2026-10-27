/**
 * Client endpoints web x.com. CSRF fourni par l'appelant (lu depuis document.cookie
 * dans l'onglet). Aucun cookie / jeton n'est stocké ni journalisé.
 */

import { XApiError, type XErrorCode } from '../domain/errors.ts';
import type { Relationship } from '../domain/types.ts';
import {
  FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID,
  USER_BY_SCREEN_NAME_FEATURES,
  clearQueryIdCache,
  resolveQueryId,
} from './queryIdDiscovery.ts';

export { XApiError };
export type { XErrorCode };

export const X_WEB_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const ENDPOINTS = {
  friendshipsLookup: 'https://x.com/i/api/1.1/friendships/lookup.json',
  blocksCreate: 'https://x.com/i/api/1.1/blocks/create.json',
  blocksDestroy: 'https://x.com/i/api/1.1/blocks/destroy.json',
  blocksList: 'https://x.com/i/api/1.1/blocks/list.json',
  accountVerify: 'https://x.com/i/api/1.1/account/verify_credentials.json',
  graphql: 'https://x.com/i/api/graphql',
} as const;

export function buildHeaders(
  csrf: string,
  opts: { form?: boolean } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: X_WEB_BEARER,
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'fr',
  };
  if (opts.form !== false) headers['content-type'] = 'application/x-www-form-urlencoded';
  return headers;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export function sanitizeErrorBody(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/ct0=[^;\s&]+/gi, 'ct0=…')
    .replace(/auth_token=[^;\s&]+/gi, 'auth_token=…')
    .replace(/Bearer\s+[A-Za-z0-9%]+/g, 'Bearer …')
    .slice(0, 240);
}

export async function verifyCredentials(
  fetchFn: FetchFn,
  csrf: string,
  opts: { tabId?: number; scriptUrls?: string[]; twidHint?: string | null } = {},
): Promise<{ id: string; handle: string } | null> {
  // account/verify_credentials.json renvoie 404 sur le client web x.com actuel.
  const { identifySelf } = await import('./selfIdentity.ts');
  return identifySelf(fetchFn, csrf, opts);
}

/**
 * Lookup relations. En cas d'échec HTTP global → throw (fail-closed).
 * Chunks individuels en erreur → throw aussi (pas de continue silencieux).
 */
export async function friendshipsLookup(
  fetchFn: FetchFn,
  csrf: string,
  refs: Array<{ handle?: string; id?: string }>,
): Promise<Map<string, Relationship>> {
  const map = new Map<string, Relationship>();
  if (!refs.length) return map;
  const chunkSize = 100;
  for (let i = 0; i < refs.length; i += chunkSize) {
    if (i > 0) await new Promise((r) => setTimeout(r, 2500)); // throttle
    const chunk = refs.slice(i, i + chunkSize);
    const params = new URLSearchParams();
    const names = chunk.map((r) => r.handle).filter(Boolean) as string[];
    const ids = chunk.map((r) => r.id).filter(Boolean) as string[];
    if (names.length) params.set('screen_name', names.join(','));
    if (ids.length) params.set('user_id', ids.join(','));
    if (![...params.keys()].length) continue;
    const res = await fetchFn(`${ENDPOINTS.friendshipsLookup}?${params}`, {
      method: 'GET',
      headers: buildHeaders(csrf, { form: false }),
      credentials: 'include',
    });
    if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
    if (!res.ok) {
      throw new XApiError(
        `friendships/lookup ${res.status}`,
        res.status,
        res.status === 403 ? 'forbidden' : 'network',
        sanitizeErrorBody(await res.text().catch(() => '')),
      );
    }
    const data = (await res.json()) as Array<{
      id_str?: string;
      screen_name?: string;
      name?: string;
      connections?: string[];
    }>;
    if (!Array.isArray(data)) {
      throw new XApiError('friendships/lookup malformed', 0, 'network');
    }
    for (const u of data) {
      const connections = Array.isArray(u.connections) ? u.connections : [];
      const rel: Relationship = {
        id: u.id_str,
        handle: u.screen_name,
        name: u.name,
        following: connections.includes('following'),
        followedBy: connections.includes('followed_by'),
        blocking: connections.includes('blocking'),
      };
      if (u.screen_name) map.set(`h:${u.screen_name.toLowerCase()}`, rel);
      if (u.id_str) map.set(`id:${u.id_str}`, rel);
    }
  }
  return map;
}

export type ResolveResult =
  | { ok: true; id: string; handle: string; mismatch?: boolean; listHandle?: string }
  | { ok: false; reason: 'not-found' | 'suspended' | 'resolver-failed' | 'mismatch' };

/**
 * Résout et vérifie la cohérence id ↔ handle.
 * Si les deux sont fournis : lookup par id, compare le screen_name X au handle de la liste.
 */
export async function resolveUserId(
  fetchFn: FetchFn,
  csrf: string,
  ref: { handle?: string; id?: string },
  opts: { scriptUrls?: string[] } = {},
): Promise<ResolveResult> {
  // Cas : id connu → toujours vérifier le handle auprès de X
  if (ref.id) {
    try {
      const map = await friendshipsLookup(fetchFn, csrf, [{ id: ref.id }]);
      const rel = map.get(`id:${ref.id}`);
      if (!rel?.handle) {
        // essayer GraphQL n'aide pas sans handle ; consider not-found if empty
        return { ok: false, reason: 'not-found' };
      }
      if (ref.handle && rel.handle.toLowerCase() !== ref.handle.toLowerCase()) {
        return {
          ok: true,
          id: ref.id,
          handle: rel.handle,
          mismatch: true,
          listHandle: ref.handle,
        };
      }
      return { ok: true, id: ref.id, handle: rel.handle };
    } catch (e) {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      if (ref.handle) {
        // fallback resolve by handle
      } else {
        return { ok: false, reason: 'resolver-failed' };
      }
    }
  }

  if (!ref.handle) return { ok: false, reason: 'resolver-failed' };

  try {
    const map = await friendshipsLookup(fetchFn, csrf, [{ handle: ref.handle }]);
    const rel = map.get(`h:${ref.handle.toLowerCase()}`);
    if (rel?.id && rel.handle) {
      return { ok: true, id: rel.id, handle: rel.handle };
    }
  } catch (e) {
    if (e instanceof XApiError && e.code === 'rate-limit') throw e;
  }

  try {
    const gql = await userByScreenName(fetchFn, csrf, ref.handle, opts.scriptUrls ?? []);
    if (gql.status === 'ok') return { ok: true, id: gql.id, handle: gql.handle || ref.handle };
    if (gql.status === 'not-found') return { ok: false, reason: 'not-found' };
    if (gql.status === 'suspended') return { ok: false, reason: 'suspended' };
    return { ok: false, reason: 'resolver-failed' };
  } catch (e) {
    if (e instanceof XApiError && e.code === 'rate-limit') throw e;
    return { ok: false, reason: 'resolver-failed' };
  }
}

type GqlUserResult =
  | { status: 'ok'; id: string; handle: string }
  | { status: 'not-found' }
  | { status: 'suspended' }
  | { status: 'failed' };

async function userByScreenName(
  fetchFn: FetchFn,
  csrf: string,
  screenName: string,
  scriptUrls: string[],
): Promise<GqlUserResult> {
  const queryId = await resolveQueryId(fetchFn, scriptUrls);
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
    features: JSON.stringify(USER_BY_SCREEN_NAME_FEATURES),
  });
  const res = await fetchFn(`${ENDPOINTS.graphql}/${queryId}/UserByScreenName?${params}`, {
    method: 'GET',
    headers: buildHeaders(csrf, { form: false }),
    credentials: 'include',
  });
  if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
  if (res.status === 401 || res.status === 403) return { status: 'failed' };
  if (res.status === 404 || res.status === 400) {
    await clearQueryIdCache();
    if (queryId !== FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID) {
      return userByScreenNameWithId(fetchFn, csrf, screenName, FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID);
    }
    return { status: 'failed' };
  }
  if (!res.ok) return { status: 'failed' };
  return parseUserByScreenNameBody(await res.text());
}

async function userByScreenNameWithId(
  fetchFn: FetchFn,
  csrf: string,
  screenName: string,
  queryId: string,
): Promise<GqlUserResult> {
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
    features: JSON.stringify(USER_BY_SCREEN_NAME_FEATURES),
  });
  const res = await fetchFn(`${ENDPOINTS.graphql}/${queryId}/UserByScreenName?${params}`, {
    method: 'GET',
    headers: buildHeaders(csrf, { form: false }),
    credentials: 'include',
  });
  if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
  if (!res.ok) return { status: 'failed' };
  return parseUserByScreenNameBody(await res.text());
}

export function parseUserByScreenNameBody(text: string): GqlUserResult {
  try {
    const data = JSON.parse(text) as {
      data?: {
        user?: {
          result?: {
            __typename?: string;
            rest_id?: string;
            id?: string;
            legacy?: { screen_name?: string };
            core?: { screen_name?: string };
          };
        };
      };
    };
    const result = data.data?.user?.result;
    if (!result) {
      if (data.data && 'user' in (data.data as object) && !data.data.user) return { status: 'not-found' };
      return { status: 'failed' };
    }
    if ((result.__typename ?? '') === 'UserUnavailable') return { status: 'suspended' };
    const id = result.rest_id || result.id;
    const handle = result.legacy?.screen_name || result.core?.screen_name;
    if (!id) return { status: 'not-found' };
    return { status: 'ok', id: String(id), handle: handle ?? '' };
  } catch {
    return { status: 'failed' };
  }
}

export async function blockUser(
  fetchFn: FetchFn,
  csrf: string,
  ref: { handle?: string; id?: string },
  opts: { scriptUrls?: string[] } = {},
): Promise<{ id?: string; handle?: string }> {
  return mutateBlock(fetchFn, csrf, ENDPOINTS.blocksCreate, ref, opts);
}

export async function unblockUser(
  fetchFn: FetchFn,
  csrf: string,
  ref: { handle?: string; id?: string },
  opts: { scriptUrls?: string[] } = {},
): Promise<{ id?: string; handle?: string }> {
  return mutateBlock(fetchFn, csrf, ENDPOINTS.blocksDestroy, ref, opts);
}

async function mutateBlock(
  fetchFn: FetchFn,
  csrf: string,
  endpoint: string,
  ref: { handle?: string; id?: string },
  opts: { scriptUrls?: string[] } = {},
): Promise<{ id?: string; handle?: string }> {
  const resolved = await resolveUserId(fetchFn, csrf, ref, { scriptUrls: opts.scriptUrls });
  if (!resolved.ok) {
    if (resolved.reason === 'resolver-failed') {
      throw new XApiError('resolver-failed', 0, 'resolver-failed');
    }
    if (resolved.reason === 'mismatch') {
      throw new XApiError('mismatch', 409, 'mismatch');
    }
    throw new XApiError(resolved.reason, 404, resolved.reason);
  }
  if (resolved.mismatch) {
    throw new XApiError('mismatch', 409, 'mismatch');
  }
  const id = resolved.id;
  const handle = resolved.handle;

  const body = `user_id=${encodeURIComponent(id)}`;
  const res = await fetchFn(endpoint, {
    method: 'POST',
    headers: buildHeaders(csrf, { form: true }),
    credentials: 'include',
    body,
  });
  const text = await res.text().catch(() => '');
  const safe = sanitizeErrorBody(text);
  if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit', safe);
  if (res.status === 404) throw new XApiError('not-found', 404, 'not-found', safe);
  if (res.status === 403) throw new XApiError('forbidden-or-suspended', 403, 'forbidden', safe);
  if (!res.ok) throw new XApiError(`block ${res.status}`, res.status, 'unknown', safe);
  try {
    const u = JSON.parse(text) as { id_str?: string; screen_name?: string };
    return { id: u.id_str ?? id, handle: u.screen_name ?? handle };
  } catch {
    return { id, handle };
  }
}
