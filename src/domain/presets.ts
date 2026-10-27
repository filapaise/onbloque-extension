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

export function applyPace(settings: Settings, pace: PacePreset): Settings {
  const p = PACE_PRESETS[pace];
  return {
    ...settings,
    pace,
    dailyCap: p.dailyCap,
    minDelaySec: p.minDelaySec,
    maxDelaySec: p.maxDelaySec,
    transport: 'tab',
    autoRefresh: false,
  };
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
