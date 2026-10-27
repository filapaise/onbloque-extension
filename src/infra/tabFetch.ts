/**
 * Fetch depuis le contexte d'un onglet x.com en world ISOLATED
 * (fetch propre, cookies same-origin inclus, hors MAIN world de la page).
 */

export async function findXTab(): Promise<number | null> {
  // Host permission suffit pour query par URL ; pas besoin de "tabs".
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  const active = tabs.find((t) => t.active && t.id != null);
  if (active?.id != null) return active.id;
  const any = tabs.find((t) => t.id != null);
  return any?.id ?? null;
}

/** Lit ct0 via document.cookie dans l'onglet (cookie non-HttpOnly). */
export async function readCsrfFromTab(tabId: number): Promise<string | null> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        const m = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
        return m ? decodeURIComponent(m[1]!) : null;
      },
    });
    return injected[0]?.result ?? null;
  } catch {
    return null;
  }
}

export async function collectPageScriptUrls(tabId: number): Promise<string[]> {
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () =>
        Array.from(document.querySelectorAll('script[src]'))
          .map((s) => (s as HTMLScriptElement).src)
          .filter(Boolean),
    });
    return injected[0]?.result ?? [];
  } catch {
    return [];
  }
}

export async function fetchViaTab(
  tabId: number,
  url: string,
  init: RequestInit & { headers?: Record<string, string>; credentials?: RequestCredentials } = {},
): Promise<{ ok: boolean; status: number; body: string }> {
  const credentials = init.credentials ?? 'include';
  const injected = await chrome.scripting.executeScript({
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
        const res = await fetch(u, {
          method,
          headers,
          credentials: creds,
          body: body ?? undefined,
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, body: text };
      } catch (e) {
        return { ok: false, status: 0, body: String(e) };
      }
    },
    args: [
      url,
      init.method ?? 'GET',
      (init.headers as Record<string, string>) ?? {},
      (init.body as string) ?? null,
      credentials,
    ],
  });
  return injected[0]?.result ?? { ok: false, status: 0, body: 'no result' };
}

export function makeTabFetch(tabId: number): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    const r = await fetchViaTab(tabId, url, {
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body as string | undefined,
      credentials: (init.credentials as RequestCredentials) ?? 'include',
    });
    return new Response(r.body, { status: r.status, statusText: String(r.status) });
  };
}

export async function requireXTab(): Promise<number> {
  const id = await findXTab();
  if (id == null) {
    throw new Error('Ouvrez un onglet x.com connecté pour effectuer les blocages.');
  }
  return id;
}
