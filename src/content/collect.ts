import { HANDLE_RE, RESERVED_PATHS, handleFromHref } from '../domain/handle.ts';
import type { ListEntry } from '../domain/types.ts';

/**
 * Collecte stricte : auteurs dans la colonne principale + cellules UserCell / profil.
 * Pas de scan @mention / innerHTML.
 */
export function collectHandlesFromPage(doc: Document = document): ListEntry[] {
  const byKey = new Map<string, ListEntry>();

  const add = (partial: { handle?: string; id?: string; source?: string }) => {
    let handle = partial.handle?.replace(/^@/, '');
    if (handle) {
      if (!HANDLE_RE.test(handle) || RESERVED_PATHS.has(handle.toLowerCase())) handle = undefined;
    }
    const id = partial.id && /^\d{1,20}$/.test(partial.id) ? partial.id : undefined;
    if (!handle && !id) return;
    const key = id ? `id:${id}` : `h:${handle!.toLowerCase()}`;
    const prev = byKey.get(key) ?? {};
    byKey.set(key, {
      handle: prev.handle ?? handle,
      id: prev.id ?? id,
      source: prev.source ?? partial.source,
    });
  };

  const root =
    doc.querySelector('[data-testid="primaryColumn"]') ??
    doc.querySelector('main[role="main"]') ??
    doc.body;

  // Profil courant
  const path = location.pathname.replace(/\/$/, '');
  const pathMatch = path.match(/^\/([A-Za-z0-9_]{1,15})(?:\/|$)/);
  if (pathMatch?.[1] && !RESERVED_PATHS.has(pathMatch[1].toLowerCase())) {
    add({ handle: pathMatch[1], source: 'profile' });
  }

  // UserCell (listes followers / following / search people)
  for (const cell of root.querySelectorAll('[data-testid="UserCell"]')) {
    const avatar = cell.querySelector('[data-testid^="UserAvatar-Container-"]');
    const testid = avatar?.getAttribute('data-testid') || '';
    const idm = testid.match(/^UserAvatar-Container-(\d{1,20})$/);
    const link = cell.querySelector('a[href^="/"]');
    const handle = handleFromHref(link?.getAttribute('href') || undefined) ?? undefined;
    add({ handle, id: idm?.[1], source: 'user-cell' });
  }

  // Auteurs de posts dans la colonne principale
  for (const article of root.querySelectorAll('article[data-testid="tweet"]')) {
    const nameBox = article.querySelector('[data-testid="User-Name"]');
    const link = nameBox?.querySelector('a[href^="/"]');
    const handle = handleFromHref(link?.getAttribute('href') || undefined) ?? undefined;
    const avatar = article.querySelector('[data-testid^="UserAvatar-Container-"]');
    const testid = avatar?.getAttribute('data-testid') || '';
    const idm = testid.match(/^UserAvatar-Container-(\d{1,20})$/);
    // Ne lier id+handle que s'ils viennent du même article
    add({ handle, id: idm?.[1], source: 'author' });
  }

  // En-tête de profil
  const header = root.querySelector('[data-testid="UserName"]');
  if (header) {
    const link = header.querySelector('a[href^="/"]') ?? header.closest('a');
    const handle = handleFromHref(link?.getAttribute('href') || undefined) ?? undefined;
    const avatar = root.querySelector('[data-testid^="UserAvatar-Container-"]');
    const testid = avatar?.getAttribute('data-testid') || '';
    const idm = testid.match(/^UserAvatar-Container-(\d{1,20})$/);
    add({ handle, id: idm?.[1], source: 'profile-header' });
  }

  return [...byKey.values()];
}
