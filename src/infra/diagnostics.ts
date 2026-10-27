/**
 * Journal de diagnostic (Options › Diagnostic + console du service worker).
 * Contient : heure, étape, endpoint (sans paramètres), code HTTP, code d'erreur.
 * JAMAIS de cookie, de jeton CSRF, d'en-tête ni d'URL complète.
 */

import { sanitizeErrorBody } from '../domain/errors.ts';

export interface DiagEntry {
  at: number;
  step: string;
  endpoint?: string;
  status?: number;
  code?: string;
  note?: string;
}

export const DIAG_KEY = 'diagnostics';
const MAX = 80;

/** Garde uniquement un libellé d'endpoint court, sans query string. */
export function safeEndpoint(label: string | undefined): string | undefined {
  if (!label) return undefined;
  return sanitizeErrorBody(label.split('?')[0]!).replace(/https?:\/\/[^\s]+/g, (u) => {
    try {
      return new URL(u).pathname;
    } catch {
      return '';
    }
  }).slice(0, 80);
}

export function makeDiag(e: Omit<DiagEntry, 'at'>, now = Date.now()): DiagEntry {
  return {
    at: now,
    step: e.step.slice(0, 40),
    endpoint: safeEndpoint(e.endpoint),
    status: typeof e.status === 'number' ? e.status : undefined,
    code: e.code?.slice(0, 40),
    note: e.note ? sanitizeErrorBody(e.note).slice(0, 120) : undefined,
  };
}

export async function recordDiag(e: Omit<DiagEntry, 'at'>): Promise<void> {
  const entry = makeDiag(e);
  try {
    console.warn('[OnBloque]', entry.step, entry.endpoint ?? '', entry.status ?? '', entry.code ?? '', entry.note ?? '');
  } catch {
    /* ignore */
  }
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  const data = (await chrome.storage.local.get(DIAG_KEY)) as { diagnostics?: DiagEntry[] };
  const next = [entry, ...(data.diagnostics ?? [])].slice(0, MAX);
  await chrome.storage.local.set({ [DIAG_KEY]: next });
}

export async function loadDiag(): Promise<DiagEntry[]> {
  const data = (await chrome.storage.local.get(DIAG_KEY)) as { diagnostics?: DiagEntry[] };
  return Array.isArray(data.diagnostics) ? data.diagnostics : [];
}

export async function clearDiag(): Promise<void> {
  await chrome.storage.local.set({ [DIAG_KEY]: [] });
}
