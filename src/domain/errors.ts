/** Erreurs métier du client X — jamais de jetons dedans. */

export type XErrorCode =
  | 'not-found'
  | 'suspended'
  | 'rate-limit'
  | 'resolver-failed'
  | 'forbidden'
  | 'network'
  | 'not-logged-in'
  | 'no-tab'
  | 'mismatch'
  | 'unknown';

export class XApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: XErrorCode,
    public body?: string,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

export function frenchError(code: XErrorCode, detail?: string): string {
  switch (code) {
    case 'not-found':
      return 'Compte introuvable ou suspendu, ignoré';
    case 'suspended':
      return 'Compte suspendu, ignoré';
    case 'mismatch':
      return 'Incohérence entre @ et id — ignoré';
    case 'rate-limit':
      return detail
        ? `Limite de débit X atteinte, nouvel essai ${detail}`
        : 'Limite de débit X atteinte, nouvel essai bientôt';
    case 'resolver-failed':
      return 'Impossible de résoudre les identifiants X. File en pause — rouvrez un onglet x.com puis relancez.';
    case 'forbidden':
      return 'X a refusé l’action (403). Nouvel essai après une pause.';
    case 'network':
      return detail
        ? `Impossible de joindre X, nouvel essai ${detail}`
        : 'Impossible de joindre X, nouvel essai bientôt';
    case 'not-logged-in':
      return 'Session x.com introuvable. Ouvrez x.com et reconnectez-vous.';
    case 'no-tab':
      return 'Ouvrez un onglet x.com connecté pour continuer.';
    default:
      return detail ? `Erreur : ${detail}` : 'Erreur inattendue';
  }
}

export function isSkippable(code: XErrorCode): boolean {
  return code === 'not-found' || code === 'suspended' || code === 'mismatch';
}

export function isPauseWorthy(code: XErrorCode): boolean {
  return (
    code === 'resolver-failed' ||
    code === 'not-logged-in' ||
    code === 'no-tab' ||
    code === 'network'
  );
}
