/**
 * Content script : bouton flottant compact sur x.com (déplaçable).
 * N'exécute jamais de blocage directement — ouvre l'aperçu via messaging.
 * Aucun innerHTML : tout est construit avec createElement / createElementNS.
 */
import { collectHandlesFromPage } from './collect.ts';
import { CONTEXT_INVALIDATED, extensionContextAlive, sendMessage } from '../shared/messages.ts';
import { explainContentError } from './contentErrors.ts';
import { fmtDuration, parseFabProgress, ringFraction, type FabProgress } from '../domain/progress.ts';
import {
  DRAG_THRESHOLD,
  FAB_SIZE,
  dragTo,
  isLeftHalf,
  loadPosition,
  opensDownward,
  probePoints,
  resolveOverlap,
  savePosition,
  type FabPos,
  type PosStorage,
  type Rect,
  type Viewport,
} from './fabPosition.ts';

const ROOT_ID = 'onbloque-fab-root';
const STYLE_ID = 'onbloque-fab-style';
const SVG_NS = 'http://www.w3.org/2000/svg';
const PANEL_HEIGHT_ESTIMATE = 150;
/** Anneau de progression : épais et contrasté (piste sombre, arc blanc) dans le bouton bleu. */
const RING_W = 4;
const RING_R = FAB_SIZE / 2 - RING_W / 2 - 1;
const RING_C = 2 * Math.PI * RING_R;

/** Position choisie par l'utilisateur (ou défaut) ; la position affichée peut être remontée. */
let basePos: FabPos | null = null;
let shownPos: FabPos | null = null;
let dragging = false;

/**
 * Identifiant de cette instance du script. Après une mise à jour / réinstallation, le
 * service worker réinjecte le script dans les onglets x.com déjà ouverts : la nouvelle
 * instance remplace alors l'interface laissée par l'ancienne (orpheline).
 */
const INSTANCE = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const GUARD_KEY = '__onbloqueContentScript';
interface InstanceGuard {
  instance: string;
  alive: () => boolean;
  shutdown: () => void;
}
/** Vrai quand cette instance a cédé la place (ou est orpheline) : plus aucun minuteur. */
let stopped = false;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let obs: MutationObserver | null = null;

function viewport(): Viewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function storageArea(): PosStorage | undefined {
  try {
    const local = chrome?.storage?.local;
    if (!local) return undefined;
    return {
      get: (k) => local.get(k) as Promise<Record<string, unknown>>,
      set: (items) => local.set(items),
    };
  } catch {
    return undefined;
  }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID}{position:fixed;z-index:9999;right:24px;bottom:168px;font-family:system-ui,-apple-system,sans-serif;visibility:hidden}
#${ROOT_ID}.ready{visibility:visible}
#${ROOT_ID} .ob-pop{position:absolute;right:0;bottom:calc(100% + 8px);display:flex;flex-direction:column;gap:8px;align-items:flex-end}
#${ROOT_ID}.down .ob-pop{bottom:auto;top:calc(100% + 8px);flex-direction:column-reverse}
#${ROOT_ID}.left .ob-pop{right:auto;left:0;align-items:flex-start}
#${ROOT_ID} .ob-panel{display:none;flex-direction:column;gap:6px;background:#0f1419;color:#e7e9ea;border:1px solid #2f3336;border-radius:14px;padding:10px;min-width:220px;box-shadow:0 8px 28px rgba(0,0,0,.35)}
#${ROOT_ID}.open .ob-panel{display:flex}
#${ROOT_ID} button{appearance:none;border:0;border-radius:999px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
#${ROOT_ID} .ob-main{display:flex;align-items:center;height:${FAB_SIZE}px;min-width:${FAB_SIZE}px;padding:0;background:#1d9bf0;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.3);touch-action:none;user-select:none}
#${ROOT_ID}.left .ob-main{flex-direction:row}
#${ROOT_ID}:not(.left) .ob-main{flex-direction:row-reverse}
#${ROOT_ID} .ob-main:hover{background:#1a8cd8}
#${ROOT_ID} .ob-main:focus-visible{outline:2px solid #fff;outline-offset:2px}
#${ROOT_ID} .ob-icon{flex:0 0 ${FAB_SIZE}px;height:${FAB_SIZE}px;display:flex;align-items:center;justify-content:center}
#${ROOT_ID} .ob-label{max-width:0;overflow:hidden;white-space:nowrap;transition:max-width .18s ease,padding .18s ease}
#${ROOT_ID} .ob-main:hover .ob-label,#${ROOT_ID} .ob-main:focus-visible .ob-label,#${ROOT_ID}.open .ob-label{max-width:120px}
#${ROOT_ID}:not(.left) .ob-main:hover .ob-label,#${ROOT_ID}:not(.left) .ob-main:focus-visible .ob-label,#${ROOT_ID}:not(.left).open .ob-label{padding-left:14px}
#${ROOT_ID}.left .ob-main:hover .ob-label,#${ROOT_ID}.left .ob-main:focus-visible .ob-label,#${ROOT_ID}.left.open .ob-label{padding-right:14px}
#${ROOT_ID}.dragging .ob-main{cursor:grabbing;box-shadow:0 8px 24px rgba(0,0,0,.45)}
#${ROOT_ID}.dragging .ob-label{max-width:0;padding:0}
#${ROOT_ID} .ob-action{background:#16181c;color:#e7e9ea;border:1px solid #2f3336;text-align:left;padding:10px 14px}
#${ROOT_ID} .ob-action:hover{background:#1e2126}
#${ROOT_ID} .ob-hint{font-size:11px;color:#8b98a5;padding:0 4px 4px}
#${ROOT_ID} .ob-icon{position:relative}
#${ROOT_ID} .ob-ring{position:absolute;left:0;top:0;width:${FAB_SIZE}px;height:${FAB_SIZE}px;pointer-events:none;transform:rotate(-90deg);display:none;overflow:visible}
#${ROOT_ID}.busy .ob-ring{display:block}
#${ROOT_ID} .ob-ring circle{fill:none!important;stroke-width:${RING_W}px!important;vector-effect:none}
#${ROOT_ID} .ob-ring .trk{stroke:rgba(15,20,25,.55)!important}
#${ROOT_ID} .ob-ring .val{stroke:#ffffff!important;stroke-linecap:round;transition:stroke-dashoffset .4s ease;filter:drop-shadow(0 0 1px rgba(0,0,0,.6))}
#${ROOT_ID}[data-state="cap"] .ob-ring .val,#${ROOT_ID}[data-state="rate-limit"] .ob-ring .val,#${ROOT_ID}[data-state="retry"] .ob-ring .val{stroke:#ffd166!important}
#${ROOT_ID}[data-state="error"] .ob-ring .val{stroke:#ff6b74!important}
#${ROOT_ID}[data-state="paused"] .ob-ring .val{stroke:#e7e9ea!important}
#${ROOT_ID}.stale .ob-main{background:#536471}
#${ROOT_ID} .ob-count{position:absolute;top:-6px;min-width:18px;height:18px;padding:0 5px;box-sizing:border-box;border-radius:9px;background:#0f1419;color:#fff;border:1px solid #2f3336;font-size:10px;font-weight:700;line-height:16px;text-align:center;pointer-events:none;display:none;font-variant-numeric:tabular-nums}
#${ROOT_ID}:not(.left) .ob-count{right:-6px}
#${ROOT_ID}.left .ob-count{left:-6px}
#${ROOT_ID}.busy .ob-count{display:block}
#${ROOT_ID}[data-state="cap"] .ob-count,#${ROOT_ID}[data-state="rate-limit"] .ob-count,#${ROOT_ID}[data-state="retry"] .ob-count{background:#ffad1f;color:#0f1419;border-color:#ffad1f}
#${ROOT_ID}[data-state="error"] .ob-count{background:#f4212e;border-color:#f4212e}
#${ROOT_ID} .ob-flash{padding:8px 10px;border-radius:10px;background:#f4212e;color:#fff;font-size:12px;max-width:260px;display:flex;align-items:center;gap:8px}
#${ROOT_ID} .ob-flash.info{background:#0f1419;border:1px solid #2f3336;color:#e7e9ea}
#${ROOT_ID} .ob-flash .ob-reload{flex:0 0 auto;background:#1d9bf0;color:#fff;padding:6px 12px}
#${ROOT_ID} .ob-flash .ob-reload:hover{background:#1a8cd8}
`;
  document.documentElement.appendChild(style);
}

/** Icône « cercle barré » construite en SVG via createElementNS (pas d'innerHTML). */
function buildIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.4');
  svg.setAttribute('stroke-linecap', 'round');
  const circle = document.createElementNS(SVG_NS, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '8.5');
  const line = document.createElementNS(SVG_NS, 'line');
  line.setAttribute('x1', '6');
  line.setAttribute('y1', '18');
  line.setAttribute('x2', '18');
  line.setAttribute('y2', '6');
  svg.append(circle, line);
  return svg;
}



/** Anneau de progression autour de l'icône (SVG, createElementNS). */
function buildRing(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ob-ring');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('width', String(FAB_SIZE));
  svg.setAttribute('height', String(FAB_SIZE));
  svg.setAttribute('aria-hidden', 'true');
  for (const cls of ['trk', 'val']) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', cls);
    c.setAttribute('cx', '20');
    c.setAttribute('cy', '20');
    c.setAttribute('r', String(RING_R));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke-width', String(RING_W));
    c.setAttribute('stroke-linecap', 'round');
    if (cls === 'val') {
      c.setAttribute('stroke-dasharray', RING_C.toFixed(2));
      c.setAttribute('stroke-dashoffset', RING_C.toFixed(2));
    }
    svg.appendChild(c);
  }
  return svg;
}

function buildRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = ROOT_ID;
  root.dataset.instance = INSTANCE;
  const pop = document.createElement('div');
  pop.className = 'ob-pop';
  const panel = document.createElement('div');
  panel.className = 'ob-panel';
  panel.setAttribute('role', 'menu');
  const hint = document.createElement('div');
  hint.className = 'ob-hint';
  hint.textContent = 'Aperçu obligatoire avant tout blocage';
  panel.appendChild(hint);
  for (const [act, label] of [
    ['page', 'Bloquer les comptes de cette page'],
    ['list', 'Bloquer toute la liste'],
  ] as const) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ob-action';
    b.dataset.act = act;
    b.textContent = label;
    panel.appendChild(b);
  }
  pop.appendChild(panel);
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ob-main';
  main.setAttribute('aria-expanded', 'false');
  main.setAttribute('aria-label', 'OnBloque — comptes à bloquer');
  main.title = 'OnBloque — cliquer pour ouvrir, glisser pour déplacer';
  const icon = document.createElement('span');
  icon.className = 'ob-icon';
  icon.append(buildIcon(), buildRing());
  const label = document.createElement('span');
  label.className = 'ob-label';
  label.textContent = 'OnBloque';
  main.append(icon, label);
  const count = document.createElement('span');
  count.className = 'ob-count';
  count.setAttribute('aria-hidden', 'true');
  root.append(pop, main, count);
  return root;
}

/** Applique une position : ancrage à gauche ou à droite selon la moitié d'écran. */
function applyPosition(root: HTMLElement, pos: FabPos): void {
  const vp = viewport();
  shownPos = pos;
  const left = isLeftHalf(pos, vp);
  root.classList.toggle('left', left);
  root.classList.toggle('down', opensDownward(pos, vp, PANEL_HEIGHT_ESTIMATE));
  root.style.bottom = `${pos.bottom}px`;
  if (left) {
    root.style.left = `${vp.width - pos.right - FAB_SIZE}px`;
    root.style.right = 'auto';
  } else {
    root.style.right = `${pos.right}px`;
    root.style.left = 'auto';
  }
}

/** Élément d'UI de X réellement gênant sous un point (fixe, visible, hors OnBloque). */
function obstacleAt(root: HTMLElement, x: number, y: number): Rect | null {
  if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
  const stack = document.elementsFromPoint(x, y);
  const top = stack.find((el) => !root.contains(el) && el !== document.documentElement && el !== document.body);
  if (!top) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let interactive: Element | null = null;
  for (let el: Element | null = top; el && el !== document.documentElement && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.opacity === '0' || cs.display === 'none') return null;
    if (!interactive && el.matches('a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"]')) {
      interactive = el;
    }
    if (cs.position === 'fixed') {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      // Petit élément fixe (tiroir Messages, pastille Grok, bouton Poster mobile) : obstacle entier.
      if (r.width <= vw * 0.6 && r.height <= vh * 0.5) return r;
      // Grand conteneur fixe (barre latérale, barre d'onglets) : seulement ses boutons/liens.
      return interactive ? interactive.getBoundingClientRect() : null;
    }
  }
  return null; // contenu qui défile : pas un obstacle
}

function probeObstacles(root: HTMLElement, rect: Rect): Rect[] {
  const out: Rect[] = [];
  for (const [x, y] of probePoints(rect)) {
    const o = obstacleAt(root, x, y);
    if (o) out.push({ left: o.left, top: o.top, right: o.right, bottom: o.bottom });
  }
  return out;
}

/** Recalcule la position affichée depuis la position de base (clamp + évitement). */
function relayout(root: HTMLElement): void {
  if (!basePos || dragging || root.classList.contains('open')) return;
  try {
    const next = resolveOverlap(basePos, viewport(), (r) => probeObstacles(root, r));
    if (!shownPos || next.right !== shownPos.right || next.bottom !== shownPos.bottom) applyPosition(root, next);
  } catch {
    /* elementsFromPoint indisponible : on garde la position actuelle */
  }
}

function wireDrag(root: HTMLElement, main: HTMLButtonElement): void {
  let start: { x: number; y: number; pos: FabPos; id: number } | null = null;
  let suppressClick = false;
  main.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !shownPos) return;
    start = { x: e.clientX, y: e.clientY, pos: shownPos, id: e.pointerId };
  });
  main.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!dragging) {
      dragging = true;
      root.classList.add('dragging');
      root.classList.remove('open');
      main.setAttribute('aria-expanded', 'false');
      try {
        main.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }
    e.preventDefault();
    applyPosition(root, dragTo(start.pos, dx, dy, viewport()));
  });
  const end = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    start = null;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    root.classList.remove('dragging');
    const dropped = shownPos;
    if (dropped) {
      void savePosition(storageArea(), dropped, viewport()).then((saved) => {
        basePos = saved;
        relayout(root);
      });
    }
  };
  main.addEventListener('pointerup', end);
  main.addEventListener('pointercancel', end);
  // Un glisser ne doit pas ouvrir le menu.
  main.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );
}

function wire(root: HTMLElement): void {
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  const main = root.querySelector('.ob-main') as HTMLButtonElement;
  wireDrag(root, main);
  main.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!extensionContextAlive()) {
      goStale(root);
      showError(root, CONTEXT_INVALIDATED);
      return;
    }
    if (shownPos) root.classList.toggle('down', opensDownward(shownPos, viewport(), PANEL_HEIGHT_ESTIMATE));
    root.classList.toggle('open');
    main.setAttribute('aria-expanded', root.classList.contains('open') ? 'true' : 'false');
  });
  root.querySelectorAll<HTMLButtonElement>('.ob-action').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('open');
      main.setAttribute('aria-expanded', 'false');
      const act = btn.dataset.act;
      try {
        let resp;
        if (act === 'page') {
          const entries = collectHandlesFromPage();
          if (!entries.length) {
            flash(root, 'Aucun compte détecté sur cette page.');
            return;
          }
          resp = await sendMessage({
            type: 'OPEN_PREVIEW',
            entries,
            sourceLabel: `page:${location.pathname}`,
            precheckNone: true,
          });
        } else if (act === 'list') {
          // Le content script ne lit pas l'état : le background charge la liste stockée.
          resp = await sendMessage({ type: 'OPEN_PREVIEW', mode: 'list', sourceLabel: 'liste' });
        }
        if (resp && !resp.ok) showError(root, resp.error);
      } catch (err) {
        showError(root, (err as Error).message);
      }
    });
  });
  document.addEventListener(
    'click',
    (e) => {
      if (!root.contains(e.target as Node)) {
        root.classList.remove('open');
        main.setAttribute('aria-expanded', 'false');
      }
    },
    true,
  );
}

/** Affiche une erreur lisible (jamais l'erreur JS brute) et coupe les minuteurs si le script est orphelin. */
function showError(root: HTMLElement, error: string | undefined): void {
  const view = explainContentError(error);
  if (view.stale) goStale(root);
  flash(root, view.text, { reload: view.reload });
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;
function flash(root: HTMLElement, text: string, opts: { reload?: boolean } = {}): void {
  const pop = root.querySelector('.ob-pop') as HTMLElement;
  let el = root.querySelector('.ob-flash') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.setAttribute('role', 'status');
    pop.insertBefore(el, pop.firstChild);
  }
  el.className = opts.reload ? 'ob-flash info' : 'ob-flash';
  const msg = document.createElement('span');
  msg.textContent = text;
  el.replaceChildren(msg);
  if (opts.reload) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ob-reload';
    btn.textContent = 'Recharger';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      location.reload();
    });
    el.appendChild(btn);
  }
  clearTimeout(flashTimer);
  const shown = el;
  flashTimer = setTimeout(() => shown.remove(), opts.reload ? 20000 : 6000);
}

let progress: FabProgress | null = null;

function fabCount(n: number): string {
  return n < 1000 ? String(n) : n < 10_000 ? `${Math.floor(n / 1000)}k` : '9k+';
}

/** Anneau + compteur sur le bouton pendant que la file tourne (ou attend une reprise). */
function renderProgress(root: HTMLElement): void {
  const main = root.querySelector('.ob-main') as HTMLButtonElement | null;
  const count = root.querySelector('.ob-count') as HTMLElement | null;
  const val = root.querySelector('.ob-ring .val');
  if (!main || !count || !val) return;
  if (root.classList.contains('stale')) return;
  const p = progress;
  const busy = !!p && p.remaining > 0 && p.state !== 'idle' && p.state !== 'done';
  root.classList.toggle('busy', busy);
  root.dataset.state = p?.state ?? 'idle';
  if (!busy || !p) {
    count.textContent = '';
    main.title = 'OnBloque — cliquer pour ouvrir, glisser pour déplacer';
    return;
  }
  val.setAttribute('stroke-dashoffset', (RING_C * (1 - ringFraction(p.pct))).toFixed(2));
  count.textContent = fabCount(p.remaining);
  const secs = p.nextAt ? Math.max(0, Math.ceil((p.nextAt - Date.now()) / 1000)) : 0;
  let line: string;
  if (p.state === 'running') line = secs > 0 ? `prochain blocage dans ${fmtDuration(secs)}` : 'blocage en cours…';
  else if (p.state === 'cap') line = 'plafond du jour atteint, reprise automatique';
  else if (p.state === 'rate-limit') line = 'limite X, reprise automatique';
  else if (p.state === 'retry') line = 'erreur passagère, nouvel essai automatique';
  else if (p.state === 'error') line = 'en pause (erreur) — voir le popup';
  else line = 'en pause';
  if (p.state !== 'running' && secs > 0) line += ` dans ${fmtDuration(secs)}`;
  main.title = `OnBloque — ${p.done} / ${p.total} traités, ${p.remaining} en attente · ${line}`;
}

function wireProgress(root: HTMLElement): void {
  if (root.dataset.progressWired === '1') return;
  root.dataset.progressWired = '1';
  try {
    chrome.runtime.onMessage.addListener((msg: unknown, sender) => {
      // Uniquement le service worker de cette extension (jamais une page ni un autre onglet).
      if (sender.id !== chrome.runtime.id || sender.tab) return;
      if (!msg || typeof msg !== 'object' || (msg as { type?: unknown }).type !== 'ONBLOQUE_PROGRESS') return;
      const p = parseFabProgress((msg as { progress?: unknown }).progress);
      if (!p) return;
      progress = p;
      const r = document.getElementById(ROOT_ID);
      if (r) renderProgress(r);
    });
  } catch {
    /* contexte invalidé */
  }
  void requestProgress();
  document.addEventListener('visibilitychange', onVisible);
}

function onVisible(): void {
  if (document.visibilityState === 'visible') void requestProgress();
}

async function requestProgress(): Promise<void> {
  if (stopped) return;
  const resp = await sendMessage({ type: 'GET_PROGRESS' });
  if (!resp.ok && resp.error === CONTEXT_INVALIDATED) {
    const r = document.getElementById(ROOT_ID);
    if (r && r.dataset.instance === INSTANCE) goStale(r);
    else shutdown();
    return;
  }
  if (!resp.ok || !('progress' in resp)) return;
  const p = parseFabProgress(resp.progress);
  if (!p) return;
  progress = p;
  const r = document.getElementById(ROOT_ID);
  if (r) renderProgress(r);
}

function mount(): void {
  if (stopped) return;
  const existing = document.getElementById(ROOT_ID);
  if (existing && existing.dataset.instance !== INSTANCE) {
    // Une instance plus récente a pris la main : celle-ci s'efface.
    shutdown();
    return;
  }
  ensureStyle();
  const root = buildRoot();
  if (!root.isConnected) document.documentElement.appendChild(root);
  wire(root);
  wireProgress(root);
  renderProgress(root);
  if (basePos) {
    relayout(root);
    root.classList.add('ready');
    return;
  }
  void loadPosition(storageArea(), viewport()).then((pos) => {
    basePos = pos;
    applyPosition(root, pos);
    relayout(root);
    root.classList.add('ready');
  });
}

/** Faux après un rechargement / une mise à jour de l'extension (ce script devient orphelin). */
function contextAlive(): boolean {
  return extensionContextAlive();
}

/**
 * Script orphelin : ses compteurs sont figés. Plutôt qu'un faux « 0 / N traités »,
 * on dit clairement de recharger la page (le nouveau script lira l'état persisté).
 */
function markStale(root: HTMLElement): void {
  if (root.classList.contains('stale')) return;
  root.classList.add('stale');
  root.classList.remove('busy');
  const count = root.querySelector('.ob-count') as HTMLElement | null;
  if (count) count.textContent = '';
  const main = root.querySelector('.ob-main') as HTMLButtonElement | null;
  if (main) main.title = 'OnBloque a été mis à jour : recharge la page (F5) pour continuer.';
}

/** Contexte mort : bouton grisé + arrêt de tous les minuteurs (pas d'erreurs en boucle). */
function goStale(root: HTMLElement): void {
  markStale(root);
  stopWatching();
}

function stopWatching(): void {
  clearInterval(tickTimer);
  tickTimer = undefined;
  clearTimeout(resizeTimer);
  obs?.disconnect();
  obs = null;
  window.removeEventListener('resize', onResize);
  window.removeEventListener('popstate', onTick);
  document.removeEventListener('visibilitychange', onVisible);
}

/** Cède la place à une instance plus récente (ne touche pas à son interface). */
function shutdown(): void {
  stopped = true;
  stopWatching();
}

let lastUrl = location.href;
function onTick(): void {
  if (stopped) return;
  if (location.href !== lastUrl) lastUrl = location.href;
  if (!contextAlive()) {
    const root = document.getElementById(ROOT_ID);
    if (root && root.dataset.instance === INSTANCE) goStale(root);
    else shutdown();
    return;
  }
  mount(); // ré-attache si besoin + réévalue les chevauchements (le tiroir de X apparaît tard)
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function onResize(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const root = document.getElementById(ROOT_ID);
    if (root && !stopped) relayout(root);
  }, 150);
}

/**
 * Démarrage idempotent : une seule instance vivante par onglet. Une injection en double
 * (manifeste + réinjection après installation) ne fait rien ; une instance orpheline est
 * arrêtée et son bouton remplacé.
 */
function start(): void {
  const w = window as unknown as Record<string, InstanceGuard | undefined>;
  const prev = w[GUARD_KEY];
  if (prev && prev.instance !== INSTANCE) {
    let prevAlive = false;
    try {
      prevAlive = prev.alive();
    } catch {
      prevAlive = false;
    }
    if (prevAlive) return; // déjà injecté et fonctionnel
    try {
      prev.shutdown();
    } catch {
      /* ancienne instance inaccessible */
    }
  }
  w[GUARD_KEY] = { instance: INSTANCE, alive: contextAlive, shutdown };

  // Interface laissée par une instance précédente (orpheline) : on la remplace.
  const old = document.getElementById(ROOT_ID);
  if (old && old.dataset.instance !== INSTANCE) old.remove();
  document.getElementById(STYLE_ID)?.remove();

  mount();

  obs = new MutationObserver(() => {
    if (stopped) return;
    if (!document.getElementById(ROOT_ID)?.isConnected) mount();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('resize', onResize);
  // X est une SPA : surveiller l'URL et l'UI fixe qui apparaît après coup.
  tickTimer = setInterval(onTick, 1500);
  window.addEventListener('popstate', onTick);
}

start();
