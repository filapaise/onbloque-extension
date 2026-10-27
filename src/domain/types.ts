/** Types du domaine : aucune dépendance à Chrome ni au réseau. */

export type PacePreset = 'prudent' | 'normal' | 'max';

export interface ListEntry {
  handle?: string;
  id?: string;
  name?: string;
  category?: string;
  source?: string;
  verified?: boolean;
}

export interface BlockList {
  format: 'onbloque-list/1';
  name: string;
  description?: string;
  source_url?: string;
  updated?: string;
  entries: ListEntry[];
}

export type QueueAction = 'block' | 'unblock';

export interface QueueItem {
  key: string;
  handle?: string;
  id?: string;
  action: QueueAction;
  addedAt: number;
  attempts: number;
}

export interface Settings {
  pace: PacePreset;
  listUrl: string;
  autoRefresh: boolean;
  dailyCap: number;
  minDelaySec: number;
  maxDelaySec: number;
  transport: 'auto' | 'tab' | 'direct';
}

export interface RunState {
  running: boolean;
  dayKey: string;
  actionsToday: number;
  backoffLevel: number;
  resumeAt: number | null;
  resumeReason: 'cap' | 'rate-limit' | 'error' | null;
  lastError: string | null;
  totalDone: number;
  totalSkipped: number;
  /** Timestamp du dernier blocage/déblocage réussi. */
  lastActionAt: number | null;
  /** Heure prévue de la prochaine action (attente volontaire entre deux blocages). */
  nextActionAt?: number | null;
  /** Dernier compte bloqué (affiché dans le popup). */
  lastBlocked?: { handle?: string; id?: string; at: number } | null;
  /** Progression du lot en cours (remis à zéro quand un lot démarre sur une file vide). */
  batchDone?: number;
  batchSkipped?: number;
}

export interface BlockedRecord {
  id?: string;
  handle?: string;
  at: number;
}

export interface LogEntry {
  at: number;
  handle?: string;
  id?: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface Relationship {
  id?: string;
  handle?: string;
  name?: string;
  following: boolean;
  followedBy: boolean;
  blocking: boolean;
}

export type PreviewStatus =
  | 'to-block'
  | 'already-blocked'
  | 'whitelisted'
  | 'self'
  | 'following'
  | 'followed-by'
  | 'not-found'
  | 'mismatch'
  | 'relation-unknown';

export interface PreviewRow {
  key: string;
  handle?: string;
  id?: string;
  name?: string;
  category?: string;
  source?: string;
  status: PreviewStatus;
  warnings: string[];
  checked: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  pace: 'prudent',
  listUrl: '',
  autoRefresh: false,
  dailyCap: 50,
  minDelaySec: 20,
  maxDelaySec: 45,
  transport: 'tab',
};

export const MAX_DAILY_CAP = 500;
