/**
 * 1.3.0 — cache persistant id → nombre d'abonnés (chrome.storage.local, clé
 * `followerCounts`), alimenté par UsersByRestIds par paquets de 50 ids :
 * une seule requête GraphQL pour les 50 prochains comptes de la file.
 * Ne contient que des ids, des @ et des compteurs publics — aucun cookie, aucun jeton.
 */

import { NUMERIC_ID_RE } from '../domain/handle.ts';
import { cacheGet, type IdCache } from './idCache.ts';
import { usersByRestIds, type XContext } from './xClient.ts';

export type FollowerEntry =
  /** Compte lu : @ actuel + abonnés. */
  | { s: 'ok'; n: number; h: string; at: number }
  /** Compte suspendu / absent de la réponse UsersByRestIds. */
  | { s: 'gone'; at: number }
  /** Compte lu, mais X n'a pas donné le nombre d'abonnés (schéma changé ?). */
  | { s: 'unknown'; h: string; at: number };

export type FollowerCache = Record<string, FollowerEntry>;

export const FOLLOWER_CACHE_KEY = 'followerCounts';
/** Les compteurs bougent : 3 jours suffisent pour un seuil grossier (1 000, 10 000…). */
export const FOLLOWER_TTL_MS = 3 * 24 * 3600_000;
const SHORT_TTL_MS = 30 * 60_000;
export const FOLLOWER_BATCH = 50;
const MAX_ENTRIES = 20_000;

export function followerGet(cache: FollowerCache, id: string, now = Date.now()): FollowerEntry | null {
  const e = cache[id];
  if (!e) return null;
  const ttl = e.s === 'ok' ? FOLLOWER_TTL_MS : SHORT_TTL_MS;
  return now - e.at < ttl ? e : null;
}

export function followerPut(cache: FollowerCache, updates: FollowerCache): FollowerCache {
  const next: FollowerCache = { ...cache, ...updates };
  const keys = Object.keys(next);
  if (keys.length <= MAX_ENTRIES) return next;
  keys.sort((a, b) => next[a]!.at - next[b]!.at);
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[k];
  return next;
}

/** Id connu d'un élément de file : celui de la liste, sinon celui du cache @ → id. */
export function knownId(
  item: { handle?: string; id?: string },
  idCache: IdCache,
  now = Date.now(),
): string | null {
  if (item.id && NUMERIC_ID_RE.test(item.id)) return item.id;
  if (!item.handle) return null;
  const e = cacheGet(idCache, item.handle, now);
  return e?.s === 'ok' ? e.id : null;
}

/**
 * Ids à demander d'avance : `first` en tête, puis les blocages suivants de la
 * file dont l'id est connu et le compteur absent du cache (max 50).
 */
export function pickFollowerBatch(
  first: string,
  queue: Array<{ handle?: string; id?: string; action: string }>,
  idCache: IdCache,
  counts: FollowerCache,
  now = Date.now(),
  size = FOLLOWER_BATCH,
): string[] {
  const out = [first];
  const seen = new Set(out);
  for (const q of queue) {
    if (out.length >= size) break;
    if (q.action !== 'block') continue;
    const id = knownId(q, idCache, now);
    if (!id || seen.has(id) || followerGet(counts, id, now)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Une requête UsersByRestIds (≤ 50 ids) → entrées de cache. Erreurs X : remontent telles quelles. */
export async function fetchFollowerCounts(ctx: XContext, ids: string[], now = Date.now()): Promise<FollowerCache> {
  const map = await usersByRestIds(ctx, ids);
  const out: FollowerCache = {};
  for (const id of ids) {
    const u = map.get(id);
    if (!u || u.kind !== 'user') out[id] = { s: 'gone', at: now };
    else if (typeof u.followers === 'number') out[id] = { s: 'ok', n: u.followers, h: u.handle, at: now };
    else out[id] = { s: 'unknown', h: u.handle, at: now };
  }
  return out;
}

export async function loadFollowerCache(): Promise<FollowerCache> {
  const data = (await chrome.storage.local.get(FOLLOWER_CACHE_KEY)) as { followerCounts?: FollowerCache };
  const c = data.followerCounts;
  return c && typeof c === 'object' ? c : {};
}

export async function saveFollowerCache(updates: FollowerCache): Promise<void> {
  if (!Object.keys(updates).length) return;
  const cur = await loadFollowerCache();
  await chrome.storage.local.set({ [FOLLOWER_CACHE_KEY]: followerPut(cur, updates) });
}

/**
 * Nombre d'abonnés d'un compte : cache, sinon UNE requête groupée pour lui et
 * les prochains comptes de la file. `fetched` indique si une requête est partie.
 */
export async function followerEntryFor(
  ctx: XContext,
  id: string,
  queue: Array<{ handle?: string; id?: string; action: string }>,
  idCache: IdCache,
  now = Date.now(),
): Promise<{ entry: FollowerEntry; fetched: boolean }> {
  const counts = await loadFollowerCache();
  const hit = followerGet(counts, id, now);
  if (hit) return { entry: hit, fetched: false };
  const got = await fetchFollowerCounts(ctx, pickFollowerBatch(id, queue, idCache, counts, now), now);
  await saveFollowerCache(got);
  return { entry: got[id] ?? { s: 'gone', at: now }, fetched: true };
}
