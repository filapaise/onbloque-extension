import type {
  BlockedRecord,
  BlockList,
  ListEntry,
  LogEntry,
  QueueItem,
  RunState,
  Settings,
} from '../domain/types.ts';
import { DEFAULT_SETTINGS, MAX_DAILY_CAP } from '../domain/types.ts';
import { applyPace, nearestPace } from '../domain/presets.ts';
import { initialRunState } from '../domain/queue.ts';

export interface StoreShape {
  settings: Settings;
  list: BlockList | null;
  listSource: string | null;
  listFetchedAt: number | null;
  whitelist: ListEntry[];
  queue: QueueItem[];
  run: RunState;
  blockedByExt: BlockedRecord[];
  logs: LogEntry[];
  alreadyBlockedKeys: string[];
}

const KEYS = [
  'settings',
  'list',
  'listSource',
  'listFetchedAt',
  'whitelist',
  'queue',
  'run',
  'blockedByExt',
  'logs',
  'alreadyBlockedKeys',
] as const;

export async function loadStore(): Promise<StoreShape> {
  const raw = (await chrome.storage.local.get([...KEYS])) as Partial<StoreShape>;
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) });
  return {
    settings,
    list: raw.list ?? null,
    listSource: raw.listSource ?? null,
    listFetchedAt: raw.listFetchedAt ?? null,
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [],
    queue: Array.isArray(raw.queue) ? raw.queue : [],
    run: { ...initialRunState(), ...(raw.run ?? {}) },
    blockedByExt: Array.isArray(raw.blockedByExt) ? raw.blockedByExt : [],
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    alreadyBlockedKeys: Array.isArray(raw.alreadyBlockedKeys) ? raw.alreadyBlockedKeys : [],
  };
}

/** Normalise + migre vers le preset le plus proche si `pace` absent. */
export function normalizeSettings(s: Partial<Settings>): Settings {
  const pace = nearestPace(s);
  const withPace = applyPace(
    {
      ...DEFAULT_SETTINGS,
      listUrl: typeof s.listUrl === 'string' ? s.listUrl.trim() : '',
    },
    pace,
  );
  // Si l'utilisateur avait déjà ce preset, applyPace a écrasé cap/délais — c'est voulu.
  // listUrl conservé ; transport forcé tab ; autoRefresh éteint (plus dans l'UI).
  return {
    ...withPace,
    listUrl: typeof s.listUrl === 'string' ? s.listUrl.trim() : withPace.listUrl,
    autoRefresh: false,
    transport: 'tab',
    dailyCap: Math.min(MAX_DAILY_CAP, withPace.dailyCap),
  };
}

export async function savePartial(patch: Partial<StoreShape>): Promise<void> {
  await chrome.storage.local.set(patch);
}

export async function appendLog(entry: LogEntry): Promise<void> {
  const { logs = [] } = (await chrome.storage.local.get('logs')) as { logs?: LogEntry[] };
  const next = [entry, ...logs].slice(0, 300);
  await chrome.storage.local.set({ logs: next });
}

export async function pushBlocked(record: BlockedRecord, keys: string[]): Promise<void> {
  const data = (await chrome.storage.local.get(['blockedByExt', 'alreadyBlockedKeys'])) as {
    blockedByExt?: BlockedRecord[];
    alreadyBlockedKeys?: string[];
  };
  const blocked = [record, ...(data.blockedByExt ?? [])].slice(0, 10_000);
  const set = new Set(data.alreadyBlockedKeys ?? []);
  for (const k of keys) set.add(k);
  await chrome.storage.local.set({
    blockedByExt: blocked,
    alreadyBlockedKeys: [...set],
  });
}
