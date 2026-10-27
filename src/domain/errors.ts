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
  | 'self-unknown'
  | 'guard-unavailable'
  | 'endpoint-gone'
  | 'protected'
  | 'unknown';

export class XApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: XErrorCode,
    public body?: string,
    /** Rate limit : instant (ms epoch) annoncé par X pour la remise à zéro. */
    public resetAt?: number,
  ) {
    super(message);
    this.name = 'XApiError';
  }
}

/** HH:MM à l'heure de Paris. */
export function fmtClock(ms: number): string {
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** En-tête x-rate-limit-reset (secondes epoch) → ms epoch, ou undefined. */
export function parseRateLimitReset(raw: string | null | undefined, now = Date.now()): number | undefined {
  if (!raw || !/^\d{9,12}$/.test(raw)) return undefined;
  const ms = Number(raw) * 1000;
  // Valeur absurde (passé lointain / > 24 h) → ignorée.
  if (ms < now - 60 * 60_000 || ms > now + 24 * 3600_000) return undefined;
  return ms;
}

export const RATE_LIMIT_DEFAULT_MS = 15 * 60_000;
const RATE_LIMIT_MIN_MS = 60_000;
const RATE_LIMIT_MAX_MS = 3 * 3600_000;

/** Heure de reprise après un 429 : reset annoncé + 30 s, sinon 15 min ; bornée. */
export function rateLimitResumeAt(resetAt: number | undefined, now = Date.now()): number {
  const target = resetAt ? resetAt + 30_000 : now + RATE_LIMIT_DEFAULT_MS;
  return Math.min(now + RATE_LIMIT_MAX_MS, Math.max(now + RATE_LIMIT_MIN_MS, target));
}

/** Délais de reprise automatique pour les erreurs passagères (X injoignable…). */
export const TRANSIENT_BACKOFF_MS = [2, 5, 15, 30, 60].map((m) => m * 60_000);

/**
 * Erreurs « passagères » ou côté X : rien n'est bloqué, la file reprend toute
 * seule plus tard (jusqu'à TRANSIENT_BACKOFF_MS.length fois d'affilée).
 */
export function isTransient(code: XErrorCode): boolean {
  return (
    code === 'network' ||
    code === 'no-tab' ||
    code === 'guard-unavailable' ||
    code === 'endpoint-gone' ||
    code === 'resolver-failed'
  );
}

/** Erreurs d'authentification : pause immédiate, l'utilisateur doit agir. */
export function isAuthLoss(code: XErrorCode): boolean {
  return code === 'not-logged-in' || code === 'self-unknown';
}

/** Retire tout ce qui ressemble à un jeton avant journalisation. */
export function sanitizeErrorBody(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/ct0=[^;\s&]+/gi, 'ct0=…')
    .replace(/auth_token=[^;\s&]+/gi, 'auth_token=…')
    .replace(/twid=[^;\s&]+/gi, 'twid=…')
    .replace(/Bearer\s+[A-Za-z0-9%]+/g, 'Bearer …')
    .slice(0, 240);
}

export function frenchError(code: XErrorCode, detail?: string): string {
  switch (code) {
    case 'not-found':
      return 'Compte introuvable ou suspendu, ignoré';
    case 'suspended':
      return 'Compte suspendu, ignoré';
    case 'mismatch':
      return 'Incohérence entre @ et id — ignoré';
    case 'protected':
      return detail ? `Compte protégé (${detail}), ignoré` : 'Compte protégé, ignoré';
    case 'rate-limit':
      return detail
        ? `Limite X atteinte, reprise automatique à ${detail}`
        : 'Limite X atteinte, reprise automatique bientôt';
    case 'resolver-failed':
      return detail
        ? `X n’a pas renvoyé d’identifiant exploitable (${detail}).`
        : 'X n’a pas renvoyé d’identifiant exploitable.';
    case 'self-unknown':
      return 'Impossible d’identifier votre compte X (cookie de session illisible et réglages du compte indisponibles). Rechargez l’onglet x.com connecté puis réessayez. Aucun blocage n’est lancé sans cette vérification.';
    case 'guard-unavailable':
      return 'Impossible de vérifier la liste des comptes que vous suivez. Aucun blocage n’est lancé sans cette vérification : rechargez x.com puis réessayez.';
    case 'endpoint-gone':
      return detail
        ? `X a modifié son interface (${detail} ne répond plus). File en pause : rechargez x.com puis réessayez ; si ça persiste, l’extension doit être mise à jour.`
        : 'X a modifié son interface. File en pause : rechargez x.com puis réessayez ; si ça persiste, l’extension doit être mise à jour.';
    case 'forbidden':
      return 'X a refusé l’action (403). Nouvel essai après une pause.';
    case 'network':
      return detail
        ? `Impossible de joindre X, nouvel essai ${detail}`
        : 'Impossible de joindre X, nouvel essai bientôt';
    case 'not-logged-in':
      return 'Vous semblez déconnecté de X (cookie de session ct0 absent ou réponse 401). File en pause : reconnectez-vous sur x.com puis cliquez sur Démarrer.';
    case 'no-tab':
      return 'Aucun onglet x.com utilisable (fermé, déchargé par Chrome ou impossible à ouvrir). Ouvrez x.com dans ce profil Chrome.';
    default:
      return detail ? `Erreur : ${detail}` : 'Erreur inattendue';
  }
}

/** Message lisible pour n'importe quelle erreur (jamais de jeton). */
export function describeError(e: unknown): string {
  if (e instanceof XApiError) {
    if (e.code === 'unknown') return frenchError('unknown', sanitizeErrorBody(e.message));
    return frenchError(e.code, e.code === 'endpoint-gone' ? e.message : undefined);
  }
  if (e instanceof Error && e.message) return sanitizeErrorBody(e.message);
  return frenchError('unknown');
}

export function isSkippable(code: XErrorCode): boolean {
  return code === 'not-found' || code === 'suspended' || code === 'mismatch' || code === 'protected';
}

export function isPauseWorthy(code: XErrorCode): boolean {
  return (
    code === 'resolver-failed' ||
    code === 'not-logged-in' ||
    code === 'no-tab' ||
    code === 'network' ||
    code === 'self-unknown' ||
    code === 'guard-unavailable' ||
    code === 'endpoint-gone'
  );
}
