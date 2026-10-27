import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  EDGE_MARGIN,
  FAB_SIZE,
  POS_KEY,
  clampPosition,
  defaultPosition,
  dragTo,
  isLeftHalf,
  loadPosition,
  opensDownward,
  parseStoredPosition,
  rectFor,
  resolveOverlap,
  savePosition,
  intersects,
  type PosStorage,
  type Rect,
} from '../src/content/fabPosition.ts';

const DESKTOP = [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];
const MOBILE = [
  { width: 375, height: 667 },
  { width: 414, height: 896 },
];

/** UI fixe connue de X (approximations mesurées). */
function messagesDrawer(vp: { width: number; height: number }): Rect {
  // Tiroir Messages : ~400 × 53 px, collé en bas à droite (marge ~20 px).
  return { left: vp.width - 20 - 400, top: vp.height - 53, right: vp.width - 20, bottom: vp.height };
}
function grokPill(vp: { width: number; height: number }): Rect {
  // Pastille Grok flottante ~56 px juste au-dessus du tiroir.
  return { left: vp.width - 20 - 56, top: vp.height - 53 - 12 - 56, right: vp.width - 20, bottom: vp.height - 53 - 12 };
}
function mobileTabBar(vp: { width: number; height: number }): Rect {
  return { left: 0, top: vp.height - 53, right: vp.width, bottom: vp.height };
}
function mobileComposeFab(vp: { width: number; height: number }): Rect {
  // Bouton rond « Poster » au-dessus de la barre d'onglets.
  return { left: vp.width - 16 - 56, top: vp.height - 53 - 16 - 56, right: vp.width - 16, bottom: vp.height - 53 - 16 };
}
function leftSidebarPost(): Rect {
  // Bouton « Poster » de la barre latérale gauche (bureau).
  return { left: 90, top: 560, right: 320, bottom: 612 };
}

function memStorage(initial: Record<string, unknown> = {}): PosStorage & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (k) => ({ [k]: data[k] }),
    set: async (items) => void Object.assign(data, items),
  };
}

describe('floating button — default position avoids X fixed UI', () => {
  for (const vp of DESKTOP) {
    it(`desktop ${vp.width}×${vp.height}`, () => {
      const r = rectFor(clampPosition(defaultPosition(vp), vp), vp);
      for (const o of [messagesDrawer(vp), grokPill(vp), leftSidebarPost()]) {
        assert.equal(intersects(r, o), false, JSON.stringify({ r, o }));
      }
      assert.ok(r.left >= 0 && r.top >= 0 && r.right <= vp.width && r.bottom <= vp.height);
    });
  }
  for (const vp of MOBILE) {
    it(`mobile ${vp.width}×${vp.height}`, () => {
      const r = rectFor(clampPosition(defaultPosition(vp), vp), vp);
      for (const o of [mobileTabBar(vp), mobileComposeFab(vp)]) {
        assert.equal(intersects(r, o), false, JSON.stringify({ r, o }));
      }
    });
  }
  it('button is compact', () => {
    assert.ok(FAB_SIZE <= 44);
  });
});

describe('floating button — clamping', () => {
  const vp = { width: 1280, height: 800 };
  it('keeps the button fully inside the viewport', () => {
    assert.deepEqual(clampPosition({ right: -50, bottom: -10 }, vp), { right: EDGE_MARGIN, bottom: EDGE_MARGIN });
    assert.deepEqual(clampPosition({ right: 5000, bottom: 5000 }, vp), {
      right: vp.width - FAB_SIZE - EDGE_MARGIN,
      bottom: vp.height - FAB_SIZE - EDGE_MARGIN,
    });
  });
  it('re-clamps a saved position after the window shrinks', () => {
    const saved = { right: 1100, bottom: 700 };
    const small = { width: 400, height: 500 };
    const c = clampPosition(saved, small);
    const r = rectFor(c, small);
    assert.ok(r.left >= EDGE_MARGIN && r.top >= EDGE_MARGIN);
  });
  it('survives a tiny viewport', () => {
    const c = clampPosition({ right: 30, bottom: 30 }, { width: 20, height: 20 });
    assert.ok(Number.isFinite(c.right) && Number.isFinite(c.bottom));
  });
  it('drag moves with the pointer and stays clamped', () => {
    const start = { right: 20, bottom: 140 };
    assert.deepEqual(dragTo(start, -100, -50, vp), { right: 120, bottom: 190 });
    assert.deepEqual(dragTo(start, 500, 500, vp), { right: EDGE_MARGIN, bottom: EDGE_MARGIN });
  });
  it('picks label/menu direction from position', () => {
    assert.equal(isLeftHalf({ right: 20, bottom: 140 }, vp), false);
    assert.equal(isLeftHalf({ right: 1200, bottom: 140 }, vp), true);
    assert.equal(opensDownward({ right: 20, bottom: 140 }, vp, 150), false);
    assert.equal(opensDownward({ right: 20, bottom: 740 }, vp, 150), true);
  });
});

describe('floating button — overlap nudge', () => {
  const vp = { width: 1280, height: 800 };
  const probeFor = (obstacles: Rect[]) => (r: Rect) => obstacles.filter((o) => intersects(r, o));

  it('no obstacle → unchanged', () => {
    assert.deepEqual(resolveOverlap({ right: 20, bottom: 140 }, vp, probeFor([])), { right: 20, bottom: 140 });
  });
  it('moves above an overlapping fixed element', () => {
    const drawer = messagesDrawer(vp);
    const pos = resolveOverlap({ right: 20, bottom: 10 }, vp, probeFor([drawer]));
    assert.equal(intersects(rectFor(pos, vp), drawer), false);
    assert.ok(pos.bottom > 53);
  });
  it('climbs over stacked elements (drawer + Grok pill)', () => {
    const obs = [messagesDrawer(vp), grokPill(vp)];
    const pos = resolveOverlap({ right: 30, bottom: 10 }, vp, probeFor(obs));
    for (const o of obs) assert.equal(intersects(rectFor(pos, vp), o), false);
  });
  it('mobile: clears tab bar and compose button', () => {
    const m = { width: 375, height: 667 };
    const obs = [mobileTabBar(m), mobileComposeFab(m)];
    const pos = resolveOverlap({ right: 16, bottom: 20 }, m, probeFor(obs));
    for (const o of obs) assert.equal(intersects(rectFor(pos, m), o), false);
  });
  it('full-height obstacle → falls back to the base position (no runaway)', () => {
    const wall: Rect = { left: 0, top: 0, right: vp.width, bottom: vp.height };
    assert.deepEqual(resolveOverlap({ right: 20, bottom: 140 }, vp, probeFor([wall])), { right: 20, bottom: 140 });
  });
  it('always starts from the base (no cumulative drift)', () => {
    const drawer = messagesDrawer(vp);
    const a = resolveOverlap({ right: 20, bottom: 10 }, vp, probeFor([drawer]));
    const b = resolveOverlap({ right: 20, bottom: 10 }, vp, probeFor([drawer]));
    assert.deepEqual(a, b);
  });
});

describe('floating button — persistence', () => {
  const vp = { width: 1280, height: 800 };
  it('default when nothing is stored', async () => {
    assert.deepEqual(await loadPosition(memStorage(), vp), clampPosition(defaultPosition(vp), vp));
  });
  it('default when storage is unavailable or throws', async () => {
    assert.deepEqual(await loadPosition(undefined, vp), clampPosition(defaultPosition(vp), vp));
    const broken: PosStorage = { get: async () => { throw new Error('Extension context invalidated'); }, set: async () => {} };
    assert.deepEqual(await loadPosition(broken, vp), clampPosition(defaultPosition(vp), vp));
  });
  it('save → load round-trip, clamped', async () => {
    const s = memStorage();
    const saved = await savePosition(s, { right: 300, bottom: 5000 }, vp);
    assert.deepEqual(saved, { right: 300, bottom: vp.height - FAB_SIZE - EDGE_MARGIN });
    assert.deepEqual(s.data[POS_KEY], saved);
    assert.deepEqual(await loadPosition(s, vp), saved);
  });
  it('ignores malformed stored values', async () => {
    for (const bad of [null, 'x', 42, { right: 'a', bottom: 1 }, { right: NaN, bottom: 1 }, { right: -5, bottom: 1 }, { right: 1e9, bottom: 1 }]) {
      assert.equal(parseStoredPosition(bad), null);
      assert.deepEqual(await loadPosition(memStorage({ [POS_KEY]: bad }), vp), clampPosition(defaultPosition(vp), vp));
    }
  });
  it('only stores right/bottom numbers', async () => {
    const s = memStorage();
    await savePosition(s, { right: 50, bottom: 60, evil: '<img>' } as never, vp);
    assert.deepEqual(Object.keys(s.data[POS_KEY] as object).sort(), ['bottom', 'right']);
  });
});

describe('floating button — security rules in the content script', () => {
  const src = readFileSync(new URL('../src/content/inject.ts', import.meta.url), 'utf8');
  it('no innerHTML / outerHTML / insertAdjacentHTML', () => {
    assert.doesNotMatch(src, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML/);
  });
  it('no longer injects itself into X navigation', () => {
    assert.doesNotMatch(src, /nav\.appendChild/);
  });
  it('only sends OPEN_PREVIEW / GET_PROGRESS', () => {
    const types = [...src.matchAll(/sendMessage\(\{\s*type:\s*'([A-Z_]+)'/g)].map((m) => m[1]);
    assert.ok(types.length > 0);
    for (const t of types) assert.ok(t === 'OPEN_PREVIEW' || t === 'GET_PROGRESS', t);
  });
  it('accepts progress pushes only from its own service worker', () => {
    assert.match(src, /sender\.id !== chrome\.runtime\.id \|\| sender\.tab/);
    assert.match(src, /parseFabProgress\(/);
  });
});
