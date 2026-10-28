import type { BlockedRecord, QueueItem, RunState, Settings } from './types.ts';
import { entryKey } from './handle.ts';

export function todayKey(d = new Date()): string {
  // Jour civil Europe/Paris (UTC+1 en hiver, UTC+2 en été). Approximation via toLocaleString.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${day}`;
}

export function rollDay(state: RunState, now = Date.now()): RunState {
  const key = todayKey(new Date(now));
  if (state.dayKey === key) return state;
  return {
    ...state,
    dayKey: key,
    actionsToday: 0,
    backoffLevel: 0,
    resumeAt: null,
    resumeReason: null,
  };
}

export function randomDelayMs(settings: Settings): number {
  const min = Math.max(1, settings.minDelaySec) * 1000;
  const max = Math.max(min, settings.maxDelaySec * 1000);
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function remainingCap(state: RunState, settings: Settings): number {
  return Math.max(0, settings.dailyCap - state.actionsToday);
}

export function nextMidnightParis(from = Date.now()): number {
  // Calculer le prochain 00:00 Europe/Paris.
  for (let h = 1; h <= 48; h++) {
    const t = from + h * 3600_000;
    if (todayKey(new Date(t)) !== todayKey(new Date(from))) {
      // Remonter à l'heure pile du changement de jour.
      let lo = from;
      let hi = t;
      while (hi - lo > 1000) {
        const mid = Math.floor((lo + hi) / 2);
        if (todayKey(new Date(mid)) === todayKey(new Date(from))) lo = mid;
        else hi = mid;
      }
      return hi;
    }
  }
  return from + 24 * 3600_000;
}

export function enqueue(
  queue: QueueItem[],
  items: Array<{ handle?: string; id?: string; action?: 'block' | 'unblock' }>,
  action: 'block' | 'unblock' = 'block',
): { queue: QueueItem[]; added: number } {
  const existing = new Set(queue.map((q) => `${q.action}:${q.key}`));
  const next = queue.slice();
  let added = 0;
  const now = Date.now();
  for (const it of items) {
    const key = entryKey(it);
    if (!key) continue;
    const act = it.action ?? action;
    const sig = `${act}:${key}`;
    if (existing.has(sig)) continue;
    existing.add(sig);
    next.push({
      key,
      handle: it.handle,
      id: it.id,
      action: act,
      addedAt: now,
      attempts: 0,
    });
    added++;
  }
  return { queue: next, added };
}

export function dequeueHead(queue: QueueItem[]): { head: QueueItem | null; rest: QueueItem[] } {
  if (queue.length === 0) return { head: null, rest: [] };
  return { head: queue[0]!, rest: queue.slice(1) };
}

export function applyBackoff(state: RunState, now = Date.now()): RunState {
  const level = Math.min(6, state.backoffLevel + 1);
  const delay = Math.min(30 * 60_000, 30_000 * 2 ** (level - 1));
  return {
    ...state,
    backoffLevel: level,
    resumeAt: now + delay,
    resumeReason: 'rate-limit',
    running: false,
  };
}

export function clearBackoff(state: RunState): RunState {
  return { ...state, backoffLevel: 0, resumeAt: null, resumeReason: null };
}

export function hitCap(state: RunState): RunState {
  return {
    ...state,
    running: false,
    resumeAt: nextMidnightParis(),
    resumeReason: 'cap',
  };
}

export function initialRunState(): RunState {
  return {
    running: false,
    dayKey: todayKey(),
    actionsToday: 0,
    backoffLevel: 0,
    resumeAt: null,
    resumeReason: null,
    lastError: null,
    totalDone: 0,
    totalSkipped: 0,
    lastActionAt: null,
    nextActionAt: null,
    lastBlocked: null,
    batchDone: 0,
    batchSkipped: 0,
    batchStartedAt: null,
    totalSmall: 0,
    batchSmall: 0,
  };
}

function count(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Compteurs du lot en cours, robustes aux rechargements :
 * - début du lot = `batchStartedAt` persisté, ou à défaut le plus ancien `addedAt`
 *   de la file (état venu d'une version qui ne l'enregistrait pas) ;
 * - blocages faits = max(compteur persisté, blocages enregistrés depuis le début du lot).
 * Valeurs invalides en stockage → 0 (jamais de NaN dans la barre).
 */
export function reconcileBatch(run: RunState, queue: QueueItem[], blocked: BlockedRecord[]): RunState {
  let batchDone = count(run.batchDone);
  const batchSkipped = count(run.batchSkipped);
  const batchSmall = count(run.batchSmall);
  let startedAt = count(run.batchStartedAt) || null;
  if (!startedAt && queue.length) {
    let min = Infinity;
    for (const q of queue) {
      const a = count(q?.addedAt);
      if (a && a < min) min = a;
    }
    startedAt = Number.isFinite(min) ? min : null;
  }
  if (startedAt && queue.length) {
    let since = 0;
    for (const b of blocked) if (count(b?.at) >= startedAt) since++;
    batchDone = Math.max(batchDone, since);
  }
  if (
    batchDone === run.batchDone &&
    batchSkipped === run.batchSkipped &&
    batchSmall === (run.batchSmall ?? 0) &&
    (startedAt ?? null) === (run.batchStartedAt ?? null)
  ) {
    return run;
  }
  return { ...run, batchDone, batchSkipped, batchSmall, batchStartedAt: startedAt };
}

/** Nouveau lot sur une file vide : compteurs à zéro, début daté. */
export function startBatch(run: RunState, now = Date.now()): RunState {
  return { ...run, batchDone: 0, batchSkipped: 0, batchSmall: 0, batchStartedAt: now, nextActionAt: null };
}
