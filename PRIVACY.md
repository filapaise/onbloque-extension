# Politique de confidentialité — OnBloque

**Éditeur :** Fil Apaisé (`fil.apaise@gmail.com`)  
**Dernière mise à jour :** 27 octobre 2026  
**Extension :** OnBloque (Chrome / Chromium, Manifest V3)

## Résumé

OnBloque **ne collecte pas** de données personnelles, **n’envoie rien** à l’éditeur, et **n’utilise pas** de serveur tiers pour l’analyse ou la publicité. Tout le fonctionnement utile se passe **dans votre navigateur**, sur votre appareil.

## Données traitées localement

L’extension stocke uniquement dans `chrome.storage` (local / session) :

- la liste de comptes à bloquer (et son URL éventuelle) ;
- votre liste de comptes protégés (liste blanche) ;
- la file d’attente, les compteurs et le journal d’activité ;
- des réglages (rythme Prudent / Normal / Max).

Ces données **restent sur votre machine**. Elles ne sont pas synchronisées vers un compte Fil Apaisé ni vers un backend OnBloque (il n’y en a pas).

## Requêtes réseau

OnBloque peut effectuer des requêtes :

1. **vers `x.com` / `twitter.com`**, avec **votre session déjà ouverte** dans Chrome, uniquement pour : vérifier la connexion, résoudre un identifiant, consulter des relations, créer ou retirer un blocage — **à votre demande** (après aperçu) ou pour poursuivre une file que vous avez lancée ;
2. **vers l’URL de liste** que vous avez configurée (par défaut le domaine public Blockfacho `onbloquelextremedroite.fun`, ou une URL https que vous choisissez), uniquement pour télécharger la liste.

Aucun jeton, cookie ou contenu de message n’est recopié vers l’éditeur. Les journaux d’erreur locaux n’incluent pas les cookies ni le bearer.

## Ce que nous ne faisons pas

- pas de compte utilisateur OnBloque ;
- pas de tracking / analytics / publicité ;
- pas de revente de données ;
- pas d’accès à vos messages privés X au-delà des appels techniques listés ci-dessus, déclenchés pour le blocage.

## Partage avec des tiers

Aucun partage avec des tiers à des fins commerciales. Les seuls destinataires techniques des requêtes sont les serveurs de X (et, le cas échéant, l’hébergeur de **votre** URL de liste).

## Conservation et suppression

Les données locales existent tant que l’extension est installée. Pour les effacer : utilisez « Réinitialiser » dans les réglages, ou désinstallez l’extension.

## Contact

Questions privacy : `fil.apaise@gmail.com`

## Modifications

Toute mise à jour notable de cette politique sera datée en tête de document.
