# OnBloque — #OnBloquelExtremeDroite

<p align="center"><img src="store/assets/promo-small-440x280.png" alt="OnBloque — #OnBloquelExtremeDroite" width="440"></p>

**OnBloque** est une extension Chrome / Chromium (Manifest V3) qui vous aide à **bloquer sur X (Twitter) les comptes d’extrême droite** d’une liste partagée — dans l’esprit de la campagne citoyenne **#OnBloquelExtremeDroite**.

Une liste de départ est embarquée (import public du répertoire Blockfacho / [onbloquelextremedroite.fun](https://onbloquelextremedroite.fun/site)). Vous pouvez aussi utiliser votre propre liste.

> 🕐 **Version Chrome Web Store en cours de validation.** En attendant, vous pouvez l’installer en mode développeur (2 minutes, voir ci-dessous).

## Fonctionnalités

- **Aperçu avant blocage** : rien ne part sans votre confirmation. Vous cochez / décochez compte par compte.
- **Comptes protégés** : votre propre compte, les comptes que vous suivez et ceux qui vous suivent sont exclus par défaut ; liste blanche personnelle.
- **Plafond journalier** + délais aléatoires + pauses, pour rester sous les radars de X.
- **Rythmes** au choix :
  - **Prudent** (par défaut) — ~50 blocages / jour
  - **Normal** — ~200 / jour
  - **Max** — 500 / jour, espacés de 45 à 90 s avec des pauses
- **File d’attente en arrière-plan** : pause / reprise depuis le popup, journal local.
- **Reprise automatique** : si X limite les requêtes, la file attend l’heure annoncée par X puis repart toute seule. Un compte supprimé ou suspendu est simplement ignoré, la file continue.
- **Diagnostic** (Réglages) : dernières erreurs techniques (endpoint, code HTTP), sans aucune donnée de session, pour signaler un problème.
- **Bouton intégré à x.com** : « Bloquer les comptes de cette page » / « Bloquer toute la liste » (toujours via l’aperçu).
- Listes au format JSON, CSV ou texte (coller, importer un fichier ou URL https).

## Captures

*Captures réalisées avec des données de démonstration (compte fictif @demo_user, comptes fictifs).*

![Popup : la file avance au rythme choisi, avec un plafond journalier](store/assets/screenshot-01-popup.png)
*Le popup : progression du jour, comptes en attente, bloqués et ignorés, pause / reprise.*

![Aperçu avant blocage](store/assets/screenshot-03-preview.png)
*L’aperçu : vous cochez les comptes à bloquer. Les comptes que vous suivez, votre liste blanche, les comptes déjà bloqués et ceux introuvables sur X sont décochés.*

![Réglages](store/assets/screenshot-02-options.png)
*Les réglages : rythme (Prudent, Normal, Max), liste, comptes protégés, historique et diagnostic.*

![Reprise automatique après une limite X](store/assets/screenshot-04-reprise-auto.png)
*Si X limite les requêtes, la file attend et reprend toute seule à l’heure indiquée.*

![Fonctionnalités](store/assets/screenshot-05-features.png)
*En résumé : liste partagée, aperçu obligatoire, comptes protégés, rythme raisonnable.*

## Installation en mode développeur (depuis la release)

1. Allez dans l’onglet **[Releases](https://github.com/filapaise/onbloque-extension/releases)** et téléchargez le fichier `onbloque-x.y.z.zip` de la dernière version.
2. **Décompressez** le zip dans un dossier que vous garderez (ex. `Documents/OnBloque`). Ne le supprimez pas ensuite : Chrome charge l’extension depuis ce dossier.
3. Ouvrez Chrome et allez sur `chrome://extensions`.
4. Activez le **Mode développeur** (interrupteur en haut à droite).
5. Cliquez sur **Charger l’extension non empaquetée** et sélectionnez le dossier décompressé (celui qui contient `manifest.json`).
6. Épinglez l’icône OnBloque (pièce de puzzle 🧩 → épingle).
7. Connectez-vous à [x.com](https://x.com) dans le même profil Chrome.
8. Cliquez sur l’icône OnBloque → **Aperçu / lancer un blocage**, vérifiez la liste, puis **Démarrer le blocage des comptes cochés**.

**Mettre à jour** : téléchargez le nouveau zip, remplacez le contenu du dossier, puis cliquez sur ↻ (Recharger) sur la carte OnBloque dans `chrome://extensions`.

Fonctionne aussi sur Brave, Edge, Vivaldi, Arc (tous basés sur Chromium).

## Compiler depuis les sources

Prérequis : Node.js 20+.

```bash
git clone https://github.com/filapaise/onbloque-extension.git
cd onbloque-extension
npm install
npm run typecheck
npm test
npm run build      # → dist/ (à charger comme « extension non empaquetée »)
npm run zip        # → release/onbloque-<version>.zip
npm run validate
```

### Structure

| Chemin | Rôle |
|--------|------|
| `src/domain/` | Types, lecture des listes, file, aperçu (sans Chrome) |
| `src/infra/` | `chrome.storage`, client des endpoints x.com |
| `src/application/` | Services liste / aperçu / file |
| `src/background/` | Service worker MV3 + validation des messages |
| `src/content/` | Bouton sur x.com + collecte des @ visibles |
| `src/ui/` | Popup, options, aperçu |
| `lists/seed.json` | Liste embarquée (import Blockfacho) |
| `static/` | HTML / CSS / manifest / icônes |
| `tests/` | Tests unitaires (`node --test`) |

### Format de liste `onbloque-list/1`

```json
{
  "format": "onbloque-list/1",
  "name": "Ma liste",
  "source_url": "https://exemple.org/liste.json",
  "updated": "2026-10-27",
  "entries": [
    { "handle": "Exemple", "id": "123", "category": "…", "source": "https://…" }
  ]
}
```

## Confidentialité (résumé)

- **Aucune collecte** : OnBloque n’envoie rien à l’éditeur, pas de serveur, pas de compte, pas de tracking.
- Tout est stocké **localement** dans votre navigateur (liste, liste blanche, file, réglages).
- Les seules requêtes réseau vont vers **x.com** (avec votre session déjà ouverte, pour bloquer à votre demande) et vers **l’URL de liste** choisie.
- Le jeton CSRF de session est lu à l’exécution, jamais stocké ni journalisé.

Politique complète : [PRIVACY.md](PRIVACY.md).

## Avertissement

L’extension utilise les mêmes endpoints web que le site x.com dans votre navigateur (pas l’API développeur officielle). Un usage trop agressif peut entraîner des restrictions temporaires de votre compte X : gardez le rythme **Prudent** si vous débutez. Utilisation à vos risques.

## Contact

Fil Apaisé — [@fil_apaise](https://x.com/fil_apaise) · `fil.apaise@gmail.com`

---

## English

**OnBloque** is a Chrome / Chromium (Manifest V3) extension that helps you **block far-right accounts on X (Twitter)** from a shared list, as part of the French citizen campaign **#OnBloquelExtremeDroite**.

- **Preview before blocking** — nothing is blocked until you confirm.
- **Protected accounts** — yourself, accounts you follow / that follow you are excluded by default; personal allowlist.
- **Daily cap** with random delays and pauses; paces: Prudent (~50/day, default), Normal (~200/day), Max (500/day).
- **No data collection** — everything stays in your browser. See [PRIVACY.md](PRIVACY.md).

**Install (developer mode):** download the latest `onbloque-x.y.z.zip` from [Releases](https://github.com/filapaise/onbloque-extension/releases), unzip it, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select the unzipped folder. Log in to x.com in the same profile. A Chrome Web Store version is pending review.

**Build:** `npm install && npm test && npm run build` → load `dist/`.

## Licence

[MIT](LICENSE) © 2026 Fil Apaisé
