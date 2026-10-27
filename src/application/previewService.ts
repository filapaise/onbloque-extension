import { buildPreview, countByStatus } from '../domain/preview.ts';
import { entryKeys } from '../domain/handle.ts';
import type { ListEntry, PreviewRow } from '../domain/types.ts';
import type { PreviewSnapshot } from '../shared/messages.ts';
import { loadStore } from '../infra/storage.ts';
import { friendshipsLookup, verifyCredentials, type FetchFn } from '../infra/xClient.ts';
import { makeTabFetch, readCsrfFromTab, requireXTab } from '../infra/tabFetch.ts';

async function resolveTabFetch(): Promise<{ fetchFn: FetchFn; csrf: string; tabId: number }> {
  const tabId = await requireXTab();
  const csrf = await readCsrfFromTab(tabId);
  if (!csrf) {
    throw new Error(
      'Session x.com introuvable (cookie CSRF ct0). Ouvrez x.com, reconnectez-vous, puis réessayez.',
    );
  }
  return { fetchFn: makeTabFetch(tabId), csrf, tabId };
}

export async function buildPreviewSnapshot(
  entries?: ListEntry[],
  excludeFollowingByDefault = true,
  opts: { precheckNone?: boolean; newlyAddedKeys?: string[] } = {},
): Promise<PreviewSnapshot> {
  const store = await loadStore();
  const listEntries = entries ?? store.list?.entries ?? [];
  let self: { id?: string; handle?: string } | null = null;
  let relationships = new Map();
  let sessionOk = false;
  let relationsOk = false;
  let abortReason: string | null = null;

  try {
    const { fetchFn, csrf, tabId } = await resolveTabFetch();
    const { collectPageScriptUrls } = await import('../infra/tabFetch.ts');
    const scriptUrls = await collectPageScriptUrls(tabId);
    self = await verifyCredentials(fetchFn, csrf, { tabId, scriptUrls });
    sessionOk = !!self;
    if (!self) {
      abortReason =
        'Impossible de déterminer votre compte X (twid / settings / Viewer). Rouvrez un onglet x.com connecté puis réessayez.';
    } else {
      try {
        relationships = await friendshipsLookup(fetchFn, csrf, listEntries);
        relationsOk = true;
      } catch (lookupErr) {
        // Fail closed on relationship lookup (H3) — but message clearer
        abortReason =
          'Impossible de vérifier les comptes que vous suivez (friendships/lookup). Aperçu annulé pour éviter de bloquer un compte suivi. Réessayez dans un moment.';
        relationsOk = false;
        throw lookupErr;
      }
    }
  } catch (e) {
    if (!abortReason) {
      abortReason =
        (e as Error).message ||
        'Impossible de vérifier les relations (suivis / vous). Aperçu annulé pour votre sécurité.';
    }
    sessionOk = false;
    relationsOk = false;
  }

  if (abortReason || !relationsOk || !self) {
    return {
      rows: [],
      counts: { selected: 0 },
      self,
      sessionOk,
      abortReason: abortReason ?? 'Relations indisponibles — aperçu annulé (garde-fou).',
      relationsOk: false,
    };
  }

  const already = new Set(store.alreadyBlockedKeys);
  for (const b of store.blockedByExt) {
    for (const k of entryKeys(b)) already.add(k);
  }

  const rows: PreviewRow[] = buildPreview({
    entries: listEntries,
    whitelist: store.whitelist,
    self,
    relationships,
    alreadyBlocked: already,
    excludeFollowingByDefault,
    relationsIncomplete: false,
    precheckNone: !!opts.precheckNone,
    newlyAddedKeys: opts.newlyAddedKeys ? new Set(opts.newlyAddedKeys) : undefined,
  });

  return {
    rows,
    counts: countByStatus(rows),
    self,
    sessionOk,
    abortReason: null,
    relationsOk: true,
  };
}
