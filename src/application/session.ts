/**
 * Contexte x.com partagé par l'aperçu et la file : onglet, CSRF, opérations
 * GraphQL, et identité du compte connecté (mise en cache 10 min, invalidée si
 * le cookie twid change).
 */

import { XApiError } from '../domain/errors.ts';
import { handleFromHref } from '../domain/handle.ts';
import { createOperationSource } from '../infra/graphqlOps.ts';
import {
  collectPageScriptUrls,
  ensureXTab,
  makeTabFetch,
  readSessionHints,
  requireXTab,
} from '../infra/tabFetch.ts';
import { identifySelf, parseTwid, type SelfAccount, type XClientState, type XContext } from '../infra/xClient.ts';

const SELF_TTL = 10 * 60_000;
const clientState: XClientState = { lookupGone: false };
let cachedSelf: (SelfAccount & { at: number }) | null = null;

export interface XSession {
  ctx: XContext;
  hints: { twidId: string | null; profileHandle: string | null };
}

/**
 * `background: true` (file d'attente) : un onglet x.com déchargé est rechargé,
 * et s'il n'y en a aucun, un onglet x.com est ouvert en arrière-plan.
 */
export async function openXSession(opts: { background?: boolean } = {}): Promise<XSession & { tabOpened?: boolean; tabReloaded?: boolean }> {
  let tabId: number;
  let tabOpened = false;
  let tabReloaded = false;
  if (opts.background) {
    const t = await ensureXTab();
    tabId = t.tabId;
    tabOpened = t.opened;
    tabReloaded = t.reloaded;
  } else {
    tabId = await requireXTab();
  }
  const raw = await readSessionHints(tabId);
  if (!raw.csrf) throw new XApiError('not-logged-in', 0, 'not-logged-in');
  const fetchFn = makeTabFetch(tabId);
  return {
    ctx: {
      fetchFn,
      csrf: raw.csrf,
      ops: createOperationSource(fetchFn, () => collectPageScriptUrls(tabId)),
      state: clientState,
    },
    hints: { twidId: parseTwid(raw.twid), profileHandle: handleFromHref(raw.profileHref) },
    tabOpened,
    tabReloaded,
  };
}

/** Compte connecté, ou erreur `self-unknown` (aucune action sans lui). */
export async function getSelf(session: XSession): Promise<SelfAccount> {
  const twid = session.hints.twidId;
  if (
    cachedSelf &&
    Date.now() - cachedSelf.at < SELF_TTL &&
    (!twid || twid === cachedSelf.id)
  ) {
    return { id: cachedSelf.id, handle: cachedSelf.handle };
  }
  const self = await identifySelf(session.ctx, session.hints);
  if (!self) {
    cachedSelf = null;
    throw new XApiError('self-unknown', 0, 'self-unknown');
  }
  cachedSelf = { ...self, at: Date.now() };
  return self;
}

/** Dernière identité connue, sans réseau (affichage). */
export function peekSelf(): SelfAccount | null {
  if (!cachedSelf || Date.now() - cachedSelf.at >= SELF_TTL) return null;
  return { id: cachedSelf.id, handle: cachedSelf.handle };
}
