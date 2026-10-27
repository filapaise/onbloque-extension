import type { ListEntry } from './types.ts';
import { entryKey } from './handle.ts';

export interface ListDiff {
  added: ListEntry[];
  removed: ListEntry[];
  addedKeys: string[];
  removedKeys: string[];
}

export function diffLists(prev: ListEntry[], next: ListEntry[]): ListDiff {
  const prevMap = new Map(prev.map((e) => [entryKey(e), e]));
  const nextMap = new Map(next.map((e) => [entryKey(e), e]));
  const added: ListEntry[] = [];
  const removed: ListEntry[] = [];
  for (const [k, e] of nextMap) {
    if (!k) continue;
    if (!prevMap.has(k)) added.push(e);
  }
  for (const [k, e] of prevMap) {
    if (!k) continue;
    if (!nextMap.has(k)) removed.push(e);
  }
  return {
    added,
    removed,
    addedKeys: added.map((e) => entryKey(e)).filter(Boolean),
    removedKeys: removed.map((e) => entryKey(e)).filter(Boolean),
  };
}
