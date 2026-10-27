/**
 * Identification du compte connecté — verify_credentials (1.1) renvoie 404 sur x.com.
 * Chaîne : twid cookie → account/settings.json → GraphQL Viewer → UserByRestId / UserByScreenName.
 */

import { XApiError } from '../domain/errors.ts';
import { buildHeaders, type FetchFn, sanitizeErrorBody } from './xClient.ts';
import { FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID } from './queryIdFallback.ts';
import { USER_BY_SCREEN_NAME_FEATURES, resolveQueryId } from './queryIdDiscovery.ts';

export const FALLBACK_VIEWER_QUERY_ID = 'TpQxQtWMTMnIAMPlMGMqNw';
export const FALLBACK_USER_BY_REST_ID = 'mxaYWwt52eAb6OAzYHMVzg';

const VIEWER_FEATURES: Record<string, boolean> = {
  subscriptions_upsells_api_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const USER_BY_REST_ID_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

export function parseTwidCookie(cookieHeader: string): string | null {
  const m = cookieHeader.match(/(?:^|;\s*)twid=([^;]+)/);
  if (!m?.[1]) return null;
  try {
    const raw = decodeURIComponent(m[1]);
    // forms: u%3D123 / u=123 / "u=123"
    const idm = raw.match(/u[=:](\d{1,20})/i) || raw.match(/^(\d{1,20})$/);
    return idm?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function readTwidFromTab(tabId: number): Promise<string | null> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const m = document.cookie.match(/(?:^|;\s*)twid=([^;]+)/);
        if (!m?.[1]) return null;
        try {
          const raw = decodeURIComponent(m[1]);
          const idm = raw.match(/u[=:](\d{1,20})/i) || raw.match(/^(\d{1,20})$/);
          return idm?.[1] ?? null;
        } catch {
          return null;
        }
      },
    });
    return injected[0]?.result ?? null;
  } catch {
    return null;
  }
}

async function fromSettings(fetchFn: FetchFn, csrf: string): Promise<{ handle: string } | null> {
  const res = await fetchFn('https://x.com/i/api/1.1/account/settings.json', {
    method: 'GET',
    headers: buildHeaders(csrf, { form: false }),
    credentials: 'include',
  });
  if (res.status === 404 || res.status === 401 || res.status === 403) return null;
  if (!res.ok) return null;
  try {
    const u = (await res.json()) as { screen_name?: string };
    return u.screen_name ? { handle: u.screen_name } : null;
  } catch {
    return null;
  }
}

async function fromViewer(
  fetchFn: FetchFn,
  csrf: string,
): Promise<{ id: string; handle?: string } | null> {
  for (const queryId of [FALLBACK_VIEWER_QUERY_ID]) {
    const params = new URLSearchParams({
      variables: JSON.stringify({ withCommunitiesMemberships: true }),
      features: JSON.stringify(VIEWER_FEATURES),
    });
    const res = await fetchFn(`https://x.com/i/api/graphql/${queryId}/Viewer?${params}`, {
      method: 'GET',
      headers: buildHeaders(csrf, { form: false }),
      credentials: 'include',
    });
    if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
    if (!res.ok) continue;
    try {
      const data = (await res.json()) as {
        data?: {
          viewer?: {
            user_results?: {
              result?: {
                rest_id?: string;
                legacy?: { screen_name?: string };
                core?: { screen_name?: string };
              };
            };
          };
        };
      };
      const r = data.data?.viewer?.user_results?.result;
      if (r?.rest_id) {
        return {
          id: r.rest_id,
          handle: r.legacy?.screen_name || r.core?.screen_name,
        };
      }
    } catch {
      /* next */
    }
  }
  return null;
}

async function fromUserByRestId(
  fetchFn: FetchFn,
  csrf: string,
  id: string,
): Promise<{ id: string; handle: string } | null> {
  const params = new URLSearchParams({
    variables: JSON.stringify({ userId: id, withSafetyModeUserFields: true }),
    features: JSON.stringify(USER_BY_REST_ID_FEATURES),
  });
  const res = await fetchFn(
    `https://x.com/i/api/graphql/${FALLBACK_USER_BY_REST_ID}/UserByRestId?${params}`,
    {
      method: 'GET',
      headers: buildHeaders(csrf, { form: false }),
      credentials: 'include',
    },
  );
  if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as {
      data?: {
        user?: {
          result?: {
            rest_id?: string;
            legacy?: { screen_name?: string };
            core?: { screen_name?: string };
            __typename?: string;
          };
        };
      };
    };
    const r = data.data?.user?.result;
    if (!r || r.__typename === 'UserUnavailable') return null;
    const handle = r.legacy?.screen_name || r.core?.screen_name;
    if (r.rest_id && handle) return { id: r.rest_id, handle };
  } catch {
    /* ignore */
  }
  return null;
}

async function fromUserByScreenName(
  fetchFn: FetchFn,
  csrf: string,
  screenName: string,
  scriptUrls: string[],
): Promise<{ id: string; handle: string } | null> {
  const queryId = await resolveQueryId(fetchFn, scriptUrls).catch(
    () => FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID,
  );
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
    features: JSON.stringify(USER_BY_SCREEN_NAME_FEATURES),
  });
  const res = await fetchFn(`https://x.com/i/api/graphql/${queryId}/UserByScreenName?${params}`, {
    method: 'GET',
    headers: buildHeaders(csrf, { form: false }),
    credentials: 'include',
  });
  if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
  if (!res.ok) return null;
  try {
    const data = (await res.json()) as {
      data?: {
        user?: {
          result?: {
            rest_id?: string;
            legacy?: { screen_name?: string };
            core?: { screen_name?: string };
          };
        };
      };
    };
    const r = data.data?.user?.result;
    const handle = r?.legacy?.screen_name || r?.core?.screen_name || screenName;
    if (r?.rest_id) return { id: r.rest_id, handle };
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Identifie le compte connecté. Retourne null seulement si toutes les méthodes échouent
 * sans rate-limit (le caller fail-closed).
 */
export async function identifySelf(
  fetchFn: FetchFn,
  csrf: string,
  opts: { tabId?: number; scriptUrls?: string[]; twidHint?: string | null } = {},
): Promise<{ id: string; handle: string } | null> {
  let id: string | null = opts.twidHint ?? null;
  if (!id && opts.tabId != null) id = await readTwidFromTab(opts.tabId);

  // 1) GraphQL Viewer (souvent le plus complet)
  const viewer = await fromViewer(fetchFn, csrf).catch((e) => {
    if (e instanceof XApiError && e.code === 'rate-limit') throw e;
    return null;
  });
  if (viewer?.id && viewer.handle) return { id: viewer.id, handle: viewer.handle };
  if (viewer?.id) id = id ?? viewer.id;

  // 2) account/settings.json → screen_name
  const settings = await fromSettings(fetchFn, csrf).catch(() => null);
  let handle = settings?.handle ?? viewer?.handle;

  // 3) UserByRestId si on a un id
  if (id) {
    const byId = await fromUserByRestId(fetchFn, csrf, id).catch((e) => {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      return null;
    });
    if (byId) return byId;
  }

  // 4) UserByScreenName si on a un handle
  if (handle) {
    const byHandle = await fromUserByScreenName(
      fetchFn,
      csrf,
      handle,
      opts.scriptUrls ?? [],
    ).catch((e) => {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      return null;
    });
    if (byHandle) return byIdOrHandle(byHandle, id);
  }

  if (id && handle) return { id, handle };
  return null;
}

function byIdOrHandle(
  byHandle: { id: string; handle: string },
  id: string | null,
): { id: string; handle: string } {
  if (id && id !== byHandle.id) {
    // Prefer GraphQL UserByScreenName result as authoritative for handle↔id
  }
  return byHandle;
}

export { sanitizeErrorBody };
