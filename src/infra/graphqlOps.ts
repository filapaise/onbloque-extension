/**
 * Opérations GraphQL de x.com : queryId + features.
 * Les queryId tournent à chaque build de X : on les relit dans les bundles
 * abs.twimg.com déjà chargés par l'onglet (aucun code distant exécuté — simple
 * extraction de chaînes), sinon on retombe sur les valeurs embarquées.
 * Valeurs embarquées relevées le 2026-10-17.
 */

export type GqlOperationName = 'UserByScreenName' | 'UsersByRestIds' | 'Following' | 'Followers';

export interface GqlOperation {
  name: GqlOperationName;
  queryId: string;
  features: Record<string, boolean>;
  fieldToggles?: Record<string, boolean>;
  /** true = valeurs embarquées (pas de nouvel essai possible). */
  fallback: boolean;
}

export interface OperationSource {
  get(name: GqlOperationName): Promise<GqlOperation>;
  /** Oublie la version découverte (queryId périmé) → prochain get = valeurs embarquées. */
  invalidate(name: GqlOperationName): Promise<void>;
  /**
   * Relit les bundles de la page en ignorant le cache (queryId périmé).
   * Une seule fois par source et par opération ; null si rien de neuf.
   */
  refresh?(name: GqlOperationName): Promise<GqlOperation | null>;
}

const USER_FEATURES: Record<string, boolean> = {
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

const USERS_BY_IDS_FEATURES: Record<string, boolean> = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
};

const TIMELINE_FEATURES: Record<string, boolean> = {
  rweb_video_screen_enabled: false,
  rweb_cashtags_enabled: true,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: true,
  rweb_tipjar_consumption_enabled: false,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  premium_content_api_read_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: true,
  rweb_cashtags_composer_attachment_enabled: true,
  responsive_web_jetfuel_frame: true,
  rweb_sports_post_context_enabled: true,
  responsive_web_grok_share_attachment_enabled: true,
  responsive_web_grok_annotations_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  rweb_conversational_replies_downvote_enabled: false,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  content_disclosure_indicator_enabled: true,
  content_disclosure_ai_generated_indicator_enabled: true,
  responsive_web_grok_show_grok_translated_post: true,
  responsive_web_grok_analysis_button_from_backend: true,
  post_ctas_fetch_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: false,
  responsive_web_nested_quote_preview_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
  responsive_web_grok_imagine_annotation_enabled: true,
  responsive_web_grok_community_note_auto_translation_is_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

export const FALLBACK_OPERATIONS: Record<GqlOperationName, GqlOperation> = {
  UserByScreenName: {
    name: 'UserByScreenName',
    queryId: 'AMIBMjtxEEATh4z8V9GtRg',
    features: USER_FEATURES,
    fieldToggles: { withAuxiliaryUserLabels: true },
    fallback: true,
  },
  UsersByRestIds: {
    name: 'UsersByRestIds',
    queryId: 'ubfbnAM4qTlMTOYleYhXSg',
    features: USERS_BY_IDS_FEATURES,
    fallback: true,
  },
  Following: {
    name: 'Following',
    queryId: 'ath0FIohYC_c3Hj3SsxoCg',
    features: TIMELINE_FEATURES,
    fallback: true,
  },
  Followers: {
    name: 'Followers',
    queryId: 'stpzFPAIZ2qv8s2lRzPOnQ',
    features: TIMELINE_FEATURES,
    fallback: true,
  },
};

const OPERATION_NAMES = Object.keys(FALLBACK_OPERATIONS) as GqlOperationName[];
const CACHE_KEY = 'graphqlOps';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const MAX_BUNDLES = 20;

export function isAllowedBundleUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'abs.twimg.com' && u.pathname.endsWith('.js');
  } catch {
    return false;
  }
}

export interface DiscoveredOperation {
  queryId: string;
  featureKeys: string[];
  fieldToggleKeys: string[];
}

/**
 * Extrait queryId + noms de features d'une opération dans un bundle minifié.
 * Le queryId doit être collé à operationName (≤ 400 caractères sans « } »)
 * pour ne pas attraper celui d'un module voisin.
 */
export function extractOperation(text: string, name: string): DiscoveredOperation | null {
  if (!text || !/^[A-Za-z]+$/.test(name)) return null;
  const reA = new RegExp(`queryId:"([A-Za-z0-9_-]{10,})"[^}]{0,400}?operationName:"${name}"`);
  const reB = new RegExp(`operationName:"${name}"[^}]{0,400}?queryId:"([A-Za-z0-9_-]{10,})"`);
  const m = text.match(reA) ?? text.match(reB);
  if (!m?.[1] || m.index == null) return null;
  // metadata (featureSwitches) suit queryId/operationName dans le même module :
  // on s'arrête avant le queryId du module suivant.
  const next = text.indexOf('queryId:"', m.index + m[0].length);
  const win = text.slice(m.index, next > 0 ? Math.min(next, m.index + 1500) : m.index + 1500);
  const keys = (src: string | undefined) =>
    src ? Array.from(src.matchAll(/"([A-Za-z0-9_]+)"/g), (x) => x[1]!) : [];
  return {
    queryId: m[1],
    featureKeys: keys(win.match(/featureSwitches:\[([^\]]*)\]/)?.[1]),
    fieldToggleKeys: keys(win.match(/fieldToggles:\[([^\]]*)\]/)?.[1]),
  };
}

/** Construit l'opération à envoyer : queryId découvert + features exigées par le bundle. */
export function mergeOperation(name: GqlOperationName, found: DiscoveredOperation): GqlOperation {
  const base = FALLBACK_OPERATIONS[name];
  const features: Record<string, boolean> = {};
  if (found.featureKeys.length) {
    // X exige la présence de chaque feature ; une valeur absente vaut false côté serveur.
    for (const k of found.featureKeys) features[k] = base.features[k] ?? false;
  } else {
    Object.assign(features, base.features);
  }
  let fieldToggles = base.fieldToggles;
  if (found.fieldToggleKeys.length) {
    fieldToggles = {};
    for (const k of found.fieldToggleKeys) fieldToggles[k] = base.fieldToggles?.[k] ?? false;
  }
  return { name, queryId: found.queryId, features, fieldToggles, fallback: false };
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function discoverOperations(
  fetchFn: FetchFn,
  scriptUrls: string[],
): Promise<Partial<Record<GqlOperationName, DiscoveredOperation>>> {
  const found: Partial<Record<GqlOperationName, DiscoveredOperation>> = {};
  const candidates = [...new Set(scriptUrls.filter(isAllowedBundleUrl))].slice(0, MAX_BUNDLES);
  for (const url of candidates) {
    if (OPERATION_NAMES.every((n) => found[n])) break;
    try {
      const res = await fetchFn(url, { method: 'GET', credentials: 'omit' });
      if (!res.ok) continue;
      const text = await res.text();
      if (text.length > MAX_BUNDLE_BYTES || !text.includes('operationName')) continue;
      for (const n of OPERATION_NAMES) {
        if (found[n]) continue;
        const op = extractOperation(text, n);
        if (op) found[n] = op;
      }
    } catch {
      /* bundle suivant */
    }
  }
  return found;
}

interface CacheShape {
  at: number;
  ops: Partial<Record<GqlOperationName, DiscoveredOperation>>;
}

/**
 * Source d'opérations adossée à chrome.storage.local (cache 24 h).
 * La découverte n'est lancée qu'une fois par source, au premier besoin.
 */
export function createOperationSource(
  fetchFn: FetchFn,
  scriptUrls: () => Promise<string[]>,
): OperationSource {
  let loaded: CacheShape | null = null;
  const refreshed = new Set<GqlOperationName>();

  async function load(): Promise<CacheShape> {
    if (loaded) return loaded;
    const data = (await chrome.storage.local.get(CACHE_KEY)) as { graphqlOps?: CacheShape };
    const cached = data.graphqlOps;
    if (cached?.at && Date.now() - cached.at < CACHE_TTL_MS && cached.ops) {
      loaded = cached;
      return loaded;
    }
    const ops = await discoverOperations(fetchFn, await scriptUrls());
    loaded = { at: Date.now(), ops };
    await chrome.storage.local.set({ [CACHE_KEY]: loaded });
    return loaded;
  }

  return {
    async get(name) {
      const cache = await load();
      const found = cache.ops[name];
      return found ? mergeOperation(name, found) : FALLBACK_OPERATIONS[name];
    },
    async invalidate(name) {
      const cache = await load();
      if (!cache.ops[name]) return;
      delete cache.ops[name];
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
    },
    async refresh(name) {
      if (refreshed.has(name)) return null;
      refreshed.add(name);
      const found = (await discoverOperations(fetchFn, await scriptUrls()))[name];
      if (!found) return null;
      const cache = await load();
      cache.ops[name] = found;
      await chrome.storage.local.set({ [CACHE_KEY]: cache });
      return mergeOperation(name, found);
    },
  };
}

