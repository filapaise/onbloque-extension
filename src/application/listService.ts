import { parseListBody, MAX_BODY_BYTES } from '../domain/listParse.ts';
import type { BlockList } from '../domain/types.ts';
import { savePartial } from '../infra/storage.ts';

export async function loadBundledSeed(): Promise<{ list: BlockList; warnings: string[] }> {
  const url = chrome.runtime.getURL('lists/seed.json');
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Impossible de charger la liste embarquée (${res.status}).`);
  const text = await res.text();
  return parseListBody(text, 'Liste embarquée');
}

const BUILTIN_LIST_ORIGINS = new Set([
  'https://x.com',
  'https://twitter.com',
]);

export async function ensureListHostPermission(listUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(listUrl);
  } catch {
    throw new Error('URL de liste invalide.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Seules les URL https sont acceptées pour la liste.');
  }
  const origin = url.origin;
  if (BUILTIN_LIST_ORIGINS.has(origin)) return;
  const have = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (have) return;
  throw new Error(
    `Permission manquante pour ${origin}. Ouvrez les réglages → Avancé, enregistrez l’URL puis « Mettre à jour ».`,
  );
}

export async function fetchRemoteList(listUrl: string): Promise<{ list: BlockList; warnings: string[] }> {
  if (!listUrl) throw new Error('Aucune URL de liste configurée.');
  await ensureListHostPermission(listUrl);
  let url: URL;
  try {
    url = new URL(listUrl);
  } catch {
    throw new Error('URL de liste invalide.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('Seules les URL https sont acceptées pour la liste.');
  }
  const res = await fetch(url.toString(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Téléchargement échoué (${res.status}).`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (ct && !/(json|csv|text|javascript|xml)/.test(ct)) {
    throw new Error(`Type de contenu non supporté (${ct}).`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error('Liste trop volumineuse (> 2 Mo).');
    return parseListBody(text, url.hostname);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        reader.cancel().catch(() => undefined);
        throw new Error('Liste trop volumineuse (> 2 Mo).');
      }
      chunks.push(value);
    }
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    merged.set(c, off);
    off += c.byteLength;
  }
  const text = new TextDecoder('utf-8').decode(merged);
  return parseListBody(text, url.hostname);
}

export async function persistList(
  list: BlockList,
  source: 'seed' | 'url' | 'import' | 'paste',
): Promise<void> {
  await savePartial({
    list,
    listSource: source,
    listFetchedAt: Date.now(),
  });
}
