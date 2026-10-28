import {
  clearBackoff,
  dequeueHead,
  hitCap,
  nextMidnightParis,
  randomDelayMs,
  remainingCap,
  rollDay,
} from '../domain/queue.ts';
import {
  describeError,
  fmtClock,
  frenchError,
  isAuthLoss,
  isSkippable,
  isTransient,
  rateLimitResumeAt,
  TRANSIENT_BACKOFF_MS,
  XApiError,
} from '../domain/errors.ts';
import { recordDiag } from '../infra/diagnostics.ts';
import { batchResolveHandles, cacheGet, loadIdCache, pickBatch, saveIdCache } from '../infra/idCache.ts';
import { entryKeys } from '../domain/handle.ts';
import { pacePause } from '../domain/presets.ts';
import type { ListEntry, QueueItem, RunState, Settings } from '../domain/types.ts';
import { appendLog, loadStore, pushBlocked, savePartial } from '../infra/storage.ts';
import {
  blockUser,
  resolveUserId,
  unblockUser,
  type ResolveResult,
  type SelfAccount,
  type XContext,
} from '../infra/xClient.ts';
import { lookupRelationships } from '../infra/xRelations.ts';
import { getSelf, openXSession } from './session.ts';
import { isBelowThreshold, smallAccountMessage } from '../domain/followers.ts';
import { followerEntryFor, knownId } from '../infra/followerCounts.ts';

const ALARM_TICK = 'onbloque-tick';
const ALARM_DAILY = 'onbloque-daily-list';
const ALARM_RESUME = 'onbloque-resume';
/** Filet de sécurité si Chrome endort le service worker pendant l'attente entre deux blocages. */
const ALARM_NEXT = 'onbloque-next';

let tickTimer: ReturnType<typeof setTimeout> | null = null;
let runningLock = false;

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
export function alarmNameNext(): string {
  return ALARM_NEXT;
}

export async function scheduleResume(at: number): Promise<void> {
  await chrome.alarms.create(ALARM_RESUME, { when: Math.max(Date.now() + 5_000, at) });
}

export async function startQueue(): Promise<void> {
  const store = await loadStore();
  let run = rollDay(store.run);
  // Plafond du jour et limite X : on ne force jamais avant l'heure de reprise.
  const hold =
    run.resumeAt && run.resumeAt > Date.now() && (run.resumeReason === 'cap' || run.resumeReason === 'rate-limit');
  run = { ...run, running: true, lastError: hold ? run.lastError : null };
  if (!hold) {
    run = { ...run, resumeAt: null, resumeReason: null, backoffLevel: 0 };
  }
  await savePartial({ run });
  void processNext();
}

export async function pauseQueue(): Promise<void> {
  const store = await loadStore();
  // Pause manuelle : aucune reprise automatique programmée ne doit la contourner.
  await savePartial({ run: { ...store.run, running: false, resumeAt: null, resumeReason: null, nextActionAt: null } });
  await chrome.alarms.clear(ALARM_RESUME);
  await chrome.alarms.clear(ALARM_NEXT);
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
  // Pas de setInterval : une alarme unique réveille le worker s'il a été arrêté entre-temps.
  try {
    void chrome.alarms.create(ALARM_NEXT, { when: Date.now() + Math.max(1_000, delayMs) });
  } catch {
    /* alarms indisponible (tests) */
  }
}

/**
 * Dernier garde-fou, sur le compte RÉSOLU (id confirmé par X) : vous-même,
 * liste blanche, comptes que vous suivez. Relations indisponibles → throw
 * (la file se met en pause, aucun blocage « à l'aveugle »).
 */
/**
 * Heure de la prochaine action : `startedAt + delay` (écart début → début),
 * jamais moins d'une seconde après la fin du blocage précédent.
 */
export function nextActionTime(startedAt: number, doneAt: number, delayMs: number): number {
  return Math.max(doneAt + 1_000, startedAt + Math.max(0, delayMs));
}

export async function guardTarget(
  ctx: XContext,
  target: { id: string; handle: string },
  self: SelfAccount,
  whitelist: ListEntry[],
): Promise<string | null> {
  const keys = new Set(entryKeys(target));
  if (entryKeys(self).some((k) => keys.has(k))) return 'vous';
  if (whitelist.some((w) => entryKeys(w).some((k) => keys.has(k)))) return 'liste blanche';
  const { map } = await lookupRelationships(ctx, [target], self, { withFollowers: false, verifyIds: false });
  const rel = map.get(`id:${target.id}`) ?? map.get(`h:${target.handle.toLowerCase()}`);
  if (!rel) throw new XApiError('relation absente', 0, 'guard-unavailable');
  if (rel.following) return 'vous le suivez';
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
  // Attente annoncée à l'utilisateur (compte à rebours) : on ne la raccourcit pas.
  if (run.nextActionAt) {
    const wait = run.nextActionAt - Date.now();
    if (wait > 1_000) {
      scheduleContinue(wait);
      return;
    }
  }
  // Sans attente annoncée (reprise après pause/erreur) : espacement minimal depuis le dernier blocage.
  if (!run.nextActionAt && run.lastActionAt) {
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
    await savePartial({ run: { ...run, running: false, lastError: null, nextActionAt: null } });
    return;
  }

  const { head, rest } = dequeueHead(store.queue);
  if (!head) {
    await savePartial({ run: { ...run, running: false } });
    return;
  }

  // Le délai du rythme se mesure d'un début de blocage au suivant (comme décrit dans l'UI),
  // pas après la fin des requêtes (sinon chaque écart serait rallongé de leur durée).
  const startedAt = Date.now();
  try {
    const session = await openXSession({ background: true });
    const { ctx } = session;
    if (session.tabOpened || session.tabReloaded) {
      await appendLog({
        at: Date.now(),
        level: 'info',
        message: session.tabOpened
          ? 'Aucun onglet x.com ouvert : un onglet x.com a été ouvert en arrière-plan pour continuer.'
          : 'Onglet x.com déchargé par Chrome : rechargé pour continuer.',
      });
    }
    // Identité exigée avant tout blocage (fail-closed si inconnue).
    const self = head.action === 'block' ? await getSelf(session) : null;

    // 1.3.0 — seuil d'abonnés (0 = désactivé). Relu à chaque compte : un changement
    // de réglage en cours de file s'applique dès le compte suivant.
    const minFollowers = head.action === 'block' ? store.settings.minFollowers ?? 0 : 0;
    let gate: FollowerVerdict | null = null;
    if (minFollowers > 0) {
      // Id déjà connu (liste ou cache) : le compteur vient du cache ou d'UNE requête
      // UsersByRestIds pour les 50 prochains comptes — un petit compte est passé
      // sans aucune requête individuelle.
      gate = await followerGate(ctx, head, store.queue, minFollowers, 'pre');
      if (gate?.small) {
        await skipSmall(gate, head, rest, run, store.settings, startedAt, SMALL_SKIP_GAP_MS);
        return;
      }
    }

    const target = await resolveHead(ctx, head, store.queue);

    if (minFollowers > 0 && !gate) {
      gate = await followerGate(ctx, target, store.queue, minFollowers, 'post');
      if (gate?.small) {
        await skipSmall(gate, head, rest, run, store.settings, startedAt, randomDelayMs(store.settings));
        return;
      }
    }

    if (self) {
      const reason = await guardTarget(ctx, target, self, store.whitelist);
      if (reason) throw new XApiError(reason, 0, 'protected');
    }

    const result =
      head.action === 'unblock' ? await unblockUser(ctx, target) : await blockUser(ctx, target);

    const doneAt = Date.now();
    // Long pause every N
    const { everyN, pauseSec } = pacePause(store.settings.pace ?? 'prudent');
    const actionsToday = run.actionsToday + 1;
    let delay = rest.length ? randomDelayMs(store.settings) : 0;
    const longPause = rest.length > 0 && everyN > 0 && actionsToday % everyN === 0;
    if (longPause) delay = Math.max(delay, pauseSec * 1000);
    const nextAt = nextActionTime(startedAt, doneAt, delay);

    run = clearBackoff({
      ...run,
      actionsToday,
      totalDone: run.totalDone + 1,
      lastError: null,
      lastActionAt: doneAt,
      nextActionAt: rest.length ? nextAt : null,
      lastBlocked: { handle: result.handle, id: result.id, at: doneAt },
      batchDone: (run.batchDone ?? 0) + 1,
    });

    if (head.action === 'block') {
      await pushBlocked({ id: result.id, handle: result.handle, at: doneAt }, entryKeys(result));
    }

    await savePartial({ queue: rest, run });
    await appendLog({
      at: doneAt,
      level: 'info',
      handle: result.handle,
      id: result.id,
      message: head.action === 'unblock' ? 'Débloqué' : 'Bloqué',
    });
    if (longPause) {
      await appendLog({
        at: Date.now(),
        level: 'info',
        message: `Pause de sécurité ${pauseSec}s après ${everyN} actions.`,
      });
    }
    scheduleContinue(Math.max(500, nextAt - Date.now()));
    return;
  } catch (e) {
    const err = e instanceof XApiError ? e : new XApiError(describeError(e), 0, 'unknown');
    const decision = decideOnError(err, run, head.attempts);
    await recordDiag({
      step: decision.kind,
      endpoint: err.message,
      status: err.status || undefined,
      code: err.code,
      note: decision.kind === 'skip' ? undefined : err.body,
    });

    switch (decision.kind) {
      case 'rate-limit':
      case 'retry-later': {
        run = { ...run, ...decision.run, nextActionAt: null };
        await savePartial({ queue: store.queue, run });
        await scheduleResume(decision.resumeAt);
        await appendLog({ at: Date.now(), level: 'warn', handle: head.handle, id: head.id, message: decision.message });
        return;
      }
      case 'pause': {
        run = { ...run, ...decision.run, nextActionAt: null };
        await savePartial({ queue: store.queue, run });
        await appendLog({ at: Date.now(), level: 'error', handle: head.handle, id: head.id, message: decision.message });
        return;
      }
      case 'skip': {
        const skipped = run.totalSkipped + 1;
        const delay = rest.length ? randomDelayMs(store.settings) : 0;
        const nextAt = nextActionTime(startedAt, Date.now(), delay);
        run = clearBackoff({
          ...run,
          totalSkipped: skipped,
          batchSkipped: (run.batchSkipped ?? 0) + 1,
          nextActionAt: rest.length ? nextAt : null,
          lastError: `${decision.message} (${skipped} ignoré${skipped > 1 ? 's' : ''})`,
        });
        await savePartial({ queue: rest, run });
        await appendLog({ at: Date.now(), level: 'warn', handle: head.handle, id: head.id, message: decision.message });
        scheduleContinue(Math.max(500, nextAt - Date.now()));
        return;
      }
      case 'retry-item': {
        run = { ...run, ...decision.run, nextActionAt: null };
        await savePartial({ queue: [{ ...head, attempts: head.attempts + 1 }, ...rest], run });
        await scheduleResume(decision.resumeAt);
        await appendLog({
          at: Date.now(),
          level: 'warn',
          handle: head.handle,
          id: head.id,
          message: `${decision.message} (essai ${head.attempts + 1}/3)`,
        });
        return;
      }
    }
  }
}

/** Écart avant le compte suivant quand un petit compte est passé sans requête individuelle. */
export const SMALL_SKIP_GAP_MS = 2_000;

export interface FollowerVerdict {
  small: boolean;
  followers: number;
  /** Une requête UsersByRestIds est partie pour obtenir ce compteur. */
  fetched: boolean;
}

/**
 * Seuil d'abonnés pour un compte.
 * - `pre` (avant résolution) : id tiré de la liste ou du cache @ → id ; verdict
 *   seulement si X a donné un compteur pour CE couple id ↔ @ ; sinon null
 *   (la résolution normale décide : renommé, suspendu…). Un verdict « petit »
 *   ne fait que PASSER le compte, jamais le bloquer.
 * - `post` (id confirmé par X) : compteur obligatoire ; compte disparu → ignoré ;
 *   compteur absent de la réponse → `resolver-failed` (reprise auto puis pause :
 *   on ne bloque pas à l'aveugle un compte peut-être sous le seuil).
 */
export async function followerGate(
  ctx: XContext,
  ref: { handle?: string; id?: string },
  queue: QueueItem[],
  minFollowers: number,
  mode: 'pre' | 'post',
): Promise<FollowerVerdict | null> {
  const idCache = await loadIdCache();
  const id = mode === 'post' ? ref.id ?? null : knownId(ref, idCache);
  if (!id) {
    if (mode === 'pre') return null;
    throw new XApiError('seuil d’abonnés : id inconnu', 0, 'resolver-failed');
  }
  const { entry, fetched } = await followerEntryFor(ctx, id, queue, idCache);
  if (entry.s === 'ok') {
    if (mode === 'pre' && ref.handle && entry.h.toLowerCase() !== ref.handle.toLowerCase()) return null;
    return { small: isBelowThreshold(entry.n, minFollowers), followers: entry.n, fetched };
  }
  if (mode === 'pre') return null;
  if (entry.s === 'gone') throw new XApiError('suspended', 0, 'suspended');
  throw new XApiError('UsersByRestIds : nombre d’abonnés absent', 0, 'resolver-failed');
}

/**
 * Compteurs après un petit compte passé (pure, testée) : compté à part
 * (`totalSmall` / `batchSmall`), ni dans « bloqués », ni dans « ignorés »,
 * ni dans le plafond du jour ; pas de recul (backoff) ; pas de lastError.
 */
export function applySmallSkip(run: RunState, restLength: number, startedAt: number, gapMs: number, now = Date.now()): RunState {
  const nextAt = nextActionTime(startedAt, now, restLength ? gapMs : 0);
  return clearBackoff({
    ...run,
    totalSmall: (run.totalSmall ?? 0) + 1,
    batchSmall: (run.batchSmall ?? 0) + 1,
    nextActionAt: restLength ? nextAt : null,
  });
}

async function skipSmall(
  gate: FollowerVerdict,
  head: QueueItem,
  rest: QueueItem[],
  run: RunState,
  settings: Settings,
  startedAt: number,
  gapMs: number,
): Promise<void> {
  const minFollowers = settings.minFollowers ?? 0;
  const next = applySmallSkip(run, rest.length, startedAt, gapMs);
  const nextAt = next.nextActionAt ?? Date.now();
  await savePartial({ queue: rest, run: next });
  await appendLog({
    at: Date.now(),
    level: 'info',
    handle: head.handle,
    id: head.id,
    message: smallAccountMessage(gate.followers, minFollowers),
  });
  scheduleContinue(Math.max(500, nextAt - Date.now()));
}

/**
 * Résolution de la tête de file : id déjà connu → vérifié par X ;
 * sinon cache persistant @ → id, alimenté par paquets de 100 @ (une requête
 * friendships/lookup pour toute la suite de la file). Un @ absent d'X est
 * ignoré (skip), jamais une pause de toute la file.
 */
export async function resolveHead(
  ctx: XContext,
  head: QueueItem,
  queue: QueueItem[],
): Promise<{ id: string; handle: string }> {
  let ref: { handle?: string; id?: string } = { handle: head.handle, id: head.id };
  let fromCache = false;
  let absentHint = false;
  const key = head.handle?.toLowerCase();

  if (!ref.id && ref.handle && key) {
    const cache = await loadIdCache();
    let entry = cacheGet(cache, key);
    if (!entry) {
      const batch = pickBatch(queue, cache);
      const got = await batchResolveHandles(ctx, batch.length ? batch : [ref.handle]);
      if (got) {
        await saveIdCache(got);
        entry = got[key] ?? null;
        const absent = Object.values(got).filter((x) => x.s === 'absent').length;
        if (batch.length > 1) {
          await appendLog({
            at: Date.now(),
            level: 'info',
            message: `Résolution groupée : ${batch.length} @ en une requête (${absent} absent${absent > 1 ? 's' : ''} de X).`,
          });
        }
      }
    }
    if (entry?.s === 'ok') {
      ref = { id: entry.id, handle: ref.handle };
      fromCache = true;
    } else if (entry?.s === 'absent') {
      absentHint = true;
    }
  }

  let resolved: ResolveResult;
  try {
    resolved = await resolveUserId(ctx, ref);
    if (fromCache && !resolved.ok) {
      // L'id en cache ne porte plus ce @ (renommé) : on repart du @ seul.
      resolved = await resolveUserId(ctx, { handle: ref.handle });
    }
  } catch (e) {
    // friendships/lookup a déjà dit « absent » : si la confirmation GraphQL
    // échoue pour une raison technique, on ignore CE compte au lieu de tout arrêter.
    if (
      absentHint &&
      e instanceof XApiError &&
      e.code !== 'rate-limit' &&
      !isAuthLoss(e.code)
    ) {
      resolved = { ok: false, reason: 'not-found' };
    } else {
      throw e;
    }
  }
  if (!resolved.ok) {
    if (key) await saveIdCache({ [key]: { s: 'absent', at: Date.now() } });
    throw new XApiError(resolved.reason, 0, resolved.reason);
  }
  if (key) await saveIdCache({ [key]: { s: 'ok', id: resolved.id, h: resolved.handle, at: Date.now() } });
  return { id: resolved.id, handle: resolved.handle };
}

export type ErrorDecision =
  | { kind: 'rate-limit' | 'retry-later' | 'retry-item'; resumeAt: number; message: string; run: Partial<RunState> }
  | { kind: 'pause'; message: string; run: Partial<RunState> }
  | { kind: 'skip'; message: string };

function where(err: XApiError): string {
  const label = err.message && err.message !== err.code ? err.message : '';
  const st = err.status ? `HTTP ${err.status}` : '';
  return [label, st].filter(Boolean).join(' · ');
}

/** Politique d'erreur de la file (pure, testée). */
export function decideOnError(err: XApiError, run: RunState, attempts: number, now = Date.now()): ErrorDecision {
  if (err.code === 'rate-limit') {
    const resumeAt = rateLimitResumeAt(err.resetAt, now);
    const message = frenchError('rate-limit', fmtClock(resumeAt));
    return {
      kind: 'rate-limit',
      resumeAt,
      message,
      run: { running: false, resumeAt, resumeReason: 'rate-limit', lastError: message },
    };
  }
  if (isAuthLoss(err.code)) {
    const message = describeError(err);
    return { kind: 'pause', message, run: { running: false, resumeAt: null, resumeReason: null, lastError: message } };
  }
  if (isSkippable(err.code)) {
    return { kind: 'skip', message: frenchError(err.code, err.code === 'protected' ? err.message : undefined) };
  }
  if (isTransient(err.code)) {
    const level = run.backoffLevel;
    const base =
      err.code === 'network'
        ? `X ne répond pas${where(err) ? ` (${where(err)})` : ''}.`
        : err.code === 'resolver-failed'
          ? frenchError('resolver-failed', where(err) || undefined)
          : describeError(err);
    if (level < TRANSIENT_BACKOFF_MS.length) {
      const resumeAt = now + TRANSIENT_BACKOFF_MS[level]!;
      const message = `${base} Rien n’a été bloqué ; reprise automatique à ${fmtClock(resumeAt)}.`;
      return {
        kind: 'retry-later',
        resumeAt,
        message,
        run: { running: false, resumeAt, resumeReason: 'error', backoffLevel: level + 1, lastError: message },
      };
    }
    const message = `${base} File en pause après ${level} reprises automatiques — détails dans Options › Diagnostic.`;
    return {
      kind: 'pause',
      message,
      run: { running: false, resumeAt: null, resumeReason: null, backoffLevel: 0, lastError: message },
    };
  }
  // 403 / 5xx / inconnu sur CE compte : 3 essais espacés puis ignoré.
  if (attempts + 1 >= 3) {
    return { kind: 'skip', message: `${err.code === 'forbidden' ? frenchError('forbidden') : describeError(err)} — ignoré après 3 essais` };
  }
  const resumeAt = now + Math.min(30 * 60_000, 60_000 * 2 ** attempts);
  const message = `${err.code === 'forbidden' ? frenchError('forbidden') : describeError(err)} — nouvel essai à ${fmtClock(resumeAt)}`;
  return {
    kind: 'retry-item',
    resumeAt,
    message,
    run: { running: false, resumeAt, resumeReason: 'error', lastError: message },
  };
}
