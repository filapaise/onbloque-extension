import { sendMessage, type StatusSnapshot } from '../shared/messages.ts';
import { fmtRelative } from './format.ts';
import { fmtClock } from '../domain/errors.ts';
import { badgeFor, computeProgress, countLine, etaLine, fmtWhen, nextLine, SLOW_PACE_NOTE } from '../domain/progress.ts';
import { fmtFollowers } from '../domain/followers.ts';

let lastStatus: StatusSnapshot | null = null;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const RING_C = 2 * Math.PI * 30;

function setRing(pct: number): void {
  const fg = $('ring-fg');
  const offset = RING_C * (1 - Math.min(1, Math.max(0, pct)));
  fg.style.strokeDasharray = String(RING_C);
  fg.style.strokeDashoffset = String(offset);
}

function resumeLabel(s: StatusSnapshot): string {
  if (s.run.resumeAt && s.run.resumeAt > Date.now()) {
    const why =
      s.run.resumeReason === 'cap'
        ? 'plafond'
        : s.run.resumeReason === 'rate-limit'
          ? 'limite X'
          : s.run.resumeReason === 'error'
            ? 'reprise automatique'
            : '';
    const when = fmtRelative(s.run.resumeAt);
    return `Prochaine reprise : ${when}${why ? ` (${why})` : ''}`;
  }
  if (s.run.running && s.queue.length > 0) return 'En cours…';
  if (s.queue.length > 0) return 'Prochaine reprise : Maintenant (en pause)';
  return 'Prochaine reprise : —';
}

async function refresh(): Promise<void> {
  const resp = await sendMessage({ type: 'GET_STATUS' });
  if (!resp.ok || !('status' in resp)) {
    const err = $('error');
    err.hidden = false;
    err.textContent = ('error' in resp ? resp.error : null) || 'Impossible de joindre l’extension.';
    return;
  }
  lastStatus = resp.status;
  render(resp.status);
  renderLive();
}

/** Bloc « en direct » : recalculé chaque seconde à partir du dernier état connu. */
function renderLive(): void {
  const s = lastStatus;
  if (!s) return;
  const now = Date.now();
  const p = computeProgress(s.run, s.queue.length, s.settings, now);
  const live = $('live');
  const showLive = p.state !== 'idle';
  live.hidden = !showLive;
  live.dataset.state = p.state;
  if (showLive) {
    const next = nextLine(p);
    $('live-next').textContent =
      p.state === 'running'
        ? next
        : p.state === 'done'
          ? 'Terminé ✓'
          : p.state === 'paused' || p.state === 'error'
            ? 'En pause'
            : p.nextAt
              ? `Reprise ${fmtWhen(p.nextAt, now)}`
              : 'En attente';
    const pct = Math.round(p.pct * 100);
    const fill = $('bar-fg');
    fill.style.width = `${pct}%`;
    // Toujours un bout de barre visible dès qu'au moins un compte est traité.
    fill.classList.toggle('some', p.done + p.skipped + p.small > 0);
    $('bar').setAttribute('aria-valuenow', String(pct));
    $('live-count').textContent = countLine(p);
    const last = $('live-last');
    if (p.lastBlocked?.handle) {
      last.hidden = false;
      last.textContent = `Dernier bloqué : @${p.lastBlocked.handle} à ${fmtClock(p.lastBlocked.at)}`;
    } else last.hidden = true;
    const eta = $('live-eta');
    const etaText = etaLine(p, s.settings, now);
    eta.hidden = !etaText;
    eta.textContent = etaText;
    $('live-note').textContent = p.state === 'running' ? SLOW_PACE_NOTE : '';
  }
  // Raison de la pause, avec l'heure de reprise.
  const reason = $('pause-reason');
  const paused = p.state === 'cap' || p.state === 'rate-limit' || p.state === 'retry' || p.state === 'error' || p.state === 'paused';
  reason.hidden = !paused;
  reason.textContent = paused ? p.reason : '';
  // La raison détaillée remplace le bandeau d'erreur brut quand la file attend.
  if (paused) $('error').hidden = true;
  // Popup ouvert : le badge affiche les secondes avant le prochain blocage.
  setBadge(badgeFor(p, { withSeconds: true }));
}

let lastBadgeText = '';
function setBadge(b: { text: string; color: string }): void {
  if (b.text === lastBadgeText) return;
  lastBadgeText = b.text;
  try {
    void chrome.action?.setBadgeBackgroundColor({ color: b.color });
    void chrome.action?.setBadgeText({ text: b.text });
  } catch {
    /* ignore */
  }
}

function render(s: StatusSnapshot): void {
  const session = $('session');
  const connected = s.sessionOk;
  session.dataset.state = connected ? 'ok' : 'bad';
  session.querySelector('.label')!.textContent = connected
    ? s.self?.handle
      ? `@${s.self.handle}`
      : 'Connecté'
    : 'Hors ligne';

  const cap = s.settings.dailyCap;
  const today = s.run.actionsToday;
  $('today-num').textContent = String(today);
  $('today-cap').textContent = String(cap);
  $('today-title').textContent = `${today} bloqué${today > 1 ? 's' : ''} aujourd'hui sur ${cap}`;
  setRing(today / Math.max(1, cap));

  $('queue').textContent = String(s.queue.length);
  $('total-done').textContent = String(s.run.totalDone);
  $('total-skip').textContent = String(s.run.totalSkipped);
  // 1.3.0 — petits comptes passés (seuil d'abonnés), affichés si le seuil sert ou a servi.
  const minF = s.settings.minFollowers ?? 0;
  const small = s.run.totalSmall ?? 0;
  $('stat-small').hidden = !minF && !small;
  $('total-small').textContent = String(small);
  const th = $('threshold-line');
  th.hidden = !minF;
  th.textContent = minF ? `Seuil actif : seulement les comptes à ${fmtFollowers(minF)} abonnés ou plus.` : '';
  $('resume-line').textContent = resumeLabel(s);

  const err = $('error');
  if (s.run.lastError) {
    err.hidden = false;
    err.textContent = s.run.lastError;
  } else {
    err.hidden = true;
    err.textContent = '';
  }

  const btn = $('btn-toggle') as HTMLButtonElement;
  if (s.run.running && s.queue.length > 0) {
    btn.textContent = 'Pause';
    btn.dataset.mode = 'pause';
    btn.disabled = false;
  } else if (s.queue.length > 0) {
    btn.textContent = 'Démarrer';
    btn.dataset.mode = 'start';
    btn.disabled = false;
  } else {
    btn.textContent = 'File vide — ouvrir l’aperçu';
    btn.dataset.mode = 'preview';
    btn.disabled = false;
  }
}

$('btn-toggle').addEventListener('click', async () => {
  const btn = $('btn-toggle') as HTMLButtonElement;
  const mode = btn.dataset.mode;
  if (mode === 'pause') await sendMessage({ type: 'PAUSE_QUEUE' });
  else if (mode === 'start') await sendMessage({ type: 'RESUME_QUEUE' });
  else {
    chrome.tabs.create({ url: chrome.runtime.getURL('preview.html') });
    return;
  }
  await refresh();
});

void refresh();
setInterval(() => void refresh(), 30_000);
// Compte à rebours : tic chaque seconde, uniquement tant que le popup est ouvert.
setInterval(renderLive, 1000);
// À la fermeture, le badge revient au nombre restant.
window.addEventListener('pagehide', () => {
  if (!lastStatus) return;
  const p = computeProgress(lastStatus.run, lastStatus.queue.length, lastStatus.settings);
  try {
    void chrome.action?.setBadgeText({ text: badgeFor(p).text });
  } catch {
    /* ignore */
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.run || changes.queue || changes.settings)) void refresh();
});
