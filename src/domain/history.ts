import type { BlockedRecord, ListEntry, Relationship } from './types.ts';
import { entryKeys, HANDLE_RE, NUMERIC_ID_RE, RESERVED_PATHS } from './handle.ts';

/**
 * 1.3.2 — Historique des blocages faits par l'extension.
 *
 * Source unique : `blockedByExt` (chrome.storage.local), déjà alimenté à chaque blocage
 * réussi depuis les premières versions, vidé par « Réinitialiser » (RESET_HISTORY) et
 * par l'annulation des blocages. Aucun nouveau compteur : le total se déduit de cette
 * liste, il est donc toujours cohérent avec elle (et avec les installations existantes).
 */

function validAt(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Comptes bloqués par l'extension, sans doublon (même id ou même @, casse ignorée),
 * du plus récent au plus ancien. Entrées invalides (ni id ni @) ignorées.
 */
export function blockedAccounts(records: readonly BlockedRecord[] | null | undefined): BlockedRecord[] {
  if (!Array.isArray(records)) return [];
  const clean: BlockedRecord[] = [];
  for (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const id = typeof r.id === 'string' && NUMERIC_ID_RE.test(r.id) ? r.id : undefined;
    const handle = typeof r.handle === 'string' && HANDLE_RE.test(r.handle) ? r.handle : undefined;
    if (!id && !handle) continue;
    clean.push({ ...(id ? { id } : {}), ...(handle ? { handle } : {}), at: validAt(r.at) });
  }
  clean.sort((a, b) => b.at - a.at);
  const seen = new Set<string>();
  const out: BlockedRecord[] = [];
  for (const r of clean) {
    const keys = entryKeys(r);
    if (keys.some((k) => seen.has(k))) {
      for (const k of keys) seen.add(k);
      continue;
    }
    for (const k of keys) seen.add(k);
    out.push(r);
  }
  return out;
}

/** Nombre total de comptes bloqués par l'extension depuis l'installation (ou la dernière réinitialisation). */
export function totalBlocked(records: readonly BlockedRecord[] | null | undefined): number {
  return blockedAccounts(records).length;
}

export function fmtCount(n: number): string {
  try {
    return new Intl.NumberFormat('fr-FR').format(n);
  } catch {
    return String(n);
  }
}

/** Ligne du popup : « Total bloqué depuis le début : N ». */
export function totalBlockedLine(n: number): string {
  return `Total bloqué depuis le début : ${fmtCount(Math.max(0, Math.floor(n) || 0))}`;
}

/** Légende des tuiles du popup : elles décrivent le lot en cours (ou le dernier lot). */
export function batchCaption(queueLength: number): string {
  return queueLength > 0 ? 'Lot en cours' : 'Dernier lot';
}

/** Lien de profil x.com sûr (seulement pour un @ valide), sinon null. */
export function profileUrl(r: { handle?: string; id?: string }): string | null {
  const h = r.handle;
  if (h && HANDLE_RE.test(h) && !RESERVED_PATHS.has(h.toLowerCase())) return `https://x.com/${h}`;
  if (r.id && NUMERIC_ID_RE.test(r.id)) return `https://x.com/i/user/${r.id}`;
  return null;
}

/** Libellé d'un compte de l'historique. */
export function accountLabel(r: { handle?: string; id?: string }): string {
  if (r.handle) return `@${r.handle}`;
  return r.id ? `id ${r.id}` : '?';
}

/**
 * 1.3.2 — Comptes de la liste que X signale comme DÉJÀ bloqués sur le compte de
 * l'utilisateur (bloqués à la main, par une autre copie de l'extension…).
 *
 * Stockés uniquement dans chrome.storage.local (clé `blockedOnAccount`), jamais envoyés
 * ailleurs ni exposés au content script. Mis à jour quand l'extension lit les relations
 * (aperçu, « Rafraîchir les relations », garde-fou avant un blocage) et après un
 * déblocage. Plafonné et nettoyé à chaque écriture.
 */
export const ACCOUNT_BLOCKED_KEY = 'blockedOnAccount';
export const ACCOUNT_BLOCKED_CAP = 5000;

/** Relation observée sur X pour un compte : `blocking` vrai / faux. */
export interface BlockingObservation {
  id?: string;
  handle?: string;
  blocking: boolean;
}

/** Valeur lue en stockage → enregistrements valides, sans doublon, plafonnés (plus récents gardés). */
export function sanitizeAccountBlocked(raw: unknown, cap = ACCOUNT_BLOCKED_CAP): BlockedRecord[] {
  return blockedAccounts(Array.isArray(raw) ? (raw as BlockedRecord[]) : []).slice(0, Math.max(0, cap));
}

function cleanRef(o: { id?: unknown; handle?: unknown }): { id?: string; handle?: string } | null {
  const id = typeof o.id === 'string' && NUMERIC_ID_RE.test(o.id) ? o.id : undefined;
  const handle = typeof o.handle === 'string' && HANDLE_RE.test(o.handle) ? o.handle : undefined;
  if (!id && !handle) return null;
  return { ...(id ? { id } : {}), ...(handle ? { handle } : {}) };
}

/**
 * Applique des observations de X à l'ensemble des comptes déjà bloqués :
 * - `blocking: true` → ajouté (ou complété : id / @ à jour) ;
 * - `blocking: false` → retiré, seulement si `allowRemoval` (source fiable).
 * Renvoie `null` si rien ne change (évite une écriture inutile).
 */
export function applyBlockingObservations(
  current: unknown,
  observations: readonly BlockingObservation[],
  now: number,
  opts: { allowRemoval: boolean },
): BlockedRecord[] | null {
  let records = sanitizeAccountBlocked(current);
  const before = JSON.stringify(records);
  const removeKeys = new Set<string>();
  const adds: Array<{ id?: string; handle?: string }> = [];
  for (const o of observations) {
    if (!o || typeof o !== 'object') continue;
    const ref = cleanRef(o);
    if (!ref) continue;
    if (o.blocking === true) adds.push(ref);
    else if (o.blocking === false && opts.allowRemoval) for (const k of entryKeys(ref)) removeKeys.add(k);
  }
  if (removeKeys.size) records = records.filter((r) => !entryKeys(r).some((k) => removeKeys.has(k)));
  for (const ref of adds) {
    const keys = entryKeys(ref);
    const i = records.findIndex((r) => entryKeys(r).some((k) => keys.includes(k)));
    if (i >= 0) {
      const prev = records[i]!;
      // Un id fait foi : si l'id diffère, c'est un autre compte (même @ réattribué).
      if (prev.id && ref.id && prev.id !== ref.id) {
        records.splice(i, 1);
        records.push({ ...ref, at: now });
      } else {
        records[i] = { id: ref.id ?? prev.id, handle: ref.handle ?? prev.handle, at: prev.at || now };
        if (!records[i]!.id) delete records[i]!.id;
        if (!records[i]!.handle) delete records[i]!.handle;
      }
    } else {
      records.push({ ...ref, at: now });
    }
  }
  const next = sanitizeAccountBlocked(records);
  return JSON.stringify(next) === before ? null : next;
}

/**
 * Total affiché dans le popup : union (sans doublon, id prioritaire) des comptes bloqués
 * par l'extension et des comptes de la liste déjà bloqués sur le compte.
 */
export function totalBlockedUnion(
  byExt: readonly BlockedRecord[] | null | undefined,
  onAccount: readonly BlockedRecord[] | null | undefined,
): number {
  const ext = blockedAccounts(byExt);
  return ext.length + alreadyBlockedOnly(ext, onAccount).length;
}

/** Comptes déjà bloqués sur le compte qui ne figurent PAS dans les blocages de l'extension. */
export function alreadyBlockedOnly(
  byExt: readonly BlockedRecord[] | null | undefined,
  onAccount: readonly BlockedRecord[] | null | undefined,
): BlockedRecord[] {
  const seen = new Set<string>();
  for (const r of blockedAccounts(byExt)) for (const k of entryKeys(r)) seen.add(k);
  return sanitizeAccountBlocked(onAccount).filter((r) => !entryKeys(r).some((k) => seen.has(k)));
}

/**
 * Observations « bloqué / pas bloqué » pour les comptes de la LISTE stockée, à partir des
 * relations lues sur X. Un compte sans relation connue n'est pas observé (rien ne change).
 * L'identité retenue est celle confirmée par X (id/@ de la relation) quand elle existe.
 */
export function observationsFromRelations(
  entries: readonly ListEntry[],
  listEntries: readonly ListEntry[] | null | undefined,
  relationships: ReadonlyMap<string, Relationship>,
): BlockingObservation[] {
  const listKeys = new Set<string>();
  for (const e of listEntries ?? []) for (const k of entryKeys(e)) listKeys.add(k);
  if (!listKeys.size) return [];
  const out: BlockingObservation[] = [];
  for (const e of entries) {
    const keys = entryKeys(e);
    if (!keys.some((k) => listKeys.has(k))) continue;
    const rel = keys.map((k) => relationships.get(k)).find(Boolean);
    if (!rel) continue;
    // Couple id ↔ @ contredit par X : on ne devine pas quel compte est bloqué.
    if (e.id && rel.id && e.id !== rel.id) continue;
    if (e.id && e.handle && rel.handle && rel.handle.toLowerCase() !== e.handle.toLowerCase()) continue;
    out.push({ id: rel.id ?? e.id, handle: rel.handle ?? e.handle, blocking: rel.blocking === true });
  }
  return out;
}
