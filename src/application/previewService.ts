import { buildPreview, countByStatus } from '../domain/preview.ts';
import { entryKeys } from '../domain/handle.ts';
import { describeError } from '../domain/errors.ts';
import type { ListEntry, PreviewRow } from '../domain/types.ts';
import type { PreviewSnapshot } from '../shared/messages.ts';
import { loadStore } from '../infra/storage.ts';
import { lookupRelationships } from '../infra/xRelations.ts';
import type { SelfAccount } from '../infra/xClient.ts';
import { getSelf, openXSession } from './session.ts';
import { idCacheFromRelations, saveIdCache } from '../infra/idCache.ts';

/**
 * Aperçu : identité + relations obligatoires. Au moindre doute → aucun compte
 * coché et la raison exacte est renvoyée (fail-closed).
 */
export async function buildPreviewSnapshot(
  entries?: ListEntry[],
  excludeFollowingByDefault = true,
  opts: { precheckNone?: boolean; newlyAddedKeys?: string[] } = {},
): Promise<PreviewSnapshot> {
  const store = await loadStore();
  const listEntries = entries ?? store.list?.entries ?? [];
  let self: SelfAccount | null = null;
  let relations;
  try {
    const session = await openXSession();
    self = await getSelf(session);
    relations = await lookupRelationships(session.ctx, listEntries, self, { withFollowers: true, verifyIds: true });
  } catch (e) {
    return {
      rows: [],
      counts: { selected: 0 },
      self,
      sessionOk: !!self,
      abortReason: `Aperçu annulé : ${describeError(e)}`,
      relationsOk: false,
      notes: [],
    };
  }

  const already = new Set(store.alreadyBlockedKeys);
  for (const b of store.blockedByExt) {
    for (const k of entryKeys(b)) already.add(k);
  }

  // Alimente le cache @ → id : la file n'aura pas à re-résoudre ces comptes.
  if (relations.source === 'friendships') {
    try {
      await saveIdCache(idCacheFromRelations(listEntries, relations.map));
    } catch {
      /* cache facultatif */
    }
  }

  const rows: PreviewRow[] = buildPreview({
    entries: listEntries,
    whitelist: store.whitelist,
    self,
    relationships: relations.map,
    alreadyBlocked: already,
    excludeFollowingByDefault,
    relationsIncomplete: false,
    absentMeansNotFound: relations.source === 'friendships',
    precheckNone: !!opts.precheckNone,
    newlyAddedKeys: opts.newlyAddedKeys ? new Set(opts.newlyAddedKeys) : undefined,
  });

  return {
    rows,
    counts: countByStatus(rows),
    self,
    sessionOk: true,
    abortReason: null,
    relationsOk: true,
    notes: relations.notes,
  };
}
