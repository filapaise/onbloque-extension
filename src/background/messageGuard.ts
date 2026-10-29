import { HANDLE_RE, NUMERIC_ID_RE, parseAccountRef, entryKey } from '../domain/handle.ts';
import { parseListBody } from '../domain/listParse.ts';
import type { ListEntry, BlockList } from '../domain/types.ts';
import type { Msg } from '../shared/messages.ts';
import type { FabPos } from '../content/fabPosition.ts';

/**
 * GET_PROGRESS ne renvoie que des compteurs (aucun @, aucune liste, aucun réglage).
 * 1.3.2 — GET_FAB_POS / SET_FAB_POS : seule la position du bouton (2 nombres bornés).
 */
export const CONTENT_ALLOWED_TYPES = ['OPEN_PREVIEW', 'GET_PROGRESS', 'PING', 'GET_FAB_POS', 'SET_FAB_POS'] as const;
const CONTENT_ALLOWED = new Set<string>(CONTENT_ALLOWED_TYPES);

export function isContentAllowed(type: string): boolean {
  return CONTENT_ALLOWED.has(type);
}

export function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const url = sender.url || '';
  const base = chrome.runtime.getURL('');
  return url.startsWith(base);
}

export function isContentScript(sender: chrome.runtime.MessageSender): boolean {
  if (!sender.tab) return false;
  try {
    const host = new URL(sender.url || sender.tab.url || '').hostname;
    return host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com');
  } catch {
    return false;
  }
}

export function assertSenderAllowed(msg: Msg, sender: chrome.runtime.MessageSender): void {
  if (sender.id && sender.id !== chrome.runtime.id) {
    throw new Error('Expéditeur non autorisé.');
  }
  if (isContentScript(sender)) {
    if (!isContentAllowed(msg.type)) {
      throw new Error(`Message ${msg.type} interdit depuis le content script.`);
    }
    return;
  }
  if (!isExtensionPage(sender) && sender.tab) {
    throw new Error('Message refusé (contexte inconnu).');
  }
  // Privileged: must be extension page (popup/options/preview) — no tab, or extension URL
  if (!CONTENT_ALLOWED.has(msg.type) && !isExtensionPage(sender)) {
    // SW-internal or extension page without url in some browsers: allow if no tab
    if (sender.tab) throw new Error('Message privilégié réservé aux pages de l’extension.');
  }
}

export function sanitizeEntries(raw: unknown, cap = 5000): ListEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: ListEntry[] = [];
  for (const item of raw.slice(0, cap)) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const entry: ListEntry = {};
    if (typeof o.id === 'string' && NUMERIC_ID_RE.test(o.id)) entry.id = o.id;
    if (typeof o.handle === 'string') {
      const p = parseAccountRef(o.handle, { numericIsId: false });
      if (p?.handle && HANDLE_RE.test(p.handle)) entry.handle = p.handle;
    }
    if (typeof o.name === 'string') entry.name = o.name.slice(0, 100);
    if (typeof o.source === 'string') entry.source = o.source.slice(0, 200);
    if (entry.id || entry.handle) out.push(entry);
  }
  return out;
}

export function sanitizeList(raw: unknown): BlockList {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const text = JSON.stringify(raw);
    const { list } = parseListBody(text, 'import');
    return list;
  }
  throw new Error('Liste invalide.');
}

export function sanitizeQueueItems(
  items: unknown,
): Array<{ handle?: string; id?: string }> {
  return sanitizeEntries(items, 2000).map((e) => ({ handle: e.handle, id: e.id }));
}

export function filterAgainstWhitelist(
  items: Array<{ handle?: string; id?: string }>,
  whitelist: ListEntry[],
  self: { id?: string; handle?: string } | null,
): Array<{ handle?: string; id?: string }> {
  const banned = new Set<string>();
  for (const w of whitelist) {
    const k = entryKey(w);
    if (k) banned.add(k);
    if (w.id) banned.add(`id:${w.id}`);
    if (w.handle) banned.add(`h:${w.handle.toLowerCase()}`);
  }
  if (self?.id) banned.add(`id:${self.id}`);
  if (self?.handle) banned.add(`h:${self.handle.toLowerCase()}`);
  return items.filter((it) => {
    const keys = [it.id ? `id:${it.id}` : '', it.handle ? `h:${it.handle.toLowerCase()}` : ''].filter(Boolean);
    return !keys.some((k) => banned.has(k));
  });
}

/**
 * Comptes à mettre dans l'aperçu ouvert depuis x.com.
 * - mode « list » : la liste stockée (le content script n'a aucun accès en lecture) ;
 * - sinon : les comptes collectés sur la page, nettoyés et plafonnés.
 */
export function previewEntriesFor(
  msg: { mode?: 'list' | 'entries'; entries?: unknown },
  stored: BlockList | null,
): ListEntry[] {
  if (msg.mode === 'list') {
    if (!stored || stored.entries.length === 0) {
      throw new Error('Aucune liste chargée. Ouvrez les options de l’extension pour en importer une.');
    }
    return stored.entries;
  }
  const entries = sanitizeEntries(msg.entries, 2000);
  if (!entries.length) throw new Error('Aucun compte valide à prévisualiser.');
  return entries;
}

/** Décalage maximal accepté pour le bouton x.com (px depuis le coin bas-droit). */
export const MAX_FAB_OFFSET = 10_000;

/**
 * 1.3.2 — Valide la position envoyée par le content script (SET_FAB_POS) :
 * exactement deux nombres finis, entre 0 et MAX_FAB_OFFSET, arrondis. Sinon erreur.
 */
export function sanitizeFabPos(raw: unknown): FabPos {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Position invalide.');
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_FAB_OFFSET;
  if (!ok(r.right) || !ok(r.bottom)) throw new Error('Position invalide.');
  return { right: Math.round(r.right), bottom: Math.round(r.bottom) };
}
