/**
 * Progression visible de la file (popup, badge, bouton x.com) — logique pure.
 * Objectif : que l'attente volontaire (15 s minimum) entre deux blocages ne
 * ressemble jamais à un blocage de l'extension.
 */
import { fmtClock } from './errors.ts';
import { pacePause } from './presets.ts';
import { remainingCap, todayKey } from './queue.ts';
import type { RunState, Settings } from './types.ts';

export type ProgressState =
  | 'idle' // file vide, rien à faire
  | 'done' // lot terminé
  | 'running' // en cours (attente entre deux blocages ou action imminente)
  | 'cap' // plafond du jour atteint, reprise demain
  | 'rate-limit' // limite X, reprise automatique
  | 'retry' // erreur passagère, reprise automatique
  | 'error' // en pause sur une erreur qui demande une action
  | 'paused'; // pause manuelle

export interface Progress {
  state: ProgressState;
  remaining: number;
  done: number;
  skipped: number;
  /** 1.3.0 — passés car sous le seuil d'abonnés (comptés à part des « ignorés »). */
  small: number;
  total: number;
  /** 0…1 */
  pct: number;
  /** Prochaine action (running) ou reprise automatique (cap/rate-limit/retry). */
  nextAt: number | null;
  /** Secondes avant `nextAt` (0 si imminent / inconnu). */
  nextInSec: number;
  resumeAt: number | null;
  etaAt: number | null;
  /** Si la fin dépasse le plafond du jour : nombre de jours estimé. */
  etaDays: number;
  lastBlocked: { handle?: string; at: number } | null;
  /** Une ligne lisible : pourquoi ça attend / pourquoi c'est en pause. */
  reason: string;
}

/** Résumé minimal envoyé au content script x.com : uniquement des compteurs. */
export interface FabProgress {
  state: ProgressState;
  remaining: number;
  done: number;
  total: number;
  pct: number;
  nextAt: number | null;
}

export const SLOW_PACE_NOTE = 'Rythme volontairement lent pour protéger votre compte X.';

function nn(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Estimation de l'heure de fin (null si au-delà du plafond du jour). */
export function estimateEnd(
  remaining: number,
  run: RunState,
  settings: Settings,
  startAt: number,
): { etaAt: number | null; etaDays: number } {
  if (remaining <= 0) return { etaAt: null, etaDays: 0 };
  const capLeft = remainingCap(run, settings);
  if (remaining > capLeft) {
    const cap = Math.max(1, settings.dailyCap);
    return { etaAt: null, etaDays: Math.max(1, Math.ceil((remaining - capLeft) / cap)) };
  }
  const avgMs = ((settings.minDelaySec + settings.maxDelaySec) / 2) * 1000;
  const { everyN, pauseSec } = pacePause(settings.pace ?? 'prudent');
  let pauses = 0;
  if (everyN > 0) {
    // Pauses longues déclenchées quand actionsToday atteint un multiple de N.
    const from = run.actionsToday;
    pauses = Math.floor((from + remaining - 1) / everyN) - Math.floor(from / everyN);
    if (pauses < 0) pauses = 0;
  }
  const extra = pauses * Math.max(0, pauseSec * 1000 - avgMs);
  return { etaAt: Math.round(startAt + (remaining - 1) * avgMs + extra), etaDays: 0 };
}

export function computeProgress(run: RunState, queueLength: number, settings: Settings, now = Date.now()): Progress {
  const remaining = nn(queueLength);
  const done = nn(run.batchDone);
  const skipped = nn(run.batchSkipped);
  const small = nn(run.batchSmall);
  const handled = done + skipped + small;
  const total = handled + remaining;
  const pct = total > 0 ? handled / total : 0;
  const resumeAt = run.resumeAt && run.resumeAt > now ? run.resumeAt : null;
  const lastBlocked = run.lastBlocked && nn(run.lastBlocked.at) ? { handle: run.lastBlocked.handle, at: run.lastBlocked.at } : null;

  let state: ProgressState;
  if (remaining === 0) state = handled > 0 ? 'done' : 'idle';
  else if (resumeAt && run.resumeReason === 'cap') state = 'cap';
  else if (resumeAt && run.resumeReason === 'rate-limit') state = 'rate-limit';
  else if (resumeAt && run.resumeReason === 'error') state = 'retry';
  else if (run.running) state = 'running';
  else if (run.lastError) state = 'error';
  else state = 'paused';

  let nextAt: number | null = null;
  if (state === 'running') nextAt = run.nextActionAt && run.nextActionAt > now ? run.nextActionAt : null;
  else if (state === 'cap' || state === 'rate-limit' || state === 'retry') nextAt = resumeAt;
  const nextInSec = nextAt ? Math.max(0, Math.ceil((nextAt - now) / 1000)) : 0;

  const startAt = nextAt ?? now;
  const { etaAt, etaDays } =
    state === 'running' || state === 'rate-limit' || state === 'retry' || state === 'cap'
      ? estimateEnd(remaining, state === 'cap' ? { ...run, actionsToday: 0 } : run, settings, startAt)
      : { etaAt: null, etaDays: 0 };

  return {
    state,
    remaining,
    done,
    skipped,
    small,
    total,
    pct,
    nextAt,
    nextInSec,
    resumeAt,
    etaAt,
    etaDays,
    lastBlocked,
    reason: reasonFor(state, run, settings, resumeAt, now),
  };
}

export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min${sec % 60 && m < 5 ? ` ${sec % 60} s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')}` : ''}`;
}

/** « à 23:41 » ou « demain à 00:00 » (heure de Paris). */
export function fmtWhen(at: number, now = Date.now()): string {
  const sameDay = todayKey(new Date(at)) === todayKey(new Date(now));
  return `${sameDay ? '' : 'demain '}à ${fmtClock(at)}`.trim();
}

function reasonFor(
  state: ProgressState,
  run: RunState,
  settings: Settings,
  resumeAt: number | null,
  now: number,
): string {
  const inStr = resumeAt ? ` (dans ${fmtDuration(Math.max(0, Math.ceil((resumeAt - now) / 1000)))})` : '';
  switch (state) {
    case 'cap':
      return `Plafond du jour atteint (${settings.dailyCap}). Reprise automatique ${fmtWhen(resumeAt!, now)}${inStr}.`;
    case 'rate-limit':
      return `X limite les requêtes pour l’instant. Reprise automatique ${fmtWhen(resumeAt!, now)}${inStr}.`;
    case 'retry':
      return `${run.lastError ? `${run.lastError.replace(/[.\s]+$/, '')}. ` : 'Erreur passagère. '}Nouvel essai ${fmtWhen(resumeAt!, now)}${inStr}.`;
    case 'error':
      return `En pause : ${run.lastError}. Appuyez sur Démarrer pour réessayer.`.replace('..', '.');
    case 'paused':
      return 'En pause. Appuyez sur Démarrer pour reprendre.';
    case 'running':
      return SLOW_PACE_NOTE;
    case 'done':
      return 'Lot terminé.';
    default:
      return '';
  }
}

/** Texte « Prochain blocage dans 37 s » (popup, info-bulle du bouton x.com). */
export function nextLine(p: Pick<Progress, 'state' | 'nextInSec' | 'nextAt'>): string {
  if (p.state !== 'running') return '';
  if (!p.nextAt || p.nextInSec <= 0) return 'Blocage en cours…';
  return `Prochain blocage dans ${fmtDuration(p.nextInSec)}`;
}

export function etaLine(p: Progress, settings: Settings, now = Date.now()): string {
  if (p.etaDays === 1) return `Fin estimée demain (plafond de ${settings.dailyCap} par jour)`;
  if (p.etaDays > 1) return `Fin estimée dans ~${p.etaDays} jours (plafond de ${settings.dailyCap} par jour)`;
  if (p.etaAt) return `Fin estimée vers ${fmtWhen(p.etaAt, now).replace(/^à /, '')}`;
  return '';
}

/**
 * Part de l'anneau du bouton x.com à remplir : dès qu'un compte est traité,
 * au moins 6 % pour que l'arc reste visible (18 / 271 ne doit pas sembler vide).
 */
export function ringFraction(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.min(1, Math.max(0.06, pct));
}

/** « 12 / 80 bloqués · 3 ignorés · 40 petits comptes » (popup). */
export function countLine(p: Pick<Progress, 'done' | 'skipped' | 'small' | 'total'>): string {
  const parts = [`${p.done} / ${p.total} bloqué${p.done > 1 ? 's' : ''}`];
  if (p.skipped) parts.push(`${p.skipped} ignoré${p.skipped > 1 ? 's' : ''}`);
  if (p.small) parts.push(`${p.small} petit${p.small > 1 ? 's' : ''} compte${p.small > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export function countLabel(n: number): string {
  if (n <= 0) return '';
  if (n < 1000) return String(n);
  if (n < 10_000) return `${Math.floor(n / 1000)}k`;
  return '9k+';
}

export interface Badge {
  text: string;
  color: string;
  title: string;
}

export const BADGE_COLORS = {
  running: '#1d9bf0',
  waiting: '#ffad1f',
  error: '#f4212e',
  paused: '#71767b',
} as const;

/**
 * Badge de l'icône : nombre restant (ou secondes avant le prochain blocage
 * si `withSeconds`, utilisé quand le popup est ouvert et rafraîchit chaque seconde).
 */
export function badgeFor(p: Progress, opts: { withSeconds?: boolean } = {}): Badge {
  const base = 'OnBloque';
  switch (p.state) {
    case 'idle':
      return { text: '', color: BADGE_COLORS.paused, title: base };
    case 'done':
      return { text: '', color: BADGE_COLORS.running, title: `${base} — lot terminé (${p.done} bloqués)` };
    case 'running': {
      const secs = opts.withSeconds && p.nextAt && p.nextInSec > 0 && p.nextInSec < 1000 ? `${p.nextInSec}s` : '';
      const next = nextLine(p);
      return {
        text: secs || countLabel(p.remaining),
        color: BADGE_COLORS.running,
        title: `${base} — ${p.remaining} en attente${next ? ` · ${next.charAt(0).toLowerCase()}${next.slice(1)}` : ''}`,
      };
    }
    case 'cap':
    case 'rate-limit':
    case 'retry':
      return { text: countLabel(p.remaining), color: BADGE_COLORS.waiting, title: `${base} — ${p.reason}` };
    case 'error':
      return { text: '!', color: BADGE_COLORS.error, title: `${base} — ${p.reason}` };
    case 'paused':
      return { text: countLabel(p.remaining), color: BADGE_COLORS.paused, title: `${base} — ${p.reason}` };
  }
}

export function fabProgressOf(p: Progress): FabProgress {
  return { state: p.state, remaining: p.remaining, done: p.done + p.skipped + p.small, total: p.total, pct: p.pct, nextAt: p.nextAt };
}

const STATES: ReadonlySet<string> = new Set(['idle', 'done', 'running', 'cap', 'rate-limit', 'retry', 'error', 'paused']);

/** Validation côté content script d'un résumé reçu (types et bornes). */
export function parseFabProgress(raw: unknown): FabProgress | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? Math.floor(v) : null);
  if (typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  const remaining = int(o.remaining);
  const done = int(o.done);
  const total = int(o.total);
  if (remaining === null || done === null || total === null) return null;
  const pct = typeof o.pct === 'number' && Number.isFinite(o.pct) ? Math.min(1, Math.max(0, o.pct)) : 0;
  const nextAt = typeof o.nextAt === 'number' && Number.isFinite(o.nextAt) ? o.nextAt : null;
  return { state: o.state as ProgressState, remaining, done, total, pct, nextAt };
}
