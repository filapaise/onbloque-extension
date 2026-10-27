import { sendMessage, type StatusSnapshot } from '../shared/messages.ts';
import { fmtRelative } from './format.ts';

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
  render(resp.status);
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
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.run || changes.queue || changes.settings)) void refresh();
});
