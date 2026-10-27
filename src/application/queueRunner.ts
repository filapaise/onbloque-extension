import {
  applyBackoff,
  clearBackoff,
  dequeueHead,
  hitCap,
  nextMidnightParis,
  randomDelayMs,
  remainingCap,
  rollDay,
} from '../domain/queue.ts';
import { frenchError, isPauseWorthy, isSkippable, XApiError } from '../domain/errors.ts';
import { entryKey, entryKeys } from '../domain/handle.ts';
import { pacePause } from '../domain/presets.ts';
import type { QueueItem, RunState } from '../domain/types.ts';
import { appendLog, loadStore, pushBlocked, savePartial } from '../infra/storage.ts';
import {
  blockUser,
  sanitizeErrorBody,
  unblockUser,
  verifyCredentials,
  type FetchFn,
} from '../infra/xClient.ts';
import { checkRelationship } from '../infra/followingGuard.ts';
import {
  collectPageScriptUrls,
  makeTabFetch,
  readCsrfFromTab,
  requireXTab,
} from '../infra/tabFetch.ts';

const ALARM_TICK = 'onbloque-tick';
const ALARM_DAILY = 'onbloque-daily-list';
const ALARM_RESUME = 'onbloque-resume';

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let runningLock = false;
let cachedSelf: { id: string; handle: string; at: number } | null = null;
const SELF_TTL = 10 * 60_000;

async function tabContext(): Promise<{ fetchFn: FetchFn; csrf: string; tabId: number }> {
  const tabId = await requireXTab();
  const csrf = await readCsrfFromTab(tabId);
  if (!csrf) throw new XApiError('not-logged-in', 0, 'not-logged-in');
  return { fetchFn: makeTabFetch(tabId), csrf, tabId };
}

export async function getCachedSelf(
  fetchFn?: FetchFn,
  csrf?: string,
  opts: { tabId?: number; scriptUrls?: string[] } = {},
): Promise<{ id: string; handle: string } | null> {
  if (cachedSelf && Date.now() - cachedSelf.at < SELF_TTL) {
    return { id: cachedSelf.id, handle: cachedSelf.handle };
  }
  if (!fetchFn || !csrf) return cachedSelf ? { id: cachedSelf.id, handle: cachedSelf.handle } : null;
  const self = await verifyCredentials(fetchFn, csrf, opts);
  if (self) cachedSelf = { ...self, at: Date.now() };
  return self;
}

export async function ensureAlarms(autoRefresh: boolean): Promise<void> {
  await chrome.alarms.clear(ALARM_TICK);
  await chrome.alarms.create(ALARM_TICK, { periodInMinutes: 1 });
  if (autoRefresh) await chrome.alarms.create(ALARM_DAILY, { periodInMinutes: 60 * 24 });
  else await chrome.alarms.clear(ALARM_DAILY);
}

export function alarmNameDaily(): string {
  return ALARM_DAILY;
}
export function alarmNameResume(): string {
  return ALARM_RESUME;
}
export function alarmNameTick(): string {
  return ALARM_TICK;
}

export async function scheduleResume(at: number): Promise<void> {
  await chrome.alarms.create(ALARM_RESUME, { when: Math.max(Date.now() + 5_000, at) });
}

export async function startQueue(): Promise<void> {
  const store = await loadStore();
  let run = rollDay(store.run);
  run = { ...run, running: true, lastError: null };
  if (!(run.resumeAt && run.resumeAt > Date.now() && run.resumeReason === 'cap')) {
    run = { ...run, resumeAt: null, resumeReason: null, backoffLevel: 0 };
  }
  await savePartial({ run });
  void processNext();
}

export async function pauseQueue(): Promise<void> {
  const store = await loadStore();
  await savePartial({ run: { ...store.run, running: false } });
  if (tickTimer) {
    clearTimeout(tickTimer);
    tickTimer = null;
  }
}

export async function processNext(): Promise<void> {
  if (runningLock) return;
  runningLock = true;
  try {
    await processNextInner();
  } finally {
    runningLock = false;
  }
}

function scheduleContinue(delayMs: number): void {
  if (tickTimer) clearTimeout(tickTimer);
  tickTimer = setTimeout(() => {
    tickTimer = null;
    void processNext();
  }, delayMs);
}

async function safetySkip(
  fetchFn: FetchFn,
  csrf: string,
  head: QueueItem,
  storeWhitelist: Array<{ id?: string; handle?: string }>,
): Promise<string | null> {
  if (head.action !== 'block') return null;
  const self = await getCachedSelf(fetchFn, csrf);
  const keys = new Set(entryKeys(head));
  if (self) {
    for (const k of entryKeys(self)) {
      if (keys.has(k)) return 'self';
    }
  }
  for (const w of storeWhitelist) {
    for (const k of entryKeys(w)) {
      if (keys.has(k)) return 'whitelist';
    }
  }
  try {
    const rel = await checkRelationship(fetchFn, csrf, head, self?.id);
    if (rel.source === 'unknown' && !rel.id && !rel.handle) {
      // Could not verify — fail closed
      throw new XApiError('resolver-failed', 0, 'resolver-failed');
    }
    if (rel.following) return 'following';
    if (self && rel.id && rel.id === self.id) return 'self';
    for (const w of storeWhitelist) {
      if (w.id && rel.id === w.id) return 'whitelist';
      if (w.handle && rel.handle && w.handle.toLowerCase() === rel.handle.toLowerCase()) return 'whitelist';
    }
    if (rel.id) keys.add(`id:${rel.id}`);
    if (rel.handle) keys.add(`h:${rel.handle.toLowerCase()}`);
  } catch (e) {
    if (e instanceof XApiError) throw e;
    throw new XApiError('resolver-failed', 0, 'resolver-failed');
  }
  return null;
}

async function processNextInner(): Promise<void> {
  const store = await loadStore();
  let run: RunState = rollDay(store.run);
  if (!run.running) {
    await savePartial({ run });
    return;
  }
  if (run.resumeAt && run.resumeAt > Date.now()) {
    await scheduleResume(run.resumeAt);
    await savePartial({ run: { ...run, running: false } });
    return;
  }
  // Respect spacing even if alarm fires early
  if (run.lastActionAt) {
    const minGap = store.settings.minDelaySec * 1000;
    const due = run.lastActionAt + minGap - Date.now();
    if (due > 500) {
      scheduleContinue(due);
      return;
    }
  }
  if (remainingCap(run, store.settings) <= 0) {
    run = hitCap(run);
    await savePartial({ run });
    await scheduleResume(run.resumeAt ?? nextMidnightParis());
    await appendLog({
      at: Date.now(),
      level: 'info',
      message: `Plafond journalier atteint (${store.settings.dailyCap}). Reprise demain.`,
    });
    return;
  }
  if (store.queue.length === 0) {
    await savePartial({ run: { ...run, running: false, lastError: null } });
    return;
  }

  const { head, rest } = dequeueHead(store.queue);
  if (!head) {
    await savePartial({ run: { ...run, running: false } });
    return;
  }

  try {
    const { fetchFn, csrf, tabId } = await tabContext();
    const scriptUrls = await collectPageScriptUrls(tabId);
    await getCachedSelf(fetchFn, csrf, { tabId, scriptUrls });

    if (head.action === 'block') {
      const reason = await safetySkip(fetchFn, csrf, head, store.whitelist);
      if (reason) {
        run = { ...run, totalSkipped: run.totalSkipped + 1, lastError: `Ignoré (${reason})` };
        await savePartial({ queue: rest, run });
        await appendLog({
          at: Date.now(),
          level: 'info',
          handle: head.handle,
          id: head.id,
          message: `Ignoré avant blocage (${reason}).`,
        });
        scheduleContinue(randomDelayMs(store.settings));
        return;
      }
    }

    const result =
      head.action === 'unblock'
        ? await unblockUser(fetchFn, csrf, head, { scriptUrls })
        : await blockUser(fetchFn, csrf, head, { scriptUrls });

    run = clearBackoff({
      ...run,
      actionsToday: run.actionsToday + 1,
      totalDone: run.totalDone + 1,
      lastError: null,
      lastActionAt: Date.now(),
    });

    const keys = entryKeys({ id: result.id ?? head.id, handle: result.handle ?? head.handle });
    if (head.action === 'block') {
      await pushBlocked(
        { id: result.id ?? head.id, handle: result.handle ?? head.handle, at: Date.now() },
        keys,
      );
    }

    await savePartial({ queue: rest, run });
    await appendLog({
      at: Date.now(),
      level: 'info',
      handle: result.handle ?? head.handle,
      id: result.id ?? head.id,
      message: head.action === 'unblock' ? 'Débloqué' : 'Bloqué',
    });

    // Long pause every N
    const { everyN, pauseSec } = pacePause(store.settings.pace ?? 'prudent');
    let delay = randomDelayMs(store.settings);
    if (everyN > 0 && run.actionsToday > 0 && run.actionsToday % everyN === 0) {
      delay = Math.max(delay, pauseSec * 1000);
      await appendLog({
        at: Date.now(),
        level: 'info',
        message: `Pause de sécurité ${pauseSec}s après ${everyN} actions.`,
      });
    }
    scheduleContinue(delay);
    return;
  } catch (e) {
    const err =
      e instanceof XApiError
        ? e
        : new XApiError(String(e), 0, 'unknown', sanitizeErrorBody(String(e)));

    if (err.code === 'rate-limit') {
      // Stop for a long time after first 429 (not 30s resume)
      const until = Date.now() + 60 * 60_000;
      run = {
        ...applyBackoff(run),
        resumeAt: until,
        resumeReason: 'rate-limit',
        running: false,
        lastError: frenchError('rate-limit', 'dans 1 h'),
      };
      await savePartial({ queue: store.queue, run });
      await scheduleResume(until);
      await appendLog({
        at: Date.now(),
        level: 'warn',
        handle: head.handle,
        id: head.id,
        message: frenchError('rate-limit', 'dans 1 h'),
      });
      return;
    }

    if (isPauseWorthy(err.code)) {
      const msg = frenchError(err.code);
      await savePartial({
        queue: store.queue,
        run: { ...run, running: false, lastError: msg },
      });
      await appendLog({
        at: Date.now(),
        level: 'error',
        handle: head.handle,
        id: head.id,
        message: msg,
      });
      return;
    }

    if (isSkippable(err.code) || err.status === 404 || err.message === 'mismatch') {
      const msg =
        err.message === 'mismatch'
          ? 'Incohérence id/@ — ignoré'
          : frenchError(err.code === 'suspended' ? 'suspended' : 'not-found');
      const skipped = run.totalSkipped + 1;
      run = { ...run, totalSkipped: skipped, lastError: `${msg} (${skipped} ignoré${skipped > 1 ? 's' : ''})` };
      await savePartial({ queue: rest, run });
      await appendLog({
        at: Date.now(),
        level: 'warn',
        handle: head.handle,
        id: head.id,
        message: msg,
      });
      scheduleContinue(randomDelayMs(store.settings));
      return;
    }

    // Unknown / 5xx / forbidden → backoff
    const attempts = head.attempts + 1;
    const item: QueueItem = { ...head, attempts };
    run = applyBackoff(run);
    const msg = frenchError(err.code === 'forbidden' ? 'forbidden' : 'network', 'bientôt');
    if (attempts >= 3) {
      run = clearBackoff({
        ...run,
        totalSkipped: run.totalSkipped + 1,
        lastError: msg,
        running: true,
      });
      await savePartial({ queue: rest, run });
    } else {
      await savePartial({
        queue: [item, ...rest],
        run: { ...run, lastError: msg },
      });
      await scheduleResume(run.resumeAt ?? Date.now() + 60_000);
    }
    await appendLog({
      at: Date.now(),
      level: 'warn',
      handle: head.handle,
      id: head.id,
      message: `${msg} (essai ${attempts}/3)`,
    });
    if (attempts >= 3) scheduleContinue(randomDelayMs(store.settings));
  }
}
