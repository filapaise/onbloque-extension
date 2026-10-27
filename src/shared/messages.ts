import type {
  BlockedRecord,
  BlockList,
  ListEntry,
  LogEntry,
  PreviewRow,
  QueueItem,
  RunState,
  Settings,
} from '../domain/types.ts';

export type Msg =
  | { type: 'GET_STATUS' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; settings: Partial<Settings> }
  | { type: 'GET_LIST' }
  | { type: 'SET_LIST'; list: BlockList; source: 'seed' | 'url' | 'import' | 'paste' }
  | { type: 'REFRESH_LIST' }
  | { type: 'GET_WHITELIST' }
  | { type: 'SET_WHITELIST'; whitelist: ListEntry[] }
  | { type: 'ADD_WHITELIST'; entries: ListEntry[] }
  | { type: 'REMOVE_WHITELIST'; keys: string[] }
  | { type: 'BUILD_PREVIEW'; entries?: ListEntry[]; excludeFollowingByDefault?: boolean; precheckNone?: boolean; newlyAddedKeys?: string[] }
  | { type: 'START_QUEUE'; items: Array<{ handle?: string; id?: string }>; action?: 'block' | 'unblock' }
  | { type: 'PAUSE_QUEUE' }
  | { type: 'RESUME_QUEUE' }
  | { type: 'CLEAR_QUEUE' }
  | { type: 'UNDO_EXTENSION_BLOCKS' }
  | { type: 'GET_LOGS' }
  | { type: 'CLEAR_LOGS' }
  | { type: 'RESET_HISTORY' }
  | { type: 'CONTENT_COLLECT_PAGE' }
  | { type: 'OPEN_PREVIEW'; entries: ListEntry[]; sourceLabel?: string; precheckNone?: boolean; mode?: 'list' | 'entries' }
  | { type: 'PREVIEW_DIFF_CONFIRM'; list: BlockList; source: 'url' | 'seed'; addedKeys: string[] }
  | { type: 'GET_SELF_CACHED' }
  | { type: 'PING' };

export interface StatusSnapshot {
  settings: Settings;
  list: BlockList | null;
  listSource: string | null;
  listFetchedAt: number | null;
  whitelist: ListEntry[];
  queue: QueueItem[];
  run: RunState;
  blockedByExt: BlockedRecord[];
  sessionOk: boolean;
  self: { id?: string; handle?: string } | null;
}

export interface PreviewSnapshot {
  rows: PreviewRow[];
  counts: Record<string, number>;
  self: { id?: string; handle?: string } | null;
  sessionOk: boolean;
  abortReason?: string | null;
  relationsOk?: boolean;
}

export type MsgResponse =
  | { ok: true; status: StatusSnapshot }
  | { ok: true; settings: Settings }
  | { ok: true; list: BlockList | null; source: string | null; fetchedAt: number | null; warnings?: string[] }
  | { ok: true; whitelist: ListEntry[] }
  | { ok: true; preview: PreviewSnapshot }
  | { ok: true; logs: LogEntry[] }
  | { ok: true; added: number; queueLength: number }
  | { ok: true; pong: true }
  | { ok: false; error: string };

export function sendMessage<T extends MsgResponse = MsgResponse>(msg: Msg): Promise<T> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message ?? 'Erreur de messaging' } as T);
          return;
        }
        resolve((resp ?? { ok: false, error: 'Pas de réponse' }) as T);
      });
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message } as T);
    }
  });
}
