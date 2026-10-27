import type { BlockList, ListEntry } from './types.ts';
import { dedupeEntries, HANDLE_RE, NUMERIC_ID_RE, parseAccountRef } from './handle.ts';

export const MAX_ENTRIES = 20_000;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_NAME_LEN = 100;
export const MAX_META_LEN = 200;


function looksLikeJson(text: string): boolean {
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[');
}

function parseCsv(text: string): ListEntry[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) return [];
  const header = lines[0]!.split(/[,;\t]/).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ''));
  const hasHeader =
    header.includes('screen_name') ||
    header.includes('handle') ||
    header.includes('username') ||
    header.includes('id') ||
    header.includes('user_id') ||
    header.includes('id_str');
  const cols = hasHeader ? header : [];
  const start = hasHeader ? 1 : 0;
  const out: ListEntry[] = [];
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    if (cols.length) {
      const get = (...names: string[]) => {
        for (const n of names) {
          const idx = cols.indexOf(n);
          if (idx >= 0 && cells[idx]) return cells[idx]!.trim().replace(/^"|"$/g, '');
        }
        return '';
      };
      const handleRaw = get('screen_name', 'handle', 'username', 'user', 'account');
      const idRaw = get('id_str', 'user_id', 'id');
      const name = get('name') || undefined;
      const entry: ListEntry = {};
      if (idRaw && NUMERIC_ID_RE.test(idRaw)) entry.id = idRaw;
      if (handleRaw) {
        const p = parseAccountRef(handleRaw, { numericIsId: false });
        if (p?.handle) entry.handle = p.handle;
      }
      if (name) entry.name = name;
      if (entry.id || entry.handle) out.push(entry);
    } else {
      const p = parseAccountRef(cells[0] ?? '');
      if (p) out.push(p);
    }
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if ((c === ',' || c === ';' || c === '\t') && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function parseJson(text: string): ListEntry[] {
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) {
    return data.flatMap((item) => entryFromUnknown(item));
  }
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const arr =
      (Array.isArray(obj.entries) && obj.entries) ||
      (Array.isArray(obj.accounts) && obj.accounts) ||
      (Array.isArray(obj.users) && obj.users) ||
      (Array.isArray(obj.list) && obj.list) ||
      null;
    if (arr) return arr.flatMap((item) => entryFromUnknown(item));
  }
  throw new Error('JSON non reconnu : attendu un tableau ou un objet { entries: [...] }.');
}

function entryFromUnknown(item: unknown): ListEntry[] {
  if (typeof item === 'string') {
    const p = parseAccountRef(item);
    return p ? [p] : [];
  }
  if (!item || typeof item !== 'object') return [];
  const o = item as Record<string, unknown>;
  const entry: ListEntry = {};
  const id = o.id_str ?? o.user_id ?? o.id;
  if (typeof id === 'string' || typeof id === 'number') {
    const s = String(id);
    if (NUMERIC_ID_RE.test(s)) entry.id = s;
  }
  const handle = o.screen_name ?? o.handle ?? o.username ?? o.user ?? o.account;
  if (typeof handle === 'string') {
    const p = parseAccountRef(handle, { numericIsId: false });
    if (p?.handle) entry.handle = p.handle;
  }
  if (typeof o.name === 'string') entry.name = o.name;
  if (typeof o.category === 'string') entry.category = o.category;
  if (typeof o.source === 'string') entry.source = o.source;
  return entry.id || entry.handle ? [entry] : [];
}

function parsePlainText(text: string): ListEntry[] {
  const out: ListEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
    const first = trimmed.split(/[\s,;]+/)[0] ?? '';
    const p = parseAccountRef(first);
    if (p) out.push(p);
  }
  return out;
}

/**
 * Parse un corps de liste (JSON onbloque-list/1, JSON générique, CSV, ou texte un @/id par ligne).
 * Retourne aussi les métadonnées si présentes.
 */
export function parseListBody(text: string, fallbackName = 'Liste importée'): {
  list: BlockList;
  warnings: string[];
} {
  const warnings: string[] = [];
  let entries: ListEntry[] = [];
  let meta: Partial<BlockList> = { name: fallbackName };

  const trimmed = text.trim();
  if (!trimmed) {
    return {
      list: { format: 'onbloque-list/1', name: fallbackName, entries: [] },
      warnings: ['Liste vide.'],
    };
  }

  if (looksLikeJson(trimmed)) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      if (data && typeof data === 'object' && !Array.isArray(data) && data.format === 'onbloque-list/1') {
        meta = {
          format: 'onbloque-list/1',
          name: typeof data.name === 'string' ? data.name : fallbackName,
          description: typeof data.description === 'string' ? data.description : undefined,
          source_url: typeof data.source_url === 'string' ? data.source_url : undefined,
          updated: typeof data.updated === 'string' ? data.updated : undefined,
        };
        entries = parseJson(trimmed);
      } else {
        entries = parseJson(trimmed);
      }
    } catch (e) {
      warnings.push(`JSON invalide (${(e as Error).message}), tentative en texte brut.`);
      entries = parsePlainText(trimmed);
    }
  } else if (/,|;/.test(trimmed.split(/\r?\n/, 1)[0] ?? '') && /screen_name|handle|username|user_id|id_str/i.test(trimmed.slice(0, 200))) {
    entries = parseCsv(trimmed);
  } else if (/,|;/.test(trimmed.split(/\r?\n/, 1)[0] ?? '') && trimmed.split(/\r?\n/).length > 1) {
    entries = parseCsv(trimmed);
  } else {
    entries = parsePlainText(trimmed);
  }

  const before = entries.length;
  entries = dedupeEntries(
    entries.filter((e) => {
      if (e.handle && !HANDLE_RE.test(e.handle)) return false;
      if (e.id && !NUMERIC_ID_RE.test(e.id)) return false;
      return !!(e.handle || e.id);
    }),
  );
  if (entries.length < before) {
    warnings.push(`${before - entries.length} entrée(s) invalide(s) ou en doublon retirée(s).`);
  }
  if (entries.length > MAX_ENTRIES) {
    warnings.push(`Liste tronquée à ${MAX_ENTRIES} entrées.`);
    entries = entries.slice(0, MAX_ENTRIES);
  }
  entries = entries.map((e) => ({
    ...e,
    name: e.name?.slice(0, MAX_NAME_LEN),
    category: e.category?.slice(0, MAX_META_LEN),
    source: e.source?.slice(0, MAX_META_LEN),
  }));

  return {
    list: {
      format: 'onbloque-list/1',
      name: (meta.name ?? fallbackName).slice(0, MAX_NAME_LEN),
      description: meta.description,
      source_url: meta.source_url,
      updated: meta.updated,
      entries,
    },
    warnings,
  };
}

export function listToJson(list: BlockList): string {
  return JSON.stringify({ ...list, format: 'onbloque-list/1' }, null, 2);
}
