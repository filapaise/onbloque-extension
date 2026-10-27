/**
 * Cache persistant @ → id (chrome.storage.local, clé `resolvedIds`).
 * Les ids X ne changent jamais ; un @ peut changer de propriétaire, donc chaque
 * blocage revérifie quand même le couple id ↔ @ auprès de X juste avant d'agir.
 * Ne contient que des @ et des ids publics — aucun cookie, aucun jeton.
 */

import { HANDLE_RE, NUMERIC_ID_RE } from '../domain/handle.ts';
import { XApiError } from '../domain/errors.ts';
import { friendshipsLookup, type XContext } from './xClient.ts';

export type IdCacheEntry =
  | { s: 'ok'; id: string; h: string; at: number }
  /** Absent d'une réponse friendships/lookup réussie (supprimé, renommé, suspendu). */
  | { s: 'absent'; at: number };

export type IdCache = Record<string, IdCacheEntry>;

export const ID_CACHE_KEY = 'resolvedIds';
export const OK_TTL_MS = 7 * 24 * 3600_000;
export const ABSENT_TTL_MS = 12 * 3600_000;
const MAX_ENTRIES = 20_000;
export const BATCH_SIZE = 100;

export function cacheGet(cache: IdCache, handle: string, now = Date.now()): IdCacheEntry | null {
  const e = cache[handle.toLowerCase()];
  if (!e) return null;
  const ttl = e.s === 'ok' ? OK_TTL_MS : ABSENT_TTL_MS;
  return now - e.at < ttl ? e : null;
}

export function cachePut(cache: IdCache, updates: IdCache): IdCache {
  const next: IdCache = { ...cache, ...updates };
  const keys = Object.keys(next);
  if (keys.length <= MAX_ENTRIES) return next;
  // Élague les plus anciennes.
  keys.sort((a, b) => next[a]!.at - next[b]!.at);
  for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[k];
  return next;
}

/** Les @ (sans id) de la file à résoudre d'avance : tête comprise, hors cache valide. */
export function pickBatch(
  queue: Array<{ handle?: string; id?: string; action: string }>,
  cache: IdCache,
  now = Date.now(),
  size = BATCH_SIZE,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const q of queue) {
    if (out.length >= size) break;
    if (q.id || !q.handle || !HANDLE_RE.test(q.handle)) continue;
    const k = q.handle.toLowerCase();
    if (seen.has(k) || cacheGet(cache, k, now)) continue;
    seen.add(k);
    out.push(q.handle);
  }
  return out;
}

/**
 * Résout des @ par paquets de 100 via friendships/lookup (1 requête / 100 comptes).
 * Un @ absent d'une réponse réussie est marqué `absent`.
 * Retourne null si friendships/lookup n'est plus disponible (l'appelant résout un par un).
 */
export async function batchResolveHandles(
  ctx: XContext,
  handles: string[],
  now = Date.now(),
): Promise<IdCache | null> {
  if (!handles.length) return {};
  if (ctx.state.lookupGone) return null;
  let map;
  try {
    map = await friendshipsLookup(ctx, handles.map((h) => ({ handle: h })));
  } catch (e) {
    if (e instanceof XApiError && e.code === 'endpoint-gone') {
      ctx.state.lookupGone = true;
      return null;
    }
    throw e;
  }
  const out: IdCache = {};
  for (const h of handles) {
    const rel = map.get(`h:${h.toLowerCase()}`);
    if (rel?.id && NUMERIC_ID_RE.test(rel.id) && rel.handle) {
      out[h.toLowerCase()] = { s: 'ok', id: rel.id, h: rel.handle, at: now };
    } else {
      out[h.toLowerCase()] = { s: 'absent', at: now };
    }
  }
  return out;
}

export async function loadIdCache(): Promise<IdCache> {
  const data = (await chrome.storage.local.get(ID_CACHE_KEY)) as { resolvedIds?: IdCache };
  const c = data.resolvedIds;
  return c && typeof c === 'object' ? c : {};
}

export async function saveIdCache(updates: IdCache): Promise<void> {
  if (!Object.keys(updates).length) return;
  const cur = await loadIdCache();
  await chrome.storage.local.set({ [ID_CACHE_KEY]: cachePut(cur, updates) });
}

/** Résultat d'un friendships/lookup complet (aperçu) → entrées de cache. */
export function idCacheFromRelations(
  entries: Array<{ handle?: string; id?: string }>,
  map: Map<string, { id?: string; handle?: string }>,
  now = Date.now(),
): IdCache {
  const out: IdCache = {};
  for (const e of entries) {
    if (!e.handle || e.id) continue;
    const k = e.handle.toLowerCase();
    const rel = map.get(`h:${k}`);
    out[k] =
      rel?.id && NUMERIC_ID_RE.test(rel.id) && rel.handle
        ? { s: 'ok', id: rel.id, h: rel.handle, at: now }
        : { s: 'absent', at: now };
  }
  return out;
}
