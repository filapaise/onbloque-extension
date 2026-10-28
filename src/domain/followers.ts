/**
 * 1.3.0 — seuil d'abonnés : « Ne bloquer que les comptes avec au moins N abonnés ».
 * Logique pure (aucune dépendance à Chrome ni au réseau).
 *
 * 0 = désactivé (comportement historique : toute la liste est bloquée).
 */

export const FOLLOWER_PRESETS = [1_000, 10_000, 50_000, 100_000] as const;
/** Borne haute d'un seuil personnalisé (au-delà, plus aucun compte ne serait bloqué). */
export const MAX_MIN_FOLLOWERS = 100_000_000;

/** Valeur de réglage valide (entier 0…MAX) ou null si inexploitable. */
export function sanitizeMinFollowers(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  return Math.min(MAX_MIN_FOLLOWERS, Math.floor(v));
}

/**
 * Saisie libre → nombre : « 10000 », « 10 000 », « 10.000 », « 10k », « 1,5k », « 2M ».
 * NaN si illisible.
 */
export function parseFollowerInput(raw: string): number {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u00a0\u202f]/g, '');
  if (!s) return NaN;
  const m = /^(\d+(?:[.,]\d+)?)(k|m)?$/.exec(s);
  if (!m) {
    // Séparateurs de milliers « 10.000 » / « 10,000 ».
    if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
    return NaN;
  }
  const [, num, unit] = m;
  // « 10.000 » sans unité = séparateur de milliers, pas une décimale.
  if (!unit && /^\d{1,3}[.,]\d{3}$/.test(num!)) return Number(num!.replace(/[.,]/g, ''));
  const n = Number(num!.replace(',', '.'));
  const mult = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

/** 10000 → « 10 000 » (espace fine insécable, comme fr-FR). */
export function fmtFollowers(n: number): string {
  return new Intl.NumberFormat('fr-FR').format(Math.max(0, Math.floor(n))).replace(/\u202f|\u00a0/g, '\u202f');
}

/** true : le compte est sous le seuil → on ne le bloque pas. Seuil 0 → jamais. */
export function isBelowThreshold(followers: number, minFollowers: number): boolean {
  return minFollowers > 0 && followers < minFollowers;
}

export function isPresetThreshold(n: number): boolean {
  return (FOLLOWER_PRESETS as readonly number[]).includes(n);
}

/** Phrase d'état du réglage (page Réglages, aperçu). */
export function describeThreshold(minFollowers: number): string {
  if (!minFollowers) return 'Désactivé : toute la liste est bloquée.';
  return `Seuls les comptes à partir de ${fmtFollowers(minFollowers)} abonnés sont bloqués. Les plus petits sont passés et comptés à part.`;
}

/** Message du journal pour un compte passé. */
export function smallAccountMessage(followers: number, minFollowers: number): string {
  return `Petit compte (${fmtFollowers(followers)} abonnés < ${fmtFollowers(minFollowers)}) : pas bloqué`;
}
