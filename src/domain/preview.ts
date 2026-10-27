import type { ListEntry, PreviewRow, PreviewStatus, Relationship } from './types.ts';
import { entryKey, entryKeys } from './handle.ts';

export interface PreviewInput {
  entries: ListEntry[];
  whitelist: Array<{ id?: string; handle?: string }>;
  self?: { id?: string; handle?: string } | null;
  relationships?: Map<string, Relationship>;
  alreadyBlocked?: Set<string>;
  defaultChecked?: Set<string> | null;
  excludeFollowingByDefault?: boolean;
  /** Si true, les lignes sans relation connue restent décochées. */
  relationsIncomplete?: boolean;
  /** Ne rien précocher (mode page). */
  precheckNone?: boolean;
  /** Handles/ids nouvellement ajoutés à la liste → décochés. */
  newlyAddedKeys?: Set<string>;
}

export function buildPreview(input: PreviewInput): PreviewRow[] {
  const wl = new Set<string>();
  for (const w of input.whitelist) for (const k of entryKeys(w)) wl.add(k);
  const selfKeys = new Set(entryKeys(input.self ?? {}));
  const excludeFollowing = input.excludeFollowingByDefault !== false;
  const precheckNone = !!input.precheckNone;

  const rows: PreviewRow[] = [];
  for (const e of input.entries) {
    const key = entryKey(e);
    if (!key) continue;
    const keys = entryKeys(e);
    const relById = e.id ? input.relationships?.get(`id:${e.id}`) : undefined;
    const relByHandle = e.handle ? input.relationships?.get(`h:${e.handle.toLowerCase()}`) : undefined;
    const rel = relById ?? relByHandle ?? keys.map((k) => input.relationships?.get(k)).find(Boolean);

    const warnings: string[] = [];
    let status: PreviewStatus = 'to-block';

    // Mismatch id/handle : X dit autre chose que la liste
    if (e.id && e.handle && relById?.handle && relById.handle.toLowerCase() !== e.handle.toLowerCase()) {
      status = 'mismatch';
      warnings.push(`Liste : @${e.handle} · X : @${relById.handle}`);
    } else if (e.id && relById?.handle && e.handle && relById.handle.toLowerCase() !== e.handle.toLowerCase()) {
      status = 'mismatch';
      warnings.push(`Incohérence id/handle`);
    } else if (keys.some((k) => selfKeys.has(k)) || (rel && selfKeys.has(`id:${rel.id}`))) {
      status = 'self';
    } else if (keys.some((k) => wl.has(k)) || (rel?.id && wl.has(`id:${rel.id}`)) || (rel?.handle && wl.has(`h:${rel.handle.toLowerCase()}`))) {
      status = 'whitelisted';
    } else if (rel?.blocking || keys.some((k) => input.alreadyBlocked?.has(k))) {
      status = 'already-blocked';
    } else if (input.relationsIncomplete && !rel) {
      status = 'relation-unknown';
      warnings.push('Relation inconnue — non coché');
    } else if (rel?.following) {
      status = 'following';
      warnings.push('Vous suivez ce compte');
    } else if (rel?.followedBy) {
      status = 'followed-by';
      warnings.push('Ce compte vous suit');
    }

    const resolvedHandle = rel?.handle ?? e.handle;
    const resolvedId = rel?.id ?? e.id;

    let checked = false;
    if (!precheckNone && status === 'to-block') checked = true;
    if (status === 'following' || status === 'followed-by') checked = !excludeFollowing && !precheckNone;
    if (status === 'mismatch' || status === 'relation-unknown' || status === 'self' || status === 'whitelisted' || status === 'already-blocked') {
      checked = false;
    }
    if (input.newlyAddedKeys?.has(key)) checked = false;
    if (input.defaultChecked) {
      checked = input.defaultChecked.has(key) && status === 'to-block';
    }

    rows.push({
      key,
      handle: resolvedHandle,
      id: resolvedId,
      name: e.name ?? rel?.name,
      category: e.category,
      source: e.source,
      status,
      warnings,
      checked,
    });
  }
  return rows;
}

export function countByStatus(rows: PreviewRow[]): Record<string, number> {
  const counts: Record<string, number> = {
    'to-block': 0,
    'already-blocked': 0,
    whitelisted: 0,
    self: 0,
    following: 0,
    'followed-by': 0,
    'not-found': 0,
    mismatch: 0,
    'relation-unknown': 0,
    selected: 0,
  };
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.checked && (r.status === 'to-block' || r.status === 'following' || r.status === 'followed-by')) {
      counts.selected!++;
    }
  }
  return counts;
}

const SELECTABLE: ReadonlySet<string> = new Set(['to-block', 'following', 'followed-by', 'not-found', 'relation-unknown']);

export interface LiveCounts {
  /** Toutes les lignes cochées (et cochables). */
  selected: number;
  /** Lignes au statut « à bloquer » actuellement cochées. */
  toBlockChecked: number;
  /** Total des lignes au statut « à bloquer ». */
  toBlockTotal: number;
}

/**
 * Compteurs recalculés à partir de l'état réel des cases (UI), pas de l'état
 * initial renvoyé par le service worker.
 */
export function liveCounts(rows: PreviewRow[], checkedKeys: ReadonlySet<string>): LiveCounts {
  let selected = 0;
  let toBlockChecked = 0;
  let toBlockTotal = 0;
  for (const r of rows) {
    const isChecked = checkedKeys.has(r.key) && SELECTABLE.has(r.status);
    if (r.status === 'to-block') {
      toBlockTotal++;
      if (isChecked) toBlockChecked++;
    }
    if (isChecked) selected++;
  }
  return { selected, toBlockChecked, toBlockTotal };
}
