/**
 * Content script : bouton flottant / ancré dans l'UI x.com.
 * N'exécute jamais de blocage directement — ouvre l'aperçu via messaging.
 */
import { collectHandlesFromPage } from './collect.ts';
import { sendMessage } from '../shared/messages.ts';

const ROOT_ID = 'onbloque-fab-root';
const STYLE_ID = 'onbloque-fab-style';

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${ROOT_ID}{position:fixed;z-index:9999;right:16px;bottom:88px;font-family:system-ui,-apple-system,sans-serif}
#${ROOT_ID} .ob-panel{display:none;flex-direction:column;gap:6px;margin-bottom:8px;background:#0f1419;color:#e7e9ea;border:1px solid #2f3336;border-radius:14px;padding:10px;min-width:220px;box-shadow:0 8px 28px rgba(0,0,0,.35)}
#${ROOT_ID}.open .ob-panel{display:flex}
#${ROOT_ID} button{appearance:none;border:0;border-radius:999px;padding:10px 14px;font-size:13px;font-weight:600;cursor:pointer}
#${ROOT_ID} .ob-main{background:#1d9bf0;color:#fff;box-shadow:0 4px 16px rgba(29,155,240,.35)}
#${ROOT_ID} .ob-main:hover{background:#1a8cd8}
#${ROOT_ID} .ob-action{background:#16181c;color:#e7e9ea;border:1px solid #2f3336;text-align:left}
#${ROOT_ID} .ob-action:hover{background:#1e2126}
#${ROOT_ID} .ob-hint{font-size:11px;color:#8b98a5;padding:0 4px 4px}
#${ROOT_ID}.nav{position:static;right:auto;bottom:auto;margin:8px 12px}
#${ROOT_ID}.nav .ob-main{width:100%}
`;
  document.documentElement.appendChild(style);
}

function buildRoot(): HTMLElement {
  let root = document.getElementById(ROOT_ID);
  if (root) return root;
  root = document.createElement('div');
  root.id = ROOT_ID;
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
  const main = document.createElement('button');
  main.type = 'button';
  main.className = 'ob-main';
  main.setAttribute('aria-expanded', 'false');
  main.title = 'OnBloque — comptes à bloquer';
  main.textContent = 'OnBloque';
  root.append(panel, main);
  return root;
}

function placeRoot(root: HTMLElement): void {
  // Ancres possibles dans la nav gauche de X (data-testid stables quand présents).
  const anchors: Array<Element | null | undefined> = [
    document.querySelector('[data-testid="AppTabBar_More_Menu"]')?.closest('nav'),
    document.querySelector('nav[role="navigation"]'),
    document.querySelector('[data-testid="SidebarNav"]'),
    document.querySelector('header[role="banner"] nav'),
  ];
  const nav = anchors.find((a): a is Element => !!a) as HTMLElement | undefined;
  root.classList.remove('nav');
  if (nav && !root.isConnected) {
    // Essayer d'ancrer en bas de la nav ; sinon flottant.
    try {
      root.classList.add('nav');
      nav.appendChild(root);
      return;
    } catch {
      /* fallback */
    }
  }
  if (!root.isConnected) {
    document.documentElement.appendChild(root);
  }
}

function wire(root: HTMLElement): void {
  if (root.dataset.wired === '1') return;
  root.dataset.wired = '1';
  const main = root.querySelector('.ob-main') as HTMLButtonElement;
  main.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.toggle('open');
    main.setAttribute('aria-expanded', root.classList.contains('open') ? 'true' : 'false');
  });
  root.querySelectorAll<HTMLButtonElement>('.ob-action').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      root.classList.remove('open');
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
        if (resp && !resp.ok) flash(root, explain(resp.error));
      } catch (err) {
        flash(root, explain((err as Error).message));
      }
    });
  });
  document.addEventListener(
    'click',
    (e) => {
      if (!root.contains(e.target as Node)) root.classList.remove('open');
    },
    true,
  );
}

/** Raison lisible côté page (jamais un faux « liste vide »). */
function explain(error: string | undefined): string {
  if (!error) return 'OnBloque ne répond pas. Rechargez la page.';
  if (/context invalidated|Receiving end does not exist/i.test(error)) {
    return 'L’extension a été rechargée : rechargez cette page x.com.';
  }
  return error;
}

function flash(root: HTMLElement, text: string): void {
  let el = root.querySelector('.ob-flash') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'ob-flash';
    el.style.cssText =
      'margin-bottom:8px;padding:8px 10px;border-radius:10px;background:#f4212e;color:#fff;font-size:12px;max-width:240px';
    root.insertBefore(el, root.firstChild);
  }
  el.textContent = text;
  setTimeout(() => el?.remove(), 6000);
}

function mount(): void {
  ensureStyle();
  const root = buildRoot();
  placeRoot(root);
  wire(root);
}

let lastUrl = location.href;
function onNav(): void {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
  }
  mount();
}

mount();

const obs = new MutationObserver(() => {
  if (!document.getElementById(ROOT_ID) || !document.getElementById(ROOT_ID)?.isConnected) {
    mount();
  }
});
obs.observe(document.documentElement, { childList: true, subtree: true });

// X est une SPA : surveiller l'URL.
setInterval(onNav, 1500);
window.addEventListener('popstate', onNav);

