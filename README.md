# OnBloque

Une extension Chrome pour bloquer d'un coup les comptes d'extrême droite sur X. #OnBloquelExtremeDroite

### 👉 [Installer depuis le Chrome Web Store](https://chromewebstore.google.com/detail/afphjkpbheomoenndpopehkkfifmpiam)

[![Disponible sur le Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Installer%20OnBloque-4285F4?logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/afphjkpbheomoenndpopehkkfifmpiam)

Un clic sur **Ajouter à Chrome**, puis va sur [x.com](https://x.com) et clique sur le bouton **OnBloque** (le petit rond en bas à droite). C'est tout.

<details>
<summary>Ou installer à la main depuis GitHub (dernière version)</summary>

La version GitHub a parfois un peu d'avance sur le store.

1. Télécharge le zip de la [dernière version](https://github.com/filapaise/onbloque-extension/releases/latest) et décompresse-le dans un dossier que tu gardes.
2. Ouvre `chrome://extensions` et active le **Mode développeur** (en haut à droite).
3. Clique sur **Charger l'extension non empaquetée** et choisis le dossier décompressé.
4. Va sur [x.com](https://x.com) et clique sur le bouton **OnBloque**.

</details>

<p><img src="store/assets/screenshot-01-popup.png" alt="Le popup OnBloque" width="420"></p>

Ça marche aussi sur Brave, Edge, Vivaldi et Arc.

---

## C'est quoi

J'en avais marre de bloquer les comptes un par un, alors j'ai vibe codé une extension qui le fait pour moi.

La liste de départ vient du répertoire Blockfacho ([onbloquelextremedroite.fun](https://onbloquelextremedroite.fun/site)). Tu peux aussi mettre ta propre liste.

## Ce que ça fait

- **Tu vois la liste avant.** Rien n'est bloqué sans ton accord, tu coches et décoches qui tu veux.
- **Les gens que tu suis sont protégés.** Ton compte, ceux que tu suis et ceux qui te suivent sont exclus. Tu peux aussi ajouter des comptes à épargner.
- **Ça va doucement, exprès.** Il y a une limite par jour et une attente entre deux blocages, pour que X ne prenne pas ton compte pour un robot.
  - Prudent (par défaut) : 50 par jour au plus, un blocage toutes les 20 à 45 s, et une pause de 2 min tous les 10 (environ 30 min pour 50)
  - Normal : 200 par jour, un blocage toutes les 25 à 55 s, et une pause de 3 min tous les 15 (environ 2 h 45 pour 200)
  - Max : 500 par jour, un blocage toutes les 45 à 90 s, et une pause de 5 min tous les 20 (environ 11 h pour 500)
  - Dans **Réglages avancés** (sous les trois rythmes), tu peux choisir toi-même le délai minimum et maximum, 15 s au plus court. Plus c'est rapide, plus X risque de restreindre ton compte. Recliquer sur un rythme remet ses valeurs.
  - Le délai se compte d'un blocage au suivant. Quand Chrome met l'extension en veille, il peut ajouter quelques secondes.
- **Tu peux viser seulement les gros comptes.** Avec le « Seuil d'abonnés » dans les réglages (1 000, 10 000, 50 000, 100 000 ou ton chiffre), les plus petits ne sont pas bloqués et sont comptés à part. Désactivé par défaut.
- **Tu vois où ça en est.** Compte à rebours avant le prochain blocage, barre de progression, dernier compte bloqué, heure de fin estimée. Le badge sur l'icône montre combien il en reste.
- **Ça tourne en fond.** Tu peux mettre en pause et reprendre quand tu veux. Garde juste un onglet x.com ouvert.
- **Ça repart tout seul.** Si X ralentit, la file attend puis reprend. Un compte supprimé est juste ignoré.
- Listes en JSON, CSV ou texte (à coller, en fichier ou par URL https).

## Captures

*Le popup et les réglages sont de vraies captures. L'aperçu et la reprise automatique sont montrés avec des comptes fictifs.*

![Aperçu avant blocage](store/assets/screenshot-03-preview.png)
*L'aperçu : tu choisis qui bloquer. Les comptes que tu suis, ceux déjà bloqués et ceux qui n'existent plus sont décochés.*

![Réglages](store/assets/screenshot-02-options.png)
*Les réglages : rythme (avec réglages avancés du délai), liste, comptes protégés, historique.*

![Reprise automatique](store/assets/screenshot-04-reprise-auto.png)
*Si X limite les requêtes, la file attend et repart toute seule.*

![En résumé](store/assets/screenshot-05-features.png)

## Mettre à jour

Depuis le Chrome Web Store, les mises à jour se font toutes seules.

Si tu l'as installée à la main : télécharge le nouveau zip, remplace le contenu du dossier, puis clique sur ↻ (Recharger) sur la carte OnBloque dans `chrome://extensions`.

## Tes données

- Rien n'est envoyé ailleurs. Pas de serveur, pas de compte, pas de pistage.
- Tout reste dans ton navigateur : la liste, les réglages, la file.
- L'extension parle seulement à x.com (avec ta session déjà ouverte) et à l'URL de liste que tu choisis.
- Le jeton de session est lu au moment du blocage, jamais enregistré.

Le détail : [PRIVACY.md](PRIVACY.md).

## À savoir

L'extension utilise les mêmes requêtes que le site x.com dans ton navigateur, pas l'API officielle. Si tu bloques trop vite, X peut restreindre ton compte un moment. Si tu débutes, reste en Prudent. À tes risques.

## Compiler depuis les sources

Il te faut Node.js 20 ou plus.

```bash
git clone https://github.com/filapaise/onbloque-extension.git
cd onbloque-extension
npm install
npm test
npm run build      # → dist/, à charger comme extension non empaquetée
npm run zip        # → release/onbloque-<version>.zip
```

| Dossier | Rôle |
|--------|------|
| `src/domain/` | Types, lecture des listes, file, aperçu |
| `src/infra/` | Stockage Chrome, requêtes x.com |
| `src/application/` | Services liste, aperçu, file |
| `src/background/` | Service worker et validation des messages |
| `src/content/` | Bouton sur x.com |
| `src/ui/` | Popup, réglages, aperçu |
| `lists/seed.json` | Liste de départ |
| `tests/` | Tests (`node --test`) |

Format de liste `onbloque-list/1` :

```json
{
  "format": "onbloque-list/1",
  "name": "Ma liste",
  "entries": [
    { "handle": "Exemple", "id": "123" }
  ]
}
```

## Contact

[@fil_apaise](https://x.com/fil_apaise) · `fil.apaise@gmail.com`

---

## English

A Chrome extension to block far-right accounts on X from a shared list. #OnBloquelExtremeDroite

**Install:** [get it on the Chrome Web Store](https://chromewebstore.google.com/detail/afphjkpbheomoenndpopehkkfifmpiam). Or install by hand: download the zip from [the latest release](https://github.com/filapaise/onbloque-extension/releases/latest) and unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder. Then go to x.com and click the OnBloque button.

- You see the list first and pick who gets blocked.
- People you follow, and people who follow you, are skipped.
- Optional follower threshold: only block accounts with at least N followers (1k / 10k / 50k / 100k or custom). Off by default.
- Daily cap and slow pace on purpose (Max: one block every 45–90 s, 5-minute pause every 20, 500 a day), so X doesn't flag your account. Advanced settings let you pick your own delay (15 s minimum).
- Nothing leaves your browser. See [PRIVACY.md](PRIVACY.md).

**Build:** `npm install && npm test && npm run build`, then load `dist/`.

## Licence

[MIT](LICENSE) © 2026 Fil Apaisé
