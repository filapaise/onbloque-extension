import type { BlockedRecord } from './types.ts';
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
