import { fmtFollowers } from '../domain/followers.ts';
import { sendMessage } from '../shared/messages.ts';
import type { ListEntry, PreviewRow } from '../domain/types.ts';
import { clear, el } from './dom.ts';
import { liveCounts } from '../domain/preview.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let rows: PreviewRow[] = [];
let sourceEntries: ListEntry[] | null = null;
let precheckNone = false;
let newlyAddedKeys: string[] = [];
let statusCounts: Record<string, number> = {};

const STATUS_LABEL: Record<string, string> = {
  'to-block': 'À bloquer',
  'already-blocked': 'Déjà bloqué',
  whitelisted: 'Liste blanche',
  self: 'Vous',
  following: 'Vous suivez',
  'followed-by': 'Vous suit',
  'not-found': 'Introuvable',
  mismatch: 'Incohérence id/@',
  'relation-unknown': 'Relation inconnue',
};

async function loadFromToken(): Promise<void> {
  const k = new URLSearchParams(location.search).get('k');
  if (!k) {
    // Clear stale session entries
    await chrome.storage.session.remove(['previewEntries', 'previewLabel']);
    const st = await sendMessage({ type: 'GET_LIST' });
    if (st.ok && 'list' in st && st.list) sourceEntries = st.list.entries;
    const added = (await chrome.storage.session.get('lastAddedKeys')) as { lastAddedKeys?: string[] };
    newlyAddedKeys = added.lastAddedKeys ?? [];
    return;
  }
  const data = (await chrome.storage.session.get(`preview:${k}`)) as Record<
    string,
    { entries?: ListEntry[]; label?: string; precheckNone?: boolean } | undefined
  >;
  const payload = data[`preview:${k}`];
  if (payload?.entries) {
    sourceEntries = payload.entries;
    precheckNone = !!payload.precheckNone;
    if (payload.label) $('source-label').textContent = `Source : ${payload.label}`;
  }
  await chrome.storage.session.remove(`preview:${k}`);
}

async function refresh(): Promise<void> {
  const exclude = ($('exclude-following') as HTMLInputElement).checked;
  $('source-label').textContent = 'Chargement de l’aperçu…';
  const resp = await sendMessage({
    type: 'BUILD_PREVIEW',
    entries: sourceEntries ?? undefined,
    excludeFollowingByDefault: exclude,
    precheckNone,
    newlyAddedKeys,
  });
  if (!resp.ok || !('preview' in resp)) {
    $('source-label').textContent = 'Aperçu indisponible.';
    showMsg(('error' in resp ? resp.error : null) || 'Erreur', true);
    ($('btn-start') as HTMLButtonElement).disabled = true;
    return;
  }
  if (resp.preview.abortReason) {
    $('source-label').textContent = 'Aperçu indisponible.';
    showMsg(resp.preview.abortReason, true);
    rows = [];
    statusCounts = {};
    renderTable();
    ($('btn-start') as HTMLButtonElement).disabled = true;
    return;
  }
  rows = resp.preview.rows;
  statusCounts = resp.preview.counts;
  if (resp.preview.notes.length) showMsg(resp.preview.notes.join(' '));
  else hideMsg();
  $('source-label').textContent = resp.preview.sessionOk
    ? `Connecté${resp.preview.self?.handle ? ` en @${resp.preview.self.handle}` : ''} — cochez puis démarrez.`
    : 'Session x.com non détectée.';
  renderTable();
}

function checkedKeys(): Set<string> {
  const boxes = Array.from(
    document.querySelectorAll<HTMLInputElement>('#table tbody input[type=checkbox]:checked:not(:disabled)'),
  );
  return new Set(boxes.map((b) => b.dataset.key!));
}

/** Recalcule les compteurs depuis l'état réel des cases (à chaque changement). */
function renderCounts(): void {
  const box = $('counts');
  clear(box);
  const live = liveCounts(rows, checkedKeys());
  box.appendChild(el('span', { text: `Cochés : ${live.selected}` }));
  if (live.toBlockTotal > 0) {
    box.appendChild(el('span', { text: `À bloquer : ${live.toBlockChecked} / ${live.toBlockTotal}` }));
  }
  for (const [k, label] of [
    ['not-found', 'Introuvables'],
    ['mismatch', 'Incohérents'],
    ['already-blocked', 'Déjà bloqués'],
    ['whitelisted', 'Liste blanche'],
    ['following', 'Suivis'],
    ['followed-by', 'Abonnés'],
    ['self', 'Vous'],
  ] as const) {
    const n = statusCounts[k] ?? 0;
    if (n === 0) continue;
    box.appendChild(el('span', { text: `${label} : ${n}` }));
  }
}

function renderTable(): void {
  const tbody = $('table').querySelector('tbody')!;
  clear(tbody);
  for (const r of rows) {
    const disabled =
      r.status === 'self' ||
      r.status === 'whitelisted' ||
      r.status === 'already-blocked' ||
      r.status === 'mismatch';
    const tr = el('tr');
    const tdCheck = el('td');
    const cb = el('input', {
      type: 'checkbox',
      'data-key': r.key,
      ...(r.checked ? { checked: true } : {}),
      ...(disabled ? { disabled: true } : {}),
    });
    tdCheck.appendChild(cb);
    const tdAcct = el('td');
    const strong = el('strong', {
      text: r.handle ? `@${r.handle}` : r.id ? `id:${r.id}` : '?',
    });
    tdAcct.appendChild(strong);
    if (r.id) tdAcct.appendChild(el('div', { className: 'muted', text: `id ${r.id}` }));
    if (r.name) tdAcct.appendChild(el('div', { className: 'muted', text: r.name }));
    for (const w of r.warnings) tdAcct.appendChild(el('div', { className: 'muted', text: w }));
    const tdStatus = el('td', {
      className: `status ${r.status}`,
      text: `${STATUS_LABEL[r.status] ?? r.status}${r.category ? ` · ${r.category}` : ''}`,
    });
    const tdSrc = el('td', { className: 'muted', text: r.source ? truncate(r.source, 48) : '—' });
    tr.append(tdCheck, tdAcct, tdStatus, tdSrc);
    tbody.appendChild(tr);
  }
  updateStartEnabled();
}

function selectedItems(): Array<{ handle?: string; id?: string }> {
  const keys = checkedKeys();
  return rows.filter((r) => keys.has(r.key)).map((r) => ({ handle: r.handle, id: r.id }));
}

function updateStartEnabled(): void {
  ($('btn-start') as HTMLButtonElement).disabled = selectedItems().length === 0;
  renderCounts();
}

function showMsg(text: string, err = false): void {
  const eln = $('msg');
  eln.hidden = false;
  eln.textContent = text;
  eln.classList.toggle('err', err);
}

function hideMsg(): void {
  $('msg').hidden = true;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

$('table').addEventListener('change', (e) => {
  if ((e.target as HTMLElement).matches('input[type=checkbox]')) updateStartEnabled();
});
$('btn-all').addEventListener('click', () => {
  document
    .querySelectorAll<HTMLInputElement>('#table tbody input[type=checkbox]:not(:disabled)')
    .forEach((b) => {
      b.checked = true;
    });
  updateStartEnabled();
});
$('btn-none').addEventListener('click', () => {
  document.querySelectorAll<HTMLInputElement>('#table tbody input[type=checkbox]').forEach((b) => {
    b.checked = false;
  });
  updateStartEnabled();
});
$('exclude-following').addEventListener('change', () => void refresh());
$('btn-reload').addEventListener('click', () => void refresh());
$('btn-start').addEventListener('click', async () => {
  const items = selectedItems();
  if (!items.length) return;
  if (
    !confirm(
      `Mettre en file d'attente ${items.length} compte(s) à bloquer ?\nLe blocage partira en arrière-plan avec le plafond et les délais.`,
    )
  )
    return;
  const resp = await sendMessage({ type: 'START_QUEUE', items, action: 'block' });
  if (resp.ok && 'added' in resp) {
    showMsg(`${resp.added} compte(s) en file (${resp.queueLength} au total).`);
  } else showMsg(('error' in resp ? resp.error : null) || 'Erreur', true);
});
$('btn-whitelist').addEventListener('click', async () => {
  const items = selectedItems();
  if (!items.length) return;
  await sendMessage({ type: 'ADD_WHITELIST', entries: items });
  showMsg(`${items.length} compte(s) ajouté(s) à la liste blanche.`);
  await refresh();
});

void (async () => {
  await loadFromToken();
  await refresh();
})();

/* 1.3.0 — rappel du seuil d'abonnés : les cochés sous le seuil seront passés, pas bloqués. */
void (async () => {
  const resp = await sendMessage({ type: 'GET_SETTINGS' });
  const min = resp.ok && 'settings' in resp ? resp.settings.minFollowers ?? 0 : 0;
  const note = document.getElementById('threshold-note');
  if (!note || !min) return;
  note.hidden = false;
  note.textContent = `Seuil actif : seuls les comptes à ${fmtFollowers(min)} abonnés ou plus seront bloqués, les autres cochés seront passés. Modifiable dans Options.`;
})();
