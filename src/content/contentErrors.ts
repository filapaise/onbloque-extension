import { isContextInvalidatedError } from '../shared/messages.ts';

/** Message affiché quand ce script de page appartient à une ancienne version de l'extension. */
export const RELOAD_TOAST = 'OnBloque a été mis à jour : recharge la page (F5) pour continuer.';

export interface ContentErrorView {
  text: string;
  /** Proposer un bouton « Recharger » (location.reload). */
  reload: boolean;
  /** Le contexte d'extension est mort : arrêter les minuteurs de ce script. */
  stale: boolean;
}

/** Raison lisible côté page (jamais un faux « liste vide », jamais une erreur JS brute). */
export function explainContentError(error: string | undefined): ContentErrorView {
  if (!error) return { text: 'OnBloque ne répond pas. Recharge la page (F5).', reload: true, stale: false };
  if (isContextInvalidatedError(error)) return { text: RELOAD_TOAST, reload: true, stale: true };
  if (/Receiving end does not exist|Could not establish connection/i.test(error)) {
    return { text: RELOAD_TOAST, reload: true, stale: false };
  }
  return { text: error, reload: false, stale: false };
}
