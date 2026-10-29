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
import type { DiagEntry } from '../infra/diagnostics.ts';
import type { FabProgress } from '../domain/progress.ts';

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
  | { type: 'GET_DIAGNOSTICS' }
  | { type: 'CLEAR_DIAGNOSTICS' }
  | { type: 'RESET_HISTORY' }
  | { type: 'OPEN_PREVIEW'; mode: 'list'; sourceLabel?: string }
  | { type: 'OPEN_PREVIEW'; mode?: 'entries'; entries: ListEntry[]; sourceLabel?: string; precheckNone?: boolean }
  | { type: 'PREVIEW_DIFF_CONFIRM'; list: BlockList; source: 'url' | 'seed'; addedKeys: string[] }
  | { type: 'GET_PROGRESS' }
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
  /** Avertissements non bloquants (mode de secours, liste d'abonnés partielle…). */
  notes: string[];
}

export type MsgResponse =
  | { ok: true; status: StatusSnapshot }
  | { ok: true; settings: Settings }
  | { ok: true; list: BlockList | null; source: string | null; fetchedAt: number | null; warnings?: string[] }
  | { ok: true; whitelist: ListEntry[] }
  | { ok: true; preview: PreviewSnapshot }
  | { ok: true; logs: LogEntry[] }
  | { ok: true; diagnostics: DiagEntry[] }
  | { ok: true; added: number; queueLength: number }
  | { ok: true; pong: true }
  | { ok: true; progress: FabProgress }
  | { ok: false; error: string };

/**
 * Code d'erreur renvoyé quand ce script appartient à une ancienne instance de l'extension
 * (extension rechargée, mise à jour ou réinstallée alors que l'onglet restait ouvert) :
 * `chrome.runtime` est alors indéfini ou inutilisable.
 */
export const CONTEXT_INVALIDATED = 'EXTENSION_CONTEXT_INVALIDATED';

type RuntimeLike = {
  id?: string;
  lastError?: { message?: string };
  sendMessage?: (msg: unknown, cb: (resp: unknown) => void) => void;
};

function runtimeApi(): RuntimeLike | undefined {
  try {
    return (globalThis as unknown as { chrome?: { runtime?: RuntimeLike } }).chrome?.runtime;
  } catch {
    return undefined;
  }
}

/** Faux quand le script est orphelin (l'extension a été rechargée / mise à jour). */
export function extensionContextAlive(): boolean {
  try {
    return !!runtimeApi()?.id;
  } catch {
    return false;
  }
}

/** Reconnaît les erreurs typiques d'un contexte d'extension invalidé. */
export function isContextInvalidatedError(error: unknown): boolean {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  if (!text) return false;
  return (
    text === CONTEXT_INVALIDATED ||
    /context invalidated/i.test(text) ||
    /reading '(sendMessage|onMessage|id|lastError|getURL)'/.test(text)
  );
}

export function sendMessage<T extends MsgResponse = MsgResponse>(msg: Msg): Promise<T> {
  return new Promise((resolve) => {
    const invalidated = () => resolve({ ok: false, error: CONTEXT_INVALIDATED } as T);
    const runtime = runtimeApi();
    if (!runtime?.id || typeof runtime.sendMessage !== 'function') {
      invalidated();
      return;
    }
    try {
      runtime.sendMessage(msg, (resp) => {
        const rt = runtimeApi();
        const lastError = rt?.lastError;
        if (lastError) {
          const message = lastError.message ?? 'Erreur de messaging';
          if (isContextInvalidatedError(message)) invalidated();
          else resolve({ ok: false, error: message } as T);
          return;
        }
        resolve((resp ?? { ok: false, error: 'Pas de réponse' }) as T);
      });
    } catch (e) {
      if (isContextInvalidatedError(e) || !extensionContextAlive()) invalidated();
      else resolve({ ok: false, error: (e as Error).message } as T);
    }
  });
}
