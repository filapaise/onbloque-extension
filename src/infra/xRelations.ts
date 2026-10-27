/**
 * Relations (vous suivez / vous suit / déjà bloqué) entre le compte connecté
 * et une liste de comptes. friendships/lookup (1.1) en premier ; s'il a
 * disparu, GraphQL : Following (complet, sinon on refuse), Followers (borné)
 * et UsersByRestIds (pour vérifier les couples id ↔ @).
 */

import { XApiError } from '../domain/errors.ts';
import type { Relationship } from '../domain/types.ts';
import {
  fetchUserSet,
  friendshipsLookup,
  usersByRestIds,
  type GqlUser,
  type SelfAccount,
  type UserSet,
  type XContext,
} from './xClient.ts';

const FOLLOWING_MAX_PAGES = 60; // ≈ 6 000 abonnements
const FOLLOWERS_MAX_PAGES = 20; // ≈ 2 000 abonnés
const FOLLOWING_TTL_MS = 5 * 60_000;

export interface RelationsResult {
  map: Map<string, Relationship>;
  source: 'friendships' | 'graphql';
  notes: string[];
}

/** Abonnements du compte connecté, complets ou erreur (garde-fou). */
export async function followingSet(ctx: XContext, self: SelfAccount): Promise<UserSet> {
  const cached = ctx.state.following;
  if (cached && cached.selfId === self.id && Date.now() - cached.at < FOLLOWING_TTL_MS) return cached.set;
  let set: UserSet;
  try {
    set = await fetchUserSet(ctx, 'Following', self.id, FOLLOWING_MAX_PAGES);
  } catch (e) {
    if (e instanceof XApiError && (e.code === 'rate-limit' || e.code === 'not-logged-in')) throw e;
    throw new XApiError('Following indisponible', 0, 'guard-unavailable');
  }
  if (!set.complete) {
    throw new XApiError('Following incomplet', 0, 'guard-unavailable');
  }
  ctx.state.following = { selfId: self.id, at: Date.now(), set };
  return set;
}

export interface RelationsOptions {
  /** Lire aussi vos abonnés (statut « vous suit » de l'aperçu). */
  withFollowers: boolean;
  /** Faire confirmer par X chaque couple id ↔ @ de la liste (aperçu). */
  verifyIds: boolean;
}

export async function lookupRelationships(
  ctx: XContext,
  refs: Array<{ handle?: string; id?: string }>,
  self: SelfAccount,
  opts: RelationsOptions,
): Promise<RelationsResult> {
  if (!ctx.state.lookupGone) {
    try {
      return { map: await friendshipsLookup(ctx, refs), source: 'friendships', notes: [] };
    } catch (e) {
      if (!(e instanceof XApiError && e.code === 'endpoint-gone')) throw e;
      ctx.state.lookupGone = true;
    }
  }
  return graphqlRelationships(ctx, refs, self, opts);
}

async function graphqlRelationships(
  ctx: XContext,
  refs: Array<{ handle?: string; id?: string }>,
  self: SelfAccount,
  opts: RelationsOptions,
): Promise<RelationsResult> {
  const notes = [
    'Relations lues via GraphQL : « déjà bloqué » n’est connu que pour les comptes bloqués par l’extension ou repérés par X.',
  ];
  const following = await followingSet(ctx, self);

  let followers: UserSet | null = null;
  if (opts.withFollowers) {
    try {
      followers = await fetchUserSet(ctx, 'Followers', self.id, FOLLOWERS_MAX_PAGES);
      if (!followers.complete) {
        notes.push('Liste de vos abonnés partielle : « vous suit » peut manquer pour certains comptes.');
      }
    } catch (e) {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      notes.push('Vos abonnés n’ont pas pu être lus : « vous suit » n’est pas indiqué.');
    }
  }

  const ids = opts.verifyIds ? refs.map((r) => r.id).filter((x): x is string => !!x) : [];
  let byId = new Map<string, GqlUser>();
  if (ids.length) {
    try {
      byId = await usersByRestIds(ctx, ids);
    } catch (e) {
      if (e instanceof XApiError && e.code === 'rate-limit') throw e;
      // Sans vérification id ↔ @, l'aperçu pourrait bloquer le mauvais compte.
      throw new XApiError('UsersByRestIds indisponible', 0, 'resolver-failed');
    }
  }

  const map = new Map<string, Relationship>();
  for (const ref of refs) {
    const u = ref.id ? byId.get(ref.id) : undefined;
    if (u?.kind === 'unavailable') continue;
    if (opts.verifyIds && ref.id && !u) continue; // id inconnu de X
    const handle = u?.kind === 'user' ? u.handle : ref.handle;
    const lower = handle?.toLowerCase();
    const id = ref.id ?? (lower ? following.handles.get(lower) ?? followers?.handles.get(lower) : undefined);
    const inSet = (s: UserSet | null) => !!s && ((!!id && s.ids.has(id)) || (!!lower && s.handles.has(lower)));
    const rel: Relationship = {
      id,
      handle,
      name: u?.kind === 'user' ? u.name : undefined,
      following: inSet(following) || u?.following === true,
      followedBy: inSet(followers) || u?.followedBy === true,
      blocking: u?.blocking === true,
    };
    if (id) map.set(`id:${id}`, rel);
    if (lower) map.set(`h:${lower}`, rel);
  }
  return { map, source: 'graphql', notes };
}
