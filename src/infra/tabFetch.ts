/**
 * Fetch depuis le contexte d'un onglet x.com en world ISOLATED
 * (fetch propre, cookies same-origin inclus, hors MAIN world de la page).
 */

import { XApiError, sanitizeErrorBody } from '../domain/errors.ts';

export async function findXTab(): Promise<number | null> {
  // Host permission suffit pour query par URL ; pas besoin de "tabs".
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const active = tabs.find((t) => t.active && t.id != null);
  if (active?.id != null) return active.id;
  const any = tabs.find((t) => t.id != null);
  return any?.id ?? null;
}

export async function requireXTab(): Promise<number> {
  const id = await findXTab();
  if (id == null) throw new XApiError('no-tab', 0, 'no-tab');
  return id;
}

async function waitTabComplete(tabId: number, timeoutMs = 25_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete' && !t.discarded) return true;
    } catch {
      return false; // onglet fermé
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/**
 * Onglet x.com utilisable par la file d'attente (tâche de fond) :
 *  - un onglet x.com existant (actif d'abord) ; s'il a été déchargé par Chrome
 *    (économiseur de mémoire), il est rechargé ;
 *  - sinon, un onglet x.com est ouvert en arrière-plan (non actif).
 * Échec → `no-tab` (message précis).
 */
export async function ensureXTab(): Promise<{ tabId: number; opened: boolean; reloaded: boolean }> {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const usable = tabs.filter((t) => t.id != null);
  const pick = usable.find((t) => t.active && !t.discarded) ?? usable.find((t) => !t.discarded) ?? usable[0];
  if (pick?.id != null) {
    const wasDiscarded = !!pick.discarded;
    if (wasDiscarded || pick.status !== 'complete') {
      if (wasDiscarded) await chrome.tabs.reload(pick.id).catch(() => undefined);
      const ok = await waitTabComplete(pick.id);
      if (!ok) throw new XApiError('onglet x.com déchargé', 0, 'no-tab');
      return { tabId: pick.id, opened: false, reloaded: wasDiscarded };
    }
    return { tabId: pick.id, opened: false, reloaded: false };
  }
  let created: chrome.tabs.Tab;
  try {
    created = await chrome.tabs.create({ url: 'https://x.com/home', active: false });
  } catch {
    throw new XApiError('ouverture onglet impossible', 0, 'no-tab');
  }
  if (created.id == null || !(await waitTabComplete(created.id))) {
    throw new XApiError('onglet x.com non chargé', 0, 'no-tab');
  }
  return { tabId: created.id, opened: true, reloaded: false };
}

export interface SessionHints {
  /** Cookie ct0 (CSRF, non HttpOnly). */
  csrf: string | null;
  /** Valeur brute du cookie twid si lisible (« u%3D<id> »). */
  twid: string | null;
  /** href du lien « Profil » de la barre latérale (« /<handle> »). */
  profileHref: string | null;
}

/** Lit ct0, twid et le lien de profil dans l'onglet. Rien n'est stocké. */
export async function readSessionHints(tabId: number): Promise<SessionHints> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const cookie = (name: string) => {
          for (const part of document.cookie.split(';')) {
            const i = part.indexOf('=');
            if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
          }
          return null;
        };
        const ct0 = cookie('ct0');
        const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
        return {
          csrf: ct0 ? decodeURIComponent(ct0) : null,
          twid: cookie('twid'),
          profileHref: link?.getAttribute('href') ?? null,
        };
      },
    });
    return injected[0]?.result ?? { csrf: null, twid: null, profileHref: null };
  } catch {
    return { csrf: null, twid: null, profileHref: null };
  }
}

/** Bundles JS déjà chargés par la page (balises + chunks chargés à la demande). */
export async function collectPageScriptUrls(tabId: number): Promise<string[]> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const tags = Array.from(document.querySelectorAll('script[src]')).map(
          (s) => (s as HTMLScriptElement).src,
        );
        const loaded = performance
          .getEntriesByType('resource')
          .map((r) => r.name)
          .filter((n) => n.endsWith('.js'));
        return [...tags, ...loaded].filter(Boolean);
      },
    });
    return injected[0]?.result ?? [];
  } catch {
    return [];
  }
}

/**
 * 1.3.2 — Seules ces destinations peuvent être appelées depuis l'onglet x.com
 * (cookies de session inclus) : l'API web de X et les bundles JS de X.
 * Toute autre URL est refusée avant même d'injecter quoi que ce soit dans l'onglet.
 */
export function isAllowedTabFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false;
  if (u.hostname === 'x.com') return u.pathname.startsWith('/i/api/');
  return u.hostname === 'abs.twimg.com';
}

export const TAB_FETCH_REFUSED = 'Requête refusée : URL non autorisée pour l’onglet x.com.';

async function fetchViaTab(
  tabId: number,
  url: string,
  init: { method: string; headers: Record<string, string>; body: string | null; credentials: RequestCredentials },
): Promise<{ status: number; body: string; rl?: { reset: string | null; remaining: string | null } }> {
  if (!isAllowedTabFetchUrl(url)) throw new Error(TAB_FETCH_REFUSED);
  let injected;
  try {
    injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: async (
        u: string,
        method: string,
        headers: Record<string, string>,
        body: string | null,
        creds: RequestCredentials,
      ) => {
        try {
          const res = await fetch(u, { method, headers, credentials: creds, body: body ?? undefined });
          // Seuls les en-têtes de limite de débit sont remontés (aucun cookie / jeton).
          const rl = {
            reset: res.headers.get('x-rate-limit-reset'),
            remaining: res.headers.get('x-rate-limit-remaining'),
          };
          return { status: res.status, body: await res.text(), rl };
        } catch (e) {
          return { status: 0, body: String(e) };
        }
      },
      args: [url, init.method, init.headers, init.body, init.credentials],
    });
  } catch (e) {
    // Onglet fermé, rechargé ou déconnecté pendant la requête.
    throw new XApiError('onglet x.com indisponible', 0, 'no-tab', sanitizeErrorBody(String(e)));
  }
  const r = injected[0]?.result;
  if (!r) throw new XApiError('onglet x.com indisponible', 0, 'no-tab');
  return r;
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

export function makeTabFetch(tabId: number): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    if (!isAllowedTabFetchUrl(url)) throw new Error(TAB_FETCH_REFUSED);
    const r = await fetchViaTab(tabId, url, {
      method: init.method ?? 'GET',
      headers: (init.headers as Record<string, string>) ?? {},
      body: typeof init.body === 'string' ? init.body : null,
      credentials: init.credentials ?? 'include',
    });
    // `new Response` refuse le statut 0 (erreur réseau) : on le traduit nous-mêmes.
    if (r.status < 200 || r.status > 599) {
      throw new XApiError('réseau', 0, 'network', sanitizeErrorBody(r.body));
    }
    const headers: Record<string, string> = {};
    if (r.rl?.reset && /^\d{1,12}$/.test(r.rl.reset)) headers['x-rate-limit-reset'] = r.rl.reset;
    if (r.rl?.remaining && /^\d{1,9}$/.test(r.rl.remaining)) headers['x-rate-limit-remaining'] = r.rl.remaining;
    return new Response(NULL_BODY_STATUS.has(r.status) ? null : r.body, { status: r.status, headers });
  };
}
