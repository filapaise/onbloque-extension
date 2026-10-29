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
import { applyCustomDelay, applyPace, nearestPace, sanitizeDelays } from '../domain/presets.ts';
import type { PacePreset } from '../domain/types.ts';
import { initialRunState, reconcileBatch } from '../domain/queue.ts';
import { sanitizeMinFollowers } from '../domain/followers.ts';
import {
  ACCOUNT_BLOCKED_KEY,
  applyBlockingObservations,
  sanitizeAccountBlocked,
  type BlockingObservation,
} from '../domain/history.ts';

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
  /** 1.3.2 — comptes de la liste déjà bloqués sur le compte (vus par X), plafonnés. */
  blockedOnAccount: BlockedRecord[];
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
  ACCOUNT_BLOCKED_KEY,
] as const;

export async function loadStore(): Promise<StoreShape> {
  const raw = (await chrome.storage.local.get([...KEYS])) as Partial<StoreShape>;
  const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) });
  const queue = Array.isArray(raw.queue) ? raw.queue : [];
  const blockedByExt = Array.isArray(raw.blockedByExt) ? raw.blockedByExt : [];
  // Compteurs du lot recalculés depuis des données persistées : survivent au
  // redémarrage du service worker et au rechargement / à la mise à jour de l'extension.
  const run = reconcileBatch({ ...initialRunState(), ...(raw.run ?? {}) }, queue, blockedByExt);
  return {
    settings,
    list: raw.list ?? null,
    listSource: raw.listSource ?? null,
    listFetchedAt: raw.listFetchedAt ?? null,
    whitelist: Array.isArray(raw.whitelist) ? raw.whitelist : [],
    queue,
    run,
    blockedByExt,
    logs: Array.isArray(raw.logs) ? raw.logs : [],
    alreadyBlockedKeys: Array.isArray(raw.alreadyBlockedKeys) ? raw.alreadyBlockedKeys : [],
    blockedOnAccount: sanitizeAccountBlocked(raw.blockedOnAccount),
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
  // Délais personnalisés (Réglages avancés) : conservés seulement s'ils sont valides
  // (bornés à 15–900 s, max ≥ min) ; sinon ignorés → délais du preset.
  const custom = s.customDelay === true ? sanitizeDelays(s.minDelaySec, s.maxDelaySec) : null;
  return {
    ...withPace,
    ...(custom ?? {}),
    customDelay: !!custom,
    listUrl: typeof s.listUrl === 'string' ? s.listUrl.trim() : withPace.listUrl,
    autoRefresh: false,
    transport: 'tab',
    dailyCap: Math.min(MAX_DAILY_CAP, withPace.dailyCap),
    minFollowers: sanitizeMinFollowers(s.minFollowers) ?? 0,
  };
}

function isPace(v: unknown): v is PacePreset {
  return v === 'prudent' || v === 'normal' || v === 'max';
}

/**
 * Applique un patch de réglages venant d'une page de l'extension (SET_SETTINGS).
 * - `pace` valide → preset appliqué ET délais personnalisés effacés ;
 * - `customDelay: true` → min/max validés (15–900 s, max ≥ min), garbage ignoré
 *   (les valeurs précédentes restent) ;
 * - `customDelay: false` → retour aux délais du preset ;
 * - `minFollowers` (1.3.0) : entier ≥ 0 (0 = désactivé) ; garbage ignoré ;
 * - plafond, délais, transport jamais copiés tels quels depuis le message.
 */
export function mergeSettingsPatch(current: Settings, patch: Partial<Settings> | null | undefined): Settings {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Record<keyof Settings, unknown>>;
  let merged: Settings = { ...current };
  if (typeof p.listUrl === 'string') {
    const u = p.listUrl.trim();
    if (u && !u.startsWith('https://')) throw new Error('URL de liste : https uniquement.');
    merged.listUrl = u;
  }
  if (isPace(p.pace)) {
    merged = applyPace(merged, p.pace);
  } else if (p.customDelay === true) {
    merged = applyCustomDelay(merged, p.minDelaySec, p.maxDelaySec);
  } else if (p.customDelay === false) {
    merged = applyPace(merged, merged.pace ?? nearestPace(merged));
  }
  const minFollowers = sanitizeMinFollowers(p.minFollowers);
  if (minFollowers !== null) merged.minFollowers = minFollowers;
  return normalizeSettings(merged);
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

/**
 * 1.3.2 — Enregistre ce que X dit des relations « bloqué » (aperçu, garde-fou, déblocage).
 * Lecture-modification-écriture de la seule clé `blockedOnAccount` ; aucune écriture si
 * rien ne change. `allowRemoval` : seulement si la source dit de façon fiable « pas bloqué ».
 */
export async function recordBlockingObservations(
  observations: readonly BlockingObservation[],
  opts: { allowRemoval: boolean },
  now = Date.now(),
): Promise<void> {
  if (!observations.length) return;
  const data = (await chrome.storage.local.get(ACCOUNT_BLOCKED_KEY)) as Record<string, unknown>;
  const next = applyBlockingObservations(data[ACCOUNT_BLOCKED_KEY], observations, now, opts);
  if (next) await chrome.storage.local.set({ [ACCOUNT_BLOCKED_KEY]: next });
}
