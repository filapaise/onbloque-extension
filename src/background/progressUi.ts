/**
 * Badge de l'icône + résumé de progression poussé aux onglets x.com.
 * Déclenché par les changements de stockage (run/queue) et par les alarmes :
 * aucun minuteur périodique ne garde le service worker éveillé.
 */
import { badgeFor, computeProgress, fabProgressOf, type FabProgress } from '../domain/progress.ts';
import { loadStore } from '../infra/storage.ts';

export const PROGRESS_PUSH_TYPE = 'ONBLOQUE_PROGRESS';

let lastBadge = '';
let lastFab = '';

export async function currentFabProgress(): Promise<FabProgress> {
  const store = await loadStore();
  return fabProgressOf(computeProgress(store.run, store.queue.length, store.settings));
}

export async function refreshProgressUi(): Promise<void> {
  const store = await loadStore();
  const p = computeProgress(store.run, store.queue.length, store.settings);
  const badge = badgeFor(p);
  const sig = JSON.stringify(badge);
  if (sig !== lastBadge) {
    lastBadge = sig;
    try {
      await chrome.action.setBadgeBackgroundColor({ color: badge.color });
      await chrome.action.setBadgeText({ text: badge.text });
      await chrome.action.setTitle({ title: badge.title });
    } catch {
      /* action indisponible */
    }
  }
  const fab = fabProgressOf(p);
  const fabSig = JSON.stringify({ ...fab, pct: Math.round(fab.pct * 1000) });
  if (fabSig === lastFab) return;
  lastFab = fabSig;
  await pushToXTabs(fab);
}

async function pushToXTabs(progress: FabProgress): Promise<void> {
  let tabs: chrome.tabs.Tab[] = [];
  try {
    tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  } catch {
    return;
  }
  for (const t of tabs) {
    if (typeof t.id !== 'number') continue;
    try {
      // Uniquement des compteurs (aucun @, aucune liste) vers le content script.
      await chrome.tabs.sendMessage(t.id, { type: PROGRESS_PUSH_TYPE, progress });
    } catch {
      /* onglet sans content script (pas encore chargé) */
    }
  }
}
