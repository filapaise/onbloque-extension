import type { ListEntry } from './types.ts';

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const NUMERIC_ID_RE = /^\d{1,20}$/;

/** Chemins de x.com qui ne sont pas des profils. */
export const RESERVED_PATHS = new Set(
  [
    'home', 'explore', 'search', 'notifications', 'messages', 'settings', 'i', 'compose',
    'login', 'logout', 'signup', 'tos', 'privacy', 'about', 'jobs', 'communities', 'lists',
    'bookmarks', 'premium', 'premium_sign_up', 'verified-choose', 'hashtag', 'intent', 'share',
    'account', 'help', 'download', 'grok', 'spaces', 'topics', 'moments', 'twitterblue',
    'who_to_follow', 'connect_people', 'following', 'followers', 'jobs', 'creators', 'safety',
  ].map((s) => s.toLowerCase()),
);

/**
 * Normalise une saisie libre : « @nom », « nom », URL de profil x.com/twitter.com,
 * ou identifiant numérique. Retourne null si la saisie n'est pas exploitable.
 */
export function parseAccountRef(raw: string, opts: { numericIsId?: boolean } = {}): ListEntry | null {
  const numericIsId = opts.numericIsId ?? true;
  let s = raw.trim().replace(/^["']|["']$/g, '').trim();
  if (!s) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:#!\/)?@?([^/?#\s]+)/i);
  if (url) {
    const seg = url[1] ?? '';
    if (seg.toLowerCase() === 'i') {
      const idm = s.match(/\/i\/user\/(\d{1,20})/);
      return idm ? { id: idm[1] } : null;
    }
    s = seg;
  }
  s = s.replace(/^@/, '');
  if (numericIsId && NUMERIC_ID_RE.test(s)) return { id: s };
  if (!HANDLE_RE.test(s)) return null;
  if (RESERVED_PATHS.has(s.toLowerCase())) return null;
  return { handle: s };
}

/** Clé stable d'une entrée (id prioritaire). */
export function entryKey(e: { id?: string; handle?: string }): string {
  if (e.id) return `id:${e.id}`;
  if (e.handle) return `h:${e.handle.toLowerCase()}`;
  return '';
}

/** Toutes les clés sous lesquelles une entrée peut être reconnue. */
export function entryKeys(e: { id?: string; handle?: string }): string[] {
  const keys: string[] = [];
  if (e.id) keys.push(`id:${e.id}`);
  if (e.handle) keys.push(`h:${e.handle.toLowerCase()}`);
  return keys;
}

/** Extrait un @ à partir d'un href de lien de profil sur x.com (« /nom » ou URL complète). */
export function handleFromHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const m = href.match(/^(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/);
  if (!m || !m[1]) return null;
  if (RESERVED_PATHS.has(m[1].toLowerCase())) return null;
  return m[1];
}

/** Déduplique une liste d'entrées en fusionnant id/handle. */
export function dedupeEntries(entries: ListEntry[]): ListEntry[] {
  const out: ListEntry[] = [];
  const seen = new Map<string, ListEntry>();
  for (const e of entries) {
    const keys = entryKeys(e);
    if (keys.length === 0) continue;
    const existing = keys.map((k) => seen.get(k)).find(Boolean);
    if (existing) {
      if (!existing.id && e.id) existing.id = e.id;
      if (!existing.handle && e.handle) existing.handle = e.handle;
      for (const k of entryKeys(existing)) seen.set(k, existing);
      continue;
    }
    const copy = { ...e };
    out.push(copy);
    for (const k of keys) seen.set(k, copy);
  }
  return out;
}
