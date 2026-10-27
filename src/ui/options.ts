import { parseListBody } from '../domain/listParse.ts';
import { parseAccountRef, entryKeys } from '../domain/handle.ts';
import type { PacePreset, Settings } from '../domain/types.ts';
import { delayAdjustNote, describePace, parseDelayInput } from '../domain/presets.ts';
import type { ListEntry } from '../domain/types.ts';
import { sendMessage } from '../shared/messages.ts';
import { fmtTime } from './format.ts';
import { ensureListHostFromUi } from './listHost.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(text = 'Enregistré'): void {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  el.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    el.hidden = true;
  }, 1600);
}

function setPaceUI(pace: PacePreset): void {
  document.querySelectorAll<HTMLButtonElement>('#pace .seg').forEach((btn) => {
    const on = btn.dataset.pace === pace;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('active', on);
  });
}

function renderPace(settings: Settings): void {
  setPaceUI(settings.pace ?? 'prudent');
  $('pace-desc').textContent = describePace(settings);
  const min = $('delay-min') as HTMLInputElement;
  const max = $('delay-max') as HTMLInputElement;
  // Ne pas écraser une saisie en cours.
  if (document.activeElement !== min) min.value = String(settings.minDelaySec);
  if (document.activeElement !== max) max.value = String(settings.maxDelaySec);
}

function delayMsg(text: string, err = false): void {
  const el = $('delay-msg');
  el.hidden = !text;
  el.textContent = text;
  el.classList.toggle('err', err);
}

async function saveDelays(): Promise<void> {
  const minIn = parseDelayInput(($('delay-min') as HTMLInputElement).value);
  const maxIn = parseDelayInput(($('delay-max') as HTMLInputElement).value);
  if (!Number.isFinite(minIn) || !Number.isFinite(maxIn)) {
    delayMsg('Entrez deux nombres de secondes.', true);
    return;
  }
  const resp = await sendMessage({
    type: 'SET_SETTINGS',
    settings: { customDelay: true, minDelaySec: minIn, maxDelaySec: maxIn },
  });
  if (!resp.ok || !('settings' in resp)) {
    delayMsg(('error' in resp ? resp.error : null) || 'Échec', true);
    return;
  }
  ($('delay-min') as HTMLInputElement).value = String(resp.settings.minDelaySec);
  ($('delay-max') as HTMLInputElement).value = String(resp.settings.maxDelaySec);
  renderPace(resp.settings);
  const note = delayAdjustNote(minIn, maxIn, resp.settings);
  delayMsg(note || 'Délais appliqués.', false);
  toast();
}

$('btn-delay-save').addEventListener('click', () => void saveDelays());
for (const id of ['delay-min', 'delay-max']) {
  $(id).addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') void saveDelays();
  });
}

async function load(): Promise<void> {
  const st = await sendMessage({ type: 'GET_STATUS' });
  if (!st.ok || !('status' in st)) return;
  const s = st.status;
  renderPace(s.settings);
  ($('list-url') as HTMLInputElement).value = s.settings.listUrl || '';

  if (s.list) {
    $('list-name').textContent = s.list.name;
    $('list-meta').textContent = `${s.list.entries.length} comptes · maj ${fmtTime(s.listFetchedAt)}`;
  } else {
    $('list-name').textContent = 'Aucune liste';
    $('list-meta').textContent = 'Importez-en une dans Avancé, ou mettez à jour.';
  }

  renderWhitelist(s.whitelist);
  $('history-line').textContent =
    `${s.run.totalDone} bloqués · ${s.run.totalSkipped} ignorés · ${s.blockedByExt.length} par l’extension`;
}

function renderWhitelist(list: ListEntry[]): void {
  const box = $('wl-chips');
  while (box.firstChild) box.removeChild(box.firstChild);
  if (!list.length) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.textContent = 'Aucun compte ajouté';
    box.appendChild(empty);
    return;
  }
  for (const e of list) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    const label = e.handle ? `@${e.handle}` : e.id ? `id:${e.id}` : '?';
    const span = document.createElement('span');
    span.textContent = label;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    chip.append(span, x);
    chip.title = 'Retirer';
    chip.addEventListener('click', async () => {
      await sendMessage({ type: 'REMOVE_WHITELIST', keys: entryKeys(e) });
      toast();
      await load();
    });
    box.appendChild(chip);
  }
}

document.querySelectorAll<HTMLButtonElement>('#pace .seg').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const pace = btn.dataset.pace as PacePreset;
    setPaceUI(pace);
    // Choisir un preset remet ses délais (les valeurs personnalisées sont effacées).
    const resp = await sendMessage({ type: 'SET_SETTINGS', settings: { pace } });
    if (resp.ok && 'settings' in resp) renderPace(resp.settings);
    delayMsg('');
    toast();
  });
});

$('btn-refresh').addEventListener('click', async () => {
  const listUrl = ($('list-url') as HTMLInputElement).value.trim();
  try {
    await ensureListHostFromUi(listUrl);
  } catch (e) {
    toast((e as Error).message);
    return;
  }
  await sendMessage({ type: 'SET_SETTINGS', settings: { listUrl } });
  const resp = await sendMessage({ type: 'REFRESH_LIST' });
  if (!resp.ok || !('list' in resp) || !resp.list) {
    toast(('error' in resp ? resp.error : null) || 'Échec de mise à jour');
    return;
  }
  const warn = (resp.warnings || []).join('\n');
  if (!confirm(`Appliquer la nouvelle liste (${resp.list.entries.length} comptes) ?\n${warn}`)) {
    toast('Mise à jour annulée');
    return;
  }
  const pending = (await chrome.storage.session.get(['pendingList', 'pendingListSource', 'pendingAddedKeys'])) as {
    pendingList?: typeof resp.list;
    pendingListSource?: 'url' | 'seed';
    pendingAddedKeys?: string[];
  };
  await sendMessage({
    type: 'PREVIEW_DIFF_CONFIRM',
    list: pending.pendingList ?? resp.list,
    source: pending.pendingListSource ?? 'url',
    addedKeys: pending.pendingAddedKeys ?? [],
  });
  toast(`Liste appliquée : ${resp.list.entries.length} comptes`);
  await load();
});

$('list-url').addEventListener('change', async () => {
  await sendMessage({
    type: 'SET_SETTINGS',
    settings: { listUrl: ($('list-url') as HTMLInputElement).value.trim() },
  });
  toast();
});

$('wl-input').addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const input = $('wl-input') as HTMLInputElement;
  const p = parseAccountRef(input.value);
  if (!p) return;
  await sendMessage({ type: 'ADD_WHITELIST', entries: [p] });
  input.value = '';
  toast();
  await load();
});

$('btn-paste').addEventListener('click', async () => {
  const text = ($('paste') as HTMLTextAreaElement).value;
  const { list } = parseListBody(text, 'Collage manuel');
  const resp = await sendMessage({ type: 'SET_LIST', list, source: 'paste' });
  const msg = $('adv-msg');
  if (resp.ok) {
    msg.hidden = false;
    msg.classList.remove('err');
    msg.textContent = `${list.entries.length} comptes importés.`;
    toast();
  } else {
    msg.hidden = false;
    msg.classList.add('err');
    msg.textContent = ('error' in resp ? resp.error : null) || 'Échec';
  }
  await load();
});

$('file').addEventListener('change', async () => {
  const input = $('file') as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  const { list } = parseListBody(text, file.name);
  await sendMessage({ type: 'SET_LIST', list, source: 'import' });
  input.value = '';
  toast(`Fichier : ${list.entries.length} comptes`);
  await load();
});

$('btn-reset').addEventListener('click', async () => {
  if (!confirm('Effacer l’historique local (compteurs, journal, suivi des blocages de l’extension) ? Cela ne débloque personne sur X.')) {
    return;
  }
  await sendMessage({ type: 'RESET_HISTORY' });
  toast('Historique réinitialisé');
  await load();
});

let diagText = '';

async function loadDiagnostics(): Promise<void> {
  const resp = await sendMessage({ type: 'GET_DIAGNOSTICS' });
  const box = $('diag-list');
  while (box.firstChild) box.removeChild(box.firstChild);
  const list = resp.ok && 'diagnostics' in resp ? resp.diagnostics : [];
  diagText = list
    .map((d) => [fmtTime(d.at), d.step, d.endpoint, d.status ? `HTTP ${d.status}` : '', d.code, d.note].filter(Boolean).join(' · '))
    .join('\n');
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Aucune erreur enregistrée.';
    box.appendChild(li);
    return;
  }
  for (const d of list.slice(0, 40)) {
    const li = document.createElement('li');
    const when = document.createElement('strong');
    when.textContent = fmtTime(d.at);
    const rest = document.createElement('span');
    rest.textContent = ` ${[d.step, d.endpoint, d.status ? `HTTP ${d.status}` : '', d.code, d.note].filter(Boolean).join(' · ')}`;
    li.append(when, rest);
    box.appendChild(li);
  }
}

$('btn-diag-refresh').addEventListener('click', () => void loadDiagnostics());
$('btn-diag-clear').addEventListener('click', async () => {
  await sendMessage({ type: 'CLEAR_DIAGNOSTICS' });
  await loadDiagnostics();
  toast('Diagnostic effacé');
});
$('btn-diag-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagText || 'Aucune erreur enregistrée.');
    toast('Copié');
  } catch {
    toast('Copie impossible');
  }
});
$('diag-card').addEventListener('toggle', () => void loadDiagnostics());

void load();
