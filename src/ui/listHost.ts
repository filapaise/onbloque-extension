/** Demande une permission d'hôte optionnelle depuis l'UI (geste utilisateur). */

const BUILTIN = new Set([
  'https://x.com',
  'https://twitter.com',
]);

export async function ensureListHostFromUi(listUrl: string): Promise<void> {
  if (!listUrl.trim()) return;
  let url: URL;
  try {
    url = new URL(listUrl);
  } catch {
    throw new Error('URL de liste invalide.');
  }
  if (url.protocol !== 'https:') throw new Error('Seules les URL https sont acceptées.');
  if (BUILTIN.has(url.origin)) return;
  const originPattern = `${url.origin}/*`;
  const have = await chrome.permissions.contains({ origins: [originPattern] });
  if (have) return;
  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) throw new Error(`Permission refusée pour ${url.origin}.`);
}
