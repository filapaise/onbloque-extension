/**
 * Garde « vous suivez » : friendships/lookup d'abord, sinon GraphQL Following (échantillon).
 */

import { XApiError } from '../domain/errors.ts';
import { buildHeaders, friendshipsLookup, type FetchFn } from './xClient.ts';

export const FALLBACK_FOLLOWING_QUERY_ID = 'nxiL6UwEf7B1K1JNGPx-Jw';

/** Features minimales pour Following (sous-ensemble stable). */
const FOLLOWING_FEATURES: Record<string, boolean> = {
  rweb_tipjar_consumption_enabled: false,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export type FollowCheck = {
  following: boolean;
  followedBy: boolean;
  blocking: boolean;
  id?: string;
  handle?: string;
  source: 'friendships' | 'following-gql' | 'unknown';
};

export async function checkRelationship(
  fetchFn: FetchFn,
  csrf: string,
  ref: { handle?: string; id?: string },
  selfId?: string,
): Promise<FollowCheck> {
  try {
    const map = await friendshipsLookup(fetchFn, csrf, [ref]);
    const rel =
      (ref.id && map.get(`id:${ref.id}`)) ||
      (ref.handle && map.get(`h:${ref.handle.toLowerCase()}`)) ||
      [...map.values()][0];
    if (rel) {
      return {
        following: rel.following,
        followedBy: rel.followedBy,
        blocking: rel.blocking,
        id: rel.id,
        handle: rel.handle,
        source: 'friendships',
      };
    }
  } catch (e) {
    if (e instanceof XApiError && e.code === 'rate-limit') throw e;
    // fall through to GraphQL
  }

  if (selfId && ref.id) {
    const following = await isInFollowingSample(fetchFn, csrf, selfId, ref.id);
    if (following != null) {
      return {
        following,
        followedBy: false,
        blocking: false,
        id: ref.id,
        handle: ref.handle,
        source: 'following-gql',
      };
    }
  }

  return {
    following: false,
    followedBy: false,
    blocking: false,
    id: ref.id,
    handle: ref.handle,
    source: 'unknown',
  };
}

/** Parcourt jusqu'à ~200 following pour voir si targetId y figure. */
async function isInFollowingSample(
  fetchFn: FetchFn,
  csrf: string,
  selfId: string,
  targetId: string,
): Promise<boolean | null> {
  let cursor: string | null = null;
  for (let page = 0; page < 2; page++) {
    const variables: Record<string, unknown> = {
      userId: selfId,
      count: 100,
      includePromotedContent: false,
    };
    if (cursor) variables.cursor = cursor;
    const params = new URLSearchParams({
      variables: JSON.stringify(variables),
      features: JSON.stringify(FOLLOWING_FEATURES),
    });
    const res = await fetchFn(
      `https://x.com/i/api/graphql/${FALLBACK_FOLLOWING_QUERY_ID}/Following?${params}`,
      {
        method: 'GET',
        headers: buildHeaders(csrf, { form: false }),
        credentials: 'include',
      },
    );
    if (res.status === 429) throw new XApiError('rate-limit', 429, 'rate-limit');
    if (!res.ok) return null;
    const text = await res.text();
    if (text.includes(`"rest_id":"${targetId}"`) || text.includes(`"rest_id": "${targetId}"`)) {
      return true;
    }
    const next = text.match(/"value":"([^"]+)","cursorType":"Bottom"/);
    cursor = next?.[1] ?? null;
    if (!cursor) break;
  }
  // Not found in sample — treat as not following (best-effort)
  return false;
}
