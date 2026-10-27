import type { PacePreset, Settings } from './types.ts';
import { MAX_DAILY_CAP } from './types.ts';

export type { PacePreset };

export interface PacePresetDef {
  id: PacePreset;
  label: string;
  hint: string;
  dailyCap: number;
  minDelaySec: number;
  maxDelaySec: number;
  /** Pause longue tous les N blocages (secondes). */
  pauseEveryN: number;
  pauseSec: number;
}

export const PACE_PRESETS: Record<PacePreset, PacePresetDef> = {
  prudent: {
    id: 'prudent',
    label: 'Prudent',
    hint: '~50 / jour',
    dailyCap: 50,
    minDelaySec: 20,
    maxDelaySec: 45,
    pauseEveryN: 10,
    pauseSec: 120,
  },
  normal: {
    id: 'normal',
    label: 'Normal',
    hint: '~200 / jour',
    dailyCap: 200,
    minDelaySec: 25,
    maxDelaySec: 55,
    pauseEveryN: 15,
    pauseSec: 180,
  },
  max: {
    id: 'max',
    label: 'Max',
    hint: '500 / jour (lent)',
    dailyCap: MAX_DAILY_CAP,
    // ~500 sur ~8–12 h avec jitter
    minDelaySec: 45,
    maxDelaySec: 90,
    pauseEveryN: 20,
    pauseSec: 300,
  },
};

export const DEFAULT_PACE: PacePreset = 'prudent';

/** Délai minimum autorisé entre deux blocages (réglage avancé), en secondes. */
export const DELAY_FLOOR_SEC = 15;
/** Délai maximum accepté (au-delà : ramené à cette valeur), en secondes. */
export const DELAY_CEIL_SEC = 900;

/** Choisir un preset remet les délais du preset (le réglage personnalisé est effacé). */
export function applyPace(settings: Settings, pace: PacePreset): Settings {
  const p = PACE_PRESETS[pace];
  return {
    ...settings,
    pace,
    dailyCap: p.dailyCap,
    minDelaySec: p.minDelaySec,
    maxDelaySec: p.maxDelaySec,
    customDelay: false,
    transport: 'tab',
    autoRefresh: false,
  };
}

/**
 * Valide un couple min/max (secondes) venant de l'UI ou du stockage.
 * - pas un nombre fini (texte, NaN, null…) → null (valeur ignorée) ;
 * - sinon arrondi, min borné à [15, 900], max borné à [min, 900].
 */
export function sanitizeDelays(min: unknown, max: unknown): { minDelaySec: number; maxDelaySec: number } | null {
  if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }
  const lo = Math.min(DELAY_CEIL_SEC, Math.max(DELAY_FLOOR_SEC, Math.round(min)));
  const hi = Math.min(DELAY_CEIL_SEC, Math.max(lo, Math.round(max)));
  return { minDelaySec: lo, maxDelaySec: hi };
}

/** Applique des délais personnalisés (validés) sans toucher au preset ni au plafond. */
export function applyCustomDelay(settings: Settings, min: unknown, max: unknown): Settings {
  const d = sanitizeDelays(min, max);
  if (!d) return settings;
  return { ...settings, ...d, customDelay: true };
}

/** Lecture d'un champ texte de l'UI : '' / texte → NaN (refusé), sinon nombre. */
export function parseDelayInput(raw: string): number {
  const t = String(raw ?? '').trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  return Number(t);
}

/** Message affiché sous les champs quand les valeurs saisies ont été corrigées. */
export function delayAdjustNote(minIn: number, maxIn: number, saved: { minDelaySec: number; maxDelaySec: number }): string {
  const notes: string[] = [];
  if (Math.round(minIn) < DELAY_FLOOR_SEC) notes.push(`minimum ${DELAY_FLOOR_SEC} s`);
  if (Math.round(maxIn) < saved.minDelaySec) notes.push('le maximum ne peut pas être inférieur au minimum');
  if (Math.round(minIn) > DELAY_CEIL_SEC || Math.round(maxIn) > DELAY_CEIL_SEC) notes.push(`maximum ${DELAY_CEIL_SEC} s`);
  return notes.length ? `Ajusté : ${notes.join(', ')}.` : '';
}

function fmtSec(sec: number): string {
  if (sec < 60 || sec % 60) return `${sec} s`;
  return `${sec / 60} min`;
}

/**
 * Description exacte du rythme appliqué (UI) : délai entre deux blocages
 * (mesuré d'un début de blocage au suivant), pause longue et plafond.
 */
export function describePace(settings: Pick<Settings, 'pace' | 'minDelaySec' | 'maxDelaySec' | 'dailyCap' | 'customDelay'>): string {
  const pace = settings.pace ?? DEFAULT_PACE;
  const p = PACE_PRESETS[pace] ?? PACE_PRESETS[DEFAULT_PACE];
  const delay = `Un blocage toutes les ${settings.minDelaySec} à ${settings.maxDelaySec} s${settings.customDelay ? ' (personnalisé)' : ''}`;
  return `${delay}, une pause de ${fmtSec(p.pauseSec)} après chaque série de ${p.pauseEveryN}, ${settings.dailyCap} maximum par jour.`;
}

export function nearestPace(settings: Partial<Settings> & { pace?: PacePreset }): PacePreset {
  if (settings.pace === 'prudent' || settings.pace === 'normal' || settings.pace === 'max') {
    return settings.pace;
  }
  const cap = Number(settings.dailyCap);
  if (!Number.isFinite(cap)) return DEFAULT_PACE;
  let best: PacePreset = DEFAULT_PACE;
  let bestScore = Infinity;
  for (const p of Object.values(PACE_PRESETS)) {
    const score = Math.abs(p.dailyCap - cap);
    if (score < bestScore) {
      bestScore = score;
      best = p.id;
    }
  }
  return best;
}

export function pacePause(pace: PacePreset): { everyN: number; pauseSec: number } {
  const p = PACE_PRESETS[pace];
  return { everyN: p.pauseEveryN, pauseSec: p.pauseSec };
}
