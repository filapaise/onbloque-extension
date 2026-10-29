/**
 * Position du bouton flottant OnBloque sur x.com — logique pure, testable sans DOM.
 *
 * Modèle : décalages (px) depuis le coin bas-droit du viewport, comme les
 * éléments fixes de X (tiroir Messages, bouton Grok, bouton « Poster » mobile).
 * Ainsi la position suit le coin lors d'un redimensionnement.
 */

export interface FabPos {
  right: number;
  bottom: number;
}
export interface Viewport {
  width: number;
  height: number;
}
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Diamètre du bouton compact (px). */
export const FAB_SIZE = 40;
/** Marge minimale avec les bords du viewport. */
export const EDGE_MARGIN = 8;
/** Espace laissé au-dessus d'un élément de X qui gênait. */
export const NUDGE_GAP = 20;
/** Clé chrome.storage.local (1.3.2 : lue/écrite par le service worker, via GET_FAB_POS / SET_FAB_POS). */
export const POS_KEY = 'fabPosition';

/** Largeur sous laquelle X passe en mise en page mobile (barre d'onglets en bas). */
export const MOBILE_MAX_WIDTH = 500;

/**
 * Position par défaut, choisie pour éviter l'UI fixe connue de X :
 * - bureau : tiroir Messages/Grok en bas à droite (~53 px de haut) → on se place
 *   au-dessus, avec de la marge pour la pastille Grok (~56 px) ;
 * - mobile : barre d'onglets (~53 px) + bouton rond « Poster » (~56 px, bas-droite)
 *   → on se place au-dessus des deux.
 * Le bouton « Poster » de la barre latérale gauche n'est jamais concerné (côté droit).
 */
export function defaultPosition(vp: Viewport): FabPos {
  // 1.2.6 : plus de marge au-dessus de la pastille Grok (bureau, haut ≈ 121 px du bas)
  // et du bouton « Poster » mobile (haut ≈ 125 px) : ≥ 40 px d'écart.
  if (vp.width <= MOBILE_MAX_WIDTH) return { right: 16, bottom: 172 };
  return { right: 24, bottom: 168 };
}

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** Garde le bouton entièrement visible (avec marge), quelle que soit la taille du viewport. */
export function clampPosition(pos: FabPos, vp: Viewport, size = FAB_SIZE): FabPos {
  const maxRight = Math.max(EDGE_MARGIN, vp.width - size - EDGE_MARGIN);
  const maxBottom = Math.max(EDGE_MARGIN, vp.height - size - EDGE_MARGIN);
  const clamp = (v: number, max: number) => Math.round(Math.min(max, Math.max(EDGE_MARGIN, v)));
  return { right: clamp(pos.right, maxRight), bottom: clamp(pos.bottom, maxBottom) };
}

/** Valide une valeur lue depuis le stockage (jamais de confiance aveugle). */
export function parseStoredPosition(raw: unknown): FabPos | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!finite(r.right) || !finite(r.bottom)) return null;
  if (r.right < 0 || r.bottom < 0 || r.right > 100_000 || r.bottom > 100_000) return null;
  return { right: r.right, bottom: r.bottom };
}

/** Rectangle écran du bouton pour une position donnée. */
export function rectFor(pos: FabPos, vp: Viewport, size = FAB_SIZE): Rect {
  const right = vp.width - pos.right;
  const bottom = vp.height - pos.bottom;
  return { left: right - size, top: bottom - size, right, bottom };
}

/** Points sondés (centre + 4 coins légèrement rentrés) pour elementsFromPoint. */
export function probePoints(r: Rect): Array<[number, number]> {
  const i = 3;
  return [
    [(r.left + r.right) / 2, (r.top + r.bottom) / 2],
    [r.left + i, r.top + i],
    [r.right - i, r.top + i],
    [r.left + i, r.bottom - i],
    [r.right - i, r.bottom - i],
  ];
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * Remonte le bouton tant qu'il chevauche un élément fixe de X.
 * `probe(rect)` renvoie les rectangles des obstacles visibles sous `rect`.
 * Part toujours de la position de base (pas de dérive cumulative).
 */
export function resolveOverlap(
  base: FabPos,
  vp: Viewport,
  probe: (r: Rect) => Rect[],
  size = FAB_SIZE,
  maxSteps = 12,
): FabPos {
  let pos = clampPosition(base, vp, size);
  for (let step = 0; step < maxSteps; step++) {
    const rect = rectFor(pos, vp, size);
    const hits = probe(rect).filter((o) => intersects(rect, o));
    if (!hits.length) return pos;
    const highestTop = Math.min(...hits.map((o) => o.top));
    const next = clampPosition({ right: pos.right, bottom: vp.height - highestTop + NUDGE_GAP }, vp, size);
    // Déjà tout en haut sans place libre : on garde la position de base plutôt qu'un coin arbitraire.
    if (next.bottom <= pos.bottom) break;
    pos = next;
  }
  return clampPosition(base, vp, size);
}

/** Le bouton est-il dans la moitié gauche ? (le libellé et le menu s'ouvrent alors vers la droite) */
export function isLeftHalf(pos: FabPos, vp: Viewport, size = FAB_SIZE): boolean {
  return vp.width - pos.right - size / 2 < vp.width / 2;
}

/** Le menu doit-il s'ouvrir vers le bas (bouton trop près du haut) ? */
export function opensDownward(pos: FabPos, vp: Viewport, panelHeight: number, size = FAB_SIZE): boolean {
  const top = vp.height - pos.bottom - size;
  return top < panelHeight + EDGE_MARGIN * 2;
}

/** Au-delà de ce déplacement (px), un appui devient un glisser et n'ouvre pas le menu. */
export const DRAG_THRESHOLD = 5;

/** Nouvelle position après un glisser de (dx, dy) depuis `start`. */
export function dragTo(start: FabPos, dx: number, dy: number, vp: Viewport, size = FAB_SIZE): FabPos {
  return clampPosition({ right: start.right - dx, bottom: start.bottom - dy }, vp, size);
}

export interface PosStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function loadPosition(storage: PosStorage | undefined, vp: Viewport): Promise<FabPos> {
  try {
    if (storage) {
      const data = await storage.get(POS_KEY);
      const saved = parseStoredPosition(data?.[POS_KEY]);
      if (saved) return clampPosition(saved, vp);
    }
  } catch {
    /* stockage indisponible (contexte invalidé…) → défaut */
  }
  return clampPosition(defaultPosition(vp), vp);
}

export async function savePosition(storage: PosStorage | undefined, pos: FabPos, vp: Viewport): Promise<FabPos> {
  const clamped = clampPosition(pos, vp);
  try {
    await storage?.set({ [POS_KEY]: { right: clamped.right, bottom: clamped.bottom } });
  } catch {
    /* ignore */
  }
  return clamped;
}
