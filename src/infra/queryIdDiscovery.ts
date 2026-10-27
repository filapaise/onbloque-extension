import { FALLBACK_NOTE } from './queryIdFallback.ts';

export { FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID } from './queryIdFallback.ts';
import { FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID } from './queryIdFallback.ts';

void FALLBACK_NOTE;

export const USER_BY_SCREEN_NAME_FEATURES: Record<string, boolean> = {
  hidden_profile_subscriptions_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  subscriptions_verification_info_is_identity_verified_enabled: true,
  subscriptions_verification_info_verified_since_enabled: true,
  highlights_tweets_tab_ui_enabled: true,
  responsive_web_twitter_article_notes_tab_enabled: true,
  subscriptions_feature_can_gift_premium: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const CACHE_KEY = 'graphqlQueryIds';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

export function isAllowedBundleUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'abs.twimg.com';
  } catch {
    return false;
  }
}

export function extractUserByScreenNameQueryId(bundleText: string): string | null {
  const patterns = [
    /queryId\s*:\s*"([A-Za-z0-9_-]+)"\s*,\s*operationName\s*:\s*"UserByScreenName"/,
    /operationName\s*:\s*"UserByScreenName"\s*,\s*queryId\s*:\s*"([A-Za-z0-9_-]+)"/,
    /\/graphql\/([A-Za-z0-9_-]+)\/UserByScreenName/,
    /queryId:"([A-Za-z0-9_-]+)"[^,]{0,40}operationName:"UserByScreenName"/,
    /UserByScreenName[^,]{0,80}queryId:"([A-Za-z0-9_-]+)"/,
  ];
  for (const re of patterns) {
    const m = bundleText.match(re);
    if (m?.[1] && m[1].length >= 10) return m[1];
  }
  return null;
}

export async function getCachedQueryId(): Promise<string | null> {
  const data = (await chrome.storage.local.get(CACHE_KEY)) as {
    graphqlQueryIds?: { UserByScreenName?: string; at?: number };
  };
  const entry = data.graphqlQueryIds;
  if (!entry?.UserByScreenName || !entry.at) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) return null;
  return entry.UserByScreenName;
}

export async function cacheQueryId(id: string): Promise<void> {
  await chrome.storage.local.set({
    graphqlQueryIds: { UserByScreenName: id, at: Date.now() },
  });
}

export async function clearQueryIdCache(): Promise<void> {
  await chrome.storage.local.remove(CACHE_KEY);
}

export async function discoverQueryIdFromPage(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  scriptUrls: string[],
): Promise<string | null> {
  const candidates = scriptUrls.filter(isAllowedBundleUrl);
  for (const url of candidates.slice(0, 8)) {
    try {
      const res = await fetchFn(url, { method: 'GET', credentials: 'omit' });
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > MAX_BUNDLE_BYTES) continue;
      const text = new TextDecoder('utf-8').decode(buf);
      if (!text.includes('UserByScreenName')) continue;
      const id = extractUserByScreenNameQueryId(text);
      if (id) return id;
    } catch {
      /* next */
    }
  }
  return null;
}

export async function resolveQueryId(
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  scriptUrls: string[],
): Promise<string> {
  const cached = await getCachedQueryId();
  if (cached) return cached;
  const found = await discoverQueryIdFromPage(fetchFn, scriptUrls);
  if (found) {
    await cacheQueryId(found);
    return found;
  }
  return FALLBACK_USER_BY_SCREEN_NAME_QUERY_ID;
}
