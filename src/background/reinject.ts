/**
 * Après une installation ou une mise à jour, les onglets x.com déjà ouverts gardent
 * l'ancien script de page (orphelin) ou n'en ont aucun. On y réinjecte les scripts
 * déclarés dans le manifeste, pour que le bouton OnBloque marche sans recharger.
 * Le script de page est idempotent (une seule instance vivante par onglet).
 */

type ContentScriptDecl = { matches?: string[]; js?: string[]; all_frames?: boolean };

export interface ReinjectApi {
  runtime: { getManifest: () => { content_scripts?: ContentScriptDecl[] } };
  tabs: { query: (q: { url: string[] }) => Promise<Array<{ id?: number; discarded?: boolean; url?: string }>> };
  scripting: {
    executeScript: (opts: { target: { tabId: number; allFrames?: boolean }; files: string[] }) => Promise<unknown>;
  };
}

/** Raisons de onInstalled qui justifient une réinjection (pas les mises à jour de Chrome). */
export function shouldReinject(reason: string | undefined): boolean {
  return reason === 'install' || reason === 'update';
}

/** Réinjecte les content scripts du manifeste ; renvoie le nombre d'onglets traités. */
export async function reinjectContentScripts(api: ReinjectApi): Promise<number> {
  const decls = api.runtime.getManifest().content_scripts ?? [];
  let injected = 0;
  for (const decl of decls) {
    const files = decl.js ?? [];
    const matches = decl.matches ?? [];
    if (!files.length || !matches.length) continue;
    let tabs: Array<{ id?: number; discarded?: boolean }> = [];
    try {
      tabs = await api.tabs.query({ url: matches });
    } catch {
      continue;
    }
    for (const tab of tabs) {
      if (tab.id == null || tab.discarded) continue;
      try {
        await api.scripting.executeScript({ target: { tabId: tab.id, allFrames: !!decl.all_frames }, files });
        injected++;
      } catch {
        /* onglet en erreur, fermé entre-temps ou page non scriptable : ignoré */
      }
    }
  }
  return injected;
}
