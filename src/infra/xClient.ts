/**
 * Client des endpoints web de x.com, appelés depuis un onglet x.com (cookies
 * same-origin). Le CSRF est fourni par l'appelant ; aucun cookie ni jeton n'est
 * stocké ni journalisé.
 *
 * Endpoints :
 *  - identité : cookie twid (+ lien de profil de la page) → 1.1 account/settings.json
 *    → GraphQL UserByScreenName / UsersByRestIds  (verify_credentials.json : 404 depuis 2026)
 *  - relations : 1.1 friendships/lookup.json, sinon GraphQL Following/Followers/UsersByRestIds
 *  - résolution : GraphQL UserByScreenName / UsersByRestIds, 1.1 friendships/lookup en secours
 *  - blocage : 1.1 blocks/create.json / blocks/destroy.json (pas d'équivalent GraphQL côté web)
 */

import { HANDLE_RE, NUMERIC_ID_RE } from '../domain/handle.ts';
import { XApiError, parseRateLimitReset, sanitizeErrorBody } from '../domain/errors.ts';
import type { Relationship } from '../domain/types.ts';
import type { GqlOperationName, OperationSource } from './graphqlOps.ts';

export const X_WEB_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const ENDPOINTS = {
  friendshipsLookup: 'https://x.com/i/api/1.1/friendships/lookup.json',
  blocksCreate: 'https://x.com/i/api/1.1/blocks/create.json',
  blocksDestroy: 'https://x.com/i/api/1.1/blocks/destroy.json',
  accountSettings: 'https://x.com/i/api/1.1/account/settings.json',
  graphql: 'https://x.com/i/api/graphql',
} as const;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** État partagé entre requêtes tant que le service worker vit. */
export interface XClientState {
  /** friendships/lookup a répondu 404/410 : on passe directement par GraphQL. */
  lookupGone: boolean;
  /**
   * Mémo très court (10 s) des friendships/lookup portant sur UN seul id :
   * la résolution et le garde-fou d'un même blocage, à quelques ms d'écart,
   * partagent ainsi une seule requête (moins de risque de 429 en rythme Max).
   */
  relMemo?: Map<string, { at: number; rel: Relationship | null }>;
  following?: { selfId: string; at: number; set: UserSet };
}

export interface XContext {
  fetchFn: FetchFn;
  csrf: string;
  ops: OperationSource;
  state: XClientState;
  /** Pause entre pages / paquets (ms). */
  throttleMs?: number;
}

export interface SelfAccount {
  id: string;
  handle?: string;
}

export function buildHeaders(csrf: string, opts: { form?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: X_WEB_BEARER,
    'x-csrf-token': csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'fr',
  };
  if (opts.form) headers['content-type'] = 'application/x-www-form-urlencoded';
  return headers;
}

function pause(ctx: XContext): Promise<void> {
  const ms = ctx.throttleMs ?? 1500;
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

async function xGet(ctx: XContext, url: string): Promise<Response> {
  return ctx.fetchFn(url, {
    method: 'GET',
    headers: buildHeaders(ctx.csrf),
    credentials: 'include',
  });
}

/** Erreur commune aux GET : 429 / 401 / 404-410 / autres. */
export function rateLimitResetOf(res: Response): number | undefined {
  return parseRateLimitReset(res.headers.get('x-rate-limit-reset'));
}

/** Codes d'erreur X (`{"errors":[{"code":17}]}`) d'un corps de réponse. */
export function errorCodes(text: string): number[] {
  try {
    const errs = obj(JSON.parse(text))?.errors;
    if (Array.isArray(errs)) return errs.map((e) => Number(obj(e)?.code)).filter(Number.isFinite);
  } catch {
    /* corps non JSON */
  }
  return [];
}

async function httpError(res: Response, label: string): Promise<XApiError> {
  const raw = await res.text().catch(() => '');
  const body = sanitizeErrorBody(raw);
  if (res.status === 429 || errorCodes(raw).includes(88)) {
    return new XApiError(`${label} : rate-limit`, 429, 'rate-limit', body, rateLimitResetOf(res));
  }
  if (res.status === 401) return new XApiError('not-logged-in', 401, 'not-logged-in', body);
  if (res.status === 404 || res.status === 410) return new XApiError(label, res.status, 'endpoint-gone', body);
  if (res.status === 403) return new XApiError(`${label} 403`, 403, 'forbidden', body);
  return new XApiError(`${label} ${res.status}`, res.status, 'network', body);
}

/* ------------------------------------------------------------------ */
/* GraphQL                                                             */
/* ------------------------------------------------------------------ */

function gqlUrl(
  op: { name: string; queryId: string; features: Record<string, boolean>; fieldToggles?: Record<string, boolean> },
  variables: Record<string, unknown>,
): string {
  const params = new URLSearchParams({
    variables: JSON.stringify(variables),
    features: JSON.stringify(op.features),
  });
  if (op.fieldToggles) params.set('fieldToggles', JSON.stringify(op.fieldToggles));
  return `${ENDPOINTS.graphql}/${op.queryId}/${op.name}?${params}`;
}

/**
 * GET GraphQL. Un 400/404 sur un queryId découvert → on l'oublie et on réessaie
 * une fois avec les valeurs embarquées. Retourne le JSON brut.
 */
export async function gqlGet(
  ctx: XContext,
  name: GqlOperationName,
  variables: Record<string, unknown>,
): Promise<unknown> {
  let op = await ctx.ops.get(name);
  let res = await xGet(ctx, gqlUrl(op, variables));
  if (res.status === 400 || res.status === 404) {
    // queryId probablement périmé (nouveau build de X) : on relit UNE fois les
    // bundles de la page ; si rien de neuf, valeurs embarquées ; un seul nouvel essai.
    const tried = op.queryId;
    await ctx.ops.invalidate(name);
    const fresh = ctx.ops.refresh ? await ctx.ops.refresh(name) : null;
    const next = fresh && fresh.queryId !== tried ? fresh : await ctx.ops.get(name);
    if (next.queryId !== tried) {
      op = next;
      res = await xGet(ctx, gqlUrl(op, variables));
    }
  }
  if (res.status === 400) {
    throw new XApiError(`GraphQL ${name} 400`, 400, 'endpoint-gone', sanitizeErrorBody(await res.text().catch(() => '')));
  }
  if (!res.ok) throw await httpError(res, `GraphQL ${name}`);
  try {
    return JSON.parse(await res.text()) as unknown;
  } catch {
    throw new XApiError(`GraphQL ${name} : réponse illisible`, res.status, 'resolver-failed');
  }
}

export type GqlUser =
  | {
      kind: 'user';
      id: string;
      handle: string;
      name?: string;
      following?: boolean;
      followedBy?: boolean;
      blocking?: boolean;
    }
  | { kind: 'unavailable'; id?: string };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Lit un objet `result` utilisateur GraphQL (schémas legacy et 2025+). */
export function parseUserResult(raw: unknown): GqlUser | null {
  const r = obj(raw);
  if (!r) return null;
  const typename = typeof r.__typename === 'string' ? r.__typename : 'User';
  const id = typeof r.rest_id === 'string' && NUMERIC_ID_RE.test(r.rest_id) ? r.rest_id : undefined;
  if (typename !== 'User') return { kind: 'unavailable', id };
  const legacy = obj(r.legacy) ?? {};
  const core = obj(r.core) ?? {};
  const rel = obj(r.relationship_perspectives) ?? {};
  const handle =
    (typeof core.screen_name === 'string' && core.screen_name) ||
    (typeof legacy.screen_name === 'string' && legacy.screen_name) ||
    '';
  if (!id || !HANDLE_RE.test(handle)) return null;
  const nameRaw = core.name ?? legacy.name;
  return {
    kind: 'user',
    id,
    handle,
    name: typeof nameRaw === 'string' ? nameRaw.slice(0, 100) : undefined,
    following: bool(rel.following) ?? bool(legacy.following),
    followedBy: bool(rel.followed_by) ?? bool(legacy.followed_by),
    blocking: bool(rel.blocking) ?? bool(legacy.blocking),
  };
}

export type UserLookup =
  | { status: 'ok'; user: Extract<GqlUser, { kind: 'user' }> }
  | { status: 'not-found' }
  | { status: 'suspended' };

/** Interprète une réponse UserByScreenName. Réponse inexploitable → resolver-failed. */
export function parseUserByScreenNameBody(json: unknown): UserLookup {
  const data = obj(obj(json)?.data);
  if (!data) throw new XApiError('UserByScreenName : réponse inattendue', 0, 'resolver-failed');
  const user = obj(data.user);
  if (!user || !user.result) return { status: 'not-found' };
  const parsed = parseUserResult(user.result);
  if (!parsed) throw new XApiError('UserByScreenName : utilisateur illisible', 0, 'resolver-failed');
  if (parsed.kind === 'unavailable') return { status: 'suspended' };
  return { status: 'ok', user: parsed };
}

export async function userByScreenName(ctx: XContext, handle: string): Promise<UserLookup> {
  const json = await gqlGet(ctx, 'UserByScreenName', {
    screen_name: handle,
    withSafetyModeUserFields: true,
  });
  return parseUserByScreenNameBody(json);
}

/** UsersByRestIds par paquets de 50. Les ids inconnus de X sont absents de la Map. */
export async function usersByRestIds(ctx: XContext, ids: string[]): Promise<Map<string, GqlUser>> {
  const out = new Map<string, GqlUser>();
  const unique = [...new Set(ids.filter((i) => NUMERIC_ID_RE.test(i)))];
  for (let i = 0; i < unique.length; i += 50) {
    if (i > 0) await pause(ctx);
    const chunk = unique.slice(i, i + 50);
    const json = await gqlGet(ctx, 'UsersByRestIds', { userIds: chunk });
    const users = obj(obj(json)?.data)?.users;
    if (!Array.isArray(users)) throw new XApiError('UsersByRestIds : réponse inattendue', 0, 'resolver-failed');
    for (const u of users) {
      const parsed = parseUserResult(obj(u)?.result);
      if (parsed?.id) out.set(parsed.id, parsed);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Abonnements / abonnés (GraphQL Following / Followers)               */
/* ------------------------------------------------------------------ */

export interface UserSet {
  ids: Set<string>;
  /** handle en minuscules → id */
  handles: Map<string, string>;
  complete: boolean;
}

/** Une page de timeline Following/Followers → utilisateurs + curseur bas. */
export function parseUserTimelinePage(json: unknown): {
  users: Array<{ id: string; handle: string }>;
  cursor: string | null;
} {
  const result = obj(obj(obj(obj(json)?.data)?.user)?.result);
  const timeline = obj(obj(result?.timeline)?.timeline) ?? obj(obj(result?.timeline_v2)?.timeline);
  const instructions = timeline?.instructions;
  if (!Array.isArray(instructions)) {
    throw new XApiError('Timeline : réponse inattendue', 0, 'guard-unavailable');
  }
  const users: Array<{ id: string; handle: string }> = [];
  let cursor: string | null = null;
  const visit = (entry: unknown) => {
    const e = obj(entry);
    const content = obj(e?.content);
    if (!content) return;
    if (content.cursorType === 'Bottom' && typeof content.value === 'string') {
      cursor = content.value;
      return;
    }
    const u = parseUserResult(obj(obj(content.itemContent)?.user_results)?.result);
    if (u?.kind === 'user') users.push({ id: u.id, handle: u.handle });
  };
  for (const inst of instructions) {
    const i = obj(inst);
    if (Array.isArray(i?.entries)) i.entries.forEach(visit);
    if (i?.entry) visit(i.entry);
  }
  return { users, cursor };
}

/** Parcourt Following/Followers jusqu'à la fin ou `maxPages`. */
export async function fetchUserSet(
  ctx: XContext,
  op: 'Following' | 'Followers',
  userId: string,
  maxPages: number,
): Promise<UserSet> {
  const set: UserSet = { ids: new Set(), handles: new Map(), complete: false };
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    if (page > 0) await pause(ctx);
    const variables: Record<string, unknown> = { userId, count: 100, includePromotedContent: false };
    if (cursor) variables.cursor = cursor;
    const { users, cursor: next } = parseUserTimelinePage(await gqlGet(ctx, op, variables));
    let added = 0;
    for (const u of users) {
      if (set.ids.has(u.id)) continue;
      set.ids.add(u.id);
      set.handles.set(u.handle.toLowerCase(), u.id);
      added++;
    }
    if (!next || next === cursor || added === 0) {
      set.complete = true;
      return set;
    }
    cursor = next;
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* friendships/lookup (1.1)                                            */
/* ------------------------------------------------------------------ */

/**
 * Relations par paquets de 100. Échec HTTP → throw (fail-closed) ;
 * 404/410 → `endpoint-gone` pour que l'appelant passe par GraphQL.
 */
export async function friendshipsLookup(
  ctx: XContext,
  refs: Array<{ handle?: string; id?: string }>,
): Promise<Map<string, Relationship>> {
  const map = new Map<string, Relationship>();
  const single = refs.length === 1 && refs[0]!.id ? refs[0]!.id : null;
  if (single) {
    refs = [{ id: single }]; // l'id fait foi ; X renvoie le @ actuel
    const m = ctx.state.relMemo?.get(single);
    if (m && Date.now() - m.at < REL_MEMO_MS) {
      if (m.rel) {
        map.set(`id:${single}`, m.rel);
        if (m.rel.handle) map.set(`h:${m.rel.handle.toLowerCase()}`, m.rel);
      }
      return map;
    }
  }
  for (let i = 0; i < refs.length; i += 100) {
    if (i > 0) await pause(ctx);
    const chunk = refs.slice(i, i + 100);
    const params = new URLSearchParams();
    const names = chunk.map((r) => r.handle).filter((h): h is string => !!h);
    const ids = chunk.map((r) => r.id).filter((x): x is string => !!x);
    if (names.length) params.set('screen_name', names.join(','));
    if (ids.length) params.set('user_id', ids.join(','));
    if (!names.length && !ids.length) continue;
    const res = await xGet(ctx, `${ENDPOINTS.friendshipsLookup}?${params}`);
    if (res.status === 404) {
      // 404 + code 17 « No user matches for specified terms » : aucun compte du
      // paquet n'existe (supprimés / renommés). Ce n'est PAS l'endpoint qui a disparu.
      const raw = await res.clone().text().catch(() => '');
      if (errorCodes(raw).includes(17)) continue;
    }
    if (!res.ok) throw await httpError(res, 'friendships/lookup');
    let data: unknown;
    try {
      data = JSON.parse(await res.text());
    } catch {
      data = null;
    }
    if (!Array.isArray(data)) throw new XApiError('friendships/lookup : réponse inattendue', 0, 'network');
    for (const raw of data) {
      const u = obj(raw) ?? {};
      const connections = Array.isArray(u.connections) ? u.connections : [];
      const rel: Relationship = {
        id: typeof u.id_str === 'string' ? u.id_str : undefined,
        handle: typeof u.screen_name === 'string' ? u.screen_name : undefined,
        name: typeof u.name === 'string' ? u.name : undefined,
        following: connections.includes('following'),
        followedBy: connections.includes('followed_by'),
        blocking: connections.includes('blocking'),
      };
      if (rel.handle) map.set(`h:${rel.handle.toLowerCase()}`, rel);
      if (rel.id) map.set(`id:${rel.id}`, rel);
    }
  }
  if (single) {
    ctx.state.relMemo ??= new Map();
    ctx.state.relMemo.set(single, { at: Date.now(), rel: map.get(`id:${single}`) ?? null });
    if (ctx.state.relMemo.size > 50) ctx.state.relMemo.clear();
  }
  return map;
}

const REL_MEMO_MS = 10_000;

/* ------------------------------------------------------------------ */
/* Identité du compte connecté                                         */
/* ------------------------------------------------------------------ */

/** Valeur brute du cookie twid (« u%3D123 », « "u=123" ») → id numérique. */
export function parseTwid(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let v = raw.trim().replace(/^"|"$/g, '');
  try {
    v = decodeURIComponent(v);
  } catch {
    return null;
  }
  const m = v.replace(/^"|"$/g, '').match(/^u=(\d{1,20})$/);
  return m?.[1] ?? null;
}

/** 1.1 account/settings.json → screen_name, ou null si indisponible. */
export async function settingsScreenName(ctx: XContext): Promise<string | null> {
  const res = await xGet(ctx, ENDPOINTS.accountSettings);
  if (res.status === 429) throw new XApiError('account/settings : rate-limit', 429, 'rate-limit', undefined, rateLimitResetOf(res));
  if (!res.ok) return null;
  try {
    const u = obj(JSON.parse(await res.text()));
    const sn = u?.screen_name;
    return typeof sn === 'string' && HANDLE_RE.test(sn) ? sn : null;
  } catch {
    return null;
  }
}

/**
 * Compte connecté. L'id vient du cookie twid quand il est lisible (source la
 * plus sûre) ; sinon handle (lien de profil de la page ou settings.json) puis
 * UserByScreenName. Retourne null si rien n'est fiable (l'appelant bloque tout).
 */
export async function identifySelf(
  ctx: XContext,
  hints: { twidId?: string | null; profileHandle?: string | null },
): Promise<SelfAccount | null> {
  const soft = async <T>(p: () => Promise<T>): Promise<T | null> => {
    try {
      return await p();
    } catch (e) {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      return null;
    }
  };
  let handle = hints.profileHandle && HANDLE_RE.test(hints.profileHandle) ? hints.profileHandle : null;

  if (hints.twidId && NUMERIC_ID_RE.test(hints.twidId)) {
    const id = hints.twidId;
    if (!handle) handle = await soft(() => settingsScreenName(ctx));
    if (!handle) {
      const u = (await soft(() => usersByRestIds(ctx, [id])))?.get(id);
      if (u?.kind === 'user') handle = u.handle;
    }
    return handle ? { id, handle } : { id };
  }

  if (!handle) handle = await soft(() => settingsScreenName(ctx));
  if (!handle) return null;
  const found = await soft(() => userByScreenName(ctx, handle!));
  if (found?.status !== 'ok') return null;
  return { id: found.user.id, handle: found.user.handle };
}

/* ------------------------------------------------------------------ */
/* Résolution id ↔ handle                                              */
/* ------------------------------------------------------------------ */

export type ResolveResult =
  | { ok: true; id: string; handle: string }
  | { ok: false; reason: 'not-found' | 'suspended' | 'mismatch' };

/** Utilisateur par id : friendships/lookup, sinon UsersByRestIds. */
async function lookupById(ctx: XContext, id: string): Promise<GqlUser | null> {
  if (!ctx.state.lookupGone) {
    try {
      const rel = (await friendshipsLookup(ctx, [{ id }])).get(`id:${id}`);
      return rel?.handle ? { kind: 'user', id, handle: rel.handle } : null;
    } catch (e) {
      if (!(e instanceof XApiError && e.code === 'endpoint-gone')) throw e;
      ctx.state.lookupGone = true;
    }
  }
  return (await usersByRestIds(ctx, [id])).get(id) ?? null;
}

/**
 * Résout un compte avant action. Si la liste donne id ET handle, X doit
 * confirmer que cet id porte bien ce handle (sinon `mismatch`).
 * Les erreurs de transport remontent (rate-limit, endpoint-gone…).
 */
export async function resolveUserId(
  ctx: XContext,
  ref: { handle?: string; id?: string },
): Promise<ResolveResult> {
  if (ref.id) {
    const u = await lookupById(ctx, ref.id);
    if (!u) return { ok: false, reason: 'not-found' };
    if (u.kind === 'unavailable') return { ok: false, reason: 'suspended' };
    if (ref.handle && u.handle.toLowerCase() !== ref.handle.toLowerCase()) {
      return { ok: false, reason: 'mismatch' };
    }
    return { ok: true, id: u.id, handle: u.handle };
  }
  if (!ref.handle) return { ok: false, reason: 'not-found' };

  let found: UserLookup;
  try {
    found = await userByScreenName(ctx, ref.handle);
  } catch (e) {
    const recoverable =
      e instanceof XApiError && (e.code === 'endpoint-gone' || e.code === 'resolver-failed');
    if (!recoverable || ctx.state.lookupGone) throw e;
    const rel = (await friendshipsLookup(ctx, [{ handle: ref.handle }])).get(`h:${ref.handle.toLowerCase()}`);
    if (!rel?.id || !rel.handle) return { ok: false, reason: 'not-found' };
    return { ok: true, id: rel.id, handle: rel.handle };
  }
  if (found.status !== 'ok') return { ok: false, reason: found.status };
  return { ok: true, id: found.user.id, handle: found.user.handle };
}

/* ------------------------------------------------------------------ */
/* Blocage / déblocage (1.1)                                           */
/* ------------------------------------------------------------------ */

/**
 * Classe une réponse blocks/create|destroy en erreur (null = succès).
 * Un 404 n'est « compte introuvable » que si X le dit (code 50/63) : sinon
 * c'est l'endpoint qui a disparu et on met en pause au lieu de vider la file.
 */
export function classifyBlockResponse(
  status: number,
  text: string,
  label: string,
  resetAt?: number,
): XApiError | null {
  if (status >= 200 && status < 300) return null;
  const safe = sanitizeErrorBody(text);
  const codes = errorCodes(text);
  if (status === 429 || codes.includes(88)) return new XApiError(`${label} : rate-limit`, 429, 'rate-limit', safe, resetAt);
  if (codes.includes(50)) return new XApiError('not-found', status, 'not-found', safe);
  if (codes.includes(63)) return new XApiError('suspended', status, 'suspended', safe);
  if (status === 401 || codes.includes(32) || codes.includes(353)) {
    return new XApiError('not-logged-in', status, 'not-logged-in', safe);
  }
  if (status === 404 || status === 410) return new XApiError(label, status, 'endpoint-gone', safe);
  if (status === 403) return new XApiError('forbidden', 403, 'forbidden', safe);
  return new XApiError(`${label} ${status}`, status, 'unknown', safe);
}

async function postBlock(
  ctx: XContext,
  endpoint: string,
  label: string,
  target: { id: string; handle: string },
): Promise<{ id: string; handle: string }> {
  const res = await ctx.fetchFn(endpoint, {
    method: 'POST',
    headers: buildHeaders(ctx.csrf, { form: true }),
    credentials: 'include',
    body: `user_id=${encodeURIComponent(target.id)}`,
  });
  const text = await res.text().catch(() => '');
  const err = classifyBlockResponse(res.status, text, label, rateLimitResetOf(res));
  if (err) throw err;
  return target;
}

/** Bloque un compte déjà résolu (id vérifié). */
export function blockUser(ctx: XContext, target: { id: string; handle: string }) {
  return postBlock(ctx, ENDPOINTS.blocksCreate, 'blocks/create', target);
}

/** Débloque un compte déjà résolu. */
export function unblockUser(ctx: XContext, target: { id: string; handle: string }) {
  return postBlock(ctx, ENDPOINTS.blocksDestroy, 'blocks/destroy', target);
}
