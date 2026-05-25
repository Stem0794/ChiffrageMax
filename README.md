# ChiffrageMax

Application web (SPA) **100 % frontend** pour gérer des chiffrages de projets, hébergeable sur **GitHub Pages**. Aucune étape de build, aucun backend.

L'application lit et écrit directement dans **Google Sheets** et **Google Drive** via leurs API REST, avec authentification **OAuth** par Google Identity Services (GIS).

> **Sécurité** : aucun secret au sens strict n'est stocké dans le dépôt. L'**OAuth Client ID** d'une application Web n'est *pas* un secret (il circule en clair dans chaque requête OAuth) : il est désormais **embarqué dans l'app** pour permettre un partage immédiat avec vos collègues, sans configuration. L'accès reste protégé par la connexion Google de chacun. Chaque utilisateur peut tout de même **surcharger** le Client ID (et l'ID du modèle) via ⚙️ Configuration ; sa valeur prime et reste **locale au navigateur** (localStorage). Le reste (modèle, dossiers, clients, TJM) est synchronisé dans votre Drive personnel.

## Fonctionnalités

### Tableau de bord
- **Scan automatique** des dossiers Drive de chaque client à la recherche des fichiers `CHI-*` (pas de classeur maître).
- **Chargement progressif** client par client avec barre de progression, limiteur de débit et cache local (voir *Performances*).
- **Affichage instantané** au rechargement : les données du dernier scan sont affichées immédiatement, puis rafraîchies en arrière-plan (*stale-while-revalidate*).
- **Sélecteur de client**, **filtres par statut** et **tri** par colonne (clic sur l'en-tête).
- **Édition en ligne** des cellules : n° devis, client (menu déroulant), projet, date (sélecteur), ticket. Le fichier Drive est **renommé automatiquement** quand le projet ou la date change ; il est **déplacé** dans le bon dossier `année/mois` quand le client change.
- **Statut** (`Envoyé`, `Validé`, `Passé en TMA`, `Refusé`, `Annulé`) modifiable via un menu déroulant écrit dans la feuille.
- **Montant** extrait automatiquement (ligne `TOTAL ... WITHOUT VAT`), cliquable pour rafraîchir.
- **Archiver** (🗃) : ajoute `[ARCH]` au nom du fichier, qui est alors ignoré lors des scans suivants (zéro appel API).
- **Supprimer** (🗑) : supprime définitivement le Google Sheet.

### Nouveau chiffrage
- Crée un classeur à partir d'un **modèle** (`ModeleChiffrage`), le range dans `dossier client / année / mois`, génère les phases et items, applique les **rôles/TJM** du client, puis l'ajoute au tableau de bord sans tout recharger.

### Statistiques
Onglet dédié, accessible via le menu de navigation, avec graphiques SVG (sans dépendance externe) :
- **Répartition par statut** : donut + légende détaillée (nombre, pourcentage, montant).
- **Tunnel de conversion** : Créés → Envoyés → Validés, avec taux de conversion entre chaque étape.
- Filtrable par client (ou tous les clients).

## Configuration Google Cloud (une fois)

1. Créez un projet sur [console.cloud.google.com](https://console.cloud.google.com/).
2. Activez **Google Sheets API** et **Google Drive API**.
3. Configurez l'écran de consentement OAuth.
4. Créez un identifiant **OAuth 2.0 Client ID** de type *application Web*.
5. Dans **Authorized JavaScript origins**, ajoutez l'URL de votre site, par ex. :
   - `https://<votre-utilisateur>.github.io`
   - `http://localhost:8000` (pour les tests locaux)
6. Copiez le **Client ID** (`...apps.googleusercontent.com`).

## Configuration de l'application

Le **Client ID OAuth** et (optionnellement) l'**ID du modèle** sont embarqués dans l'app — vos collègues n'ont donc **rien à configurer** pour démarrer : ils se connectent avec leur compte Google et c'est tout. Pour personnaliser, ouvrez ⚙️ et renseignez :

- **OAuth Client ID** : pré-rempli avec la valeur embarquée. Surchargez-le seulement si vous utilisez votre propre projet Google Cloud.
- **ID du modèle** : l'ID ou l'URL du Google Sheet servant de modèle (`ModeleChiffrage`/`Chiffrage`). S'il est embarqué dans l'app, partagez-le en lecture avec les comptes Google de vos collègues.
- **Dossier Drive racine (fallback)** : utilisé si un client n'a pas de dossier propre.
- **Clients** : pour chaque client, un nom et un dossier Drive racine. Le bouton 💰 permet de configurer les rôles et TJM par client.

> Pour embarquer votre propre modèle, collez son ID dans la constante `BAKED.templateId` de `js/config.js`. Pour changer le Client ID embarqué, modifiez `BAKED.clientId` dans le même fichier.

La configuration (modèle, dossiers, clients, rôles/TJM) est sauvegardée dans un fichier `ChiffrageMax-Config.json` de votre Drive, donc partagée entre vos appareils. Le Client ID, lui, reste local au navigateur.

## Performances et quotas

L'API Sheets est limitée à ~60 lectures/minute/utilisateur. Plusieurs mécanismes évitent les erreurs `429` :

- **1 seul appel par fichier** : lecture en une fois (`spreadsheets.get?includeGridData`) des titres d'onglets et des valeurs.
- **Cache local par `modifiedTime`** : un fichier inchangé depuis le dernier scan n'engendre aucun appel API.
- **Limiteur de débit** côté client (~50 lectures/min, avec rafales) + **réessais** avec backoff exponentiel sur les `429`.
- **Fichiers `[ARCH]`** ignorés avant tout appel.

## Test en local

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

(L'origine `http://localhost:8000` doit figurer dans les *Authorized JavaScript origins* OAuth.)

## Déploiement GitHub Pages

1. Poussez le dépôt sur GitHub.
2. **Settings → Pages** → *Source* : branche principale, dossier `/ (root)`.
3. Ajoutez l'URL Pages dans les *Authorized JavaScript origins* OAuth.

Aucune étape de build : les fichiers sont servis tels quels.

## Structure du projet

| Fichier | Rôle |
|---|---|
| `index.html` | Structure de la page (login, navigation, tableau de bord, statistiques, modales). |
| `css/styles.css` | Thème sombre et styles. |
| `js/auth.js` | OAuth GIS ; jeton persisté en localStorage (survit au redémarrage du navigateur). |
| `js/api.js` | Appels REST Sheets/Drive, limiteur de débit, réessais `429`. |
| `js/config.js` | Configuration locale (clientId) et sérialisation Drive. |
| `js/drive-config.js` | Persistance de la configuration dans `ChiffrageMax-Config.json`. |
| `js/chiffrage.js` | Création de chiffrages, scan Drive, lecture/cache des fichiers. |
| `js/app.js` | Interface : tableau de bord, édition, filtres, navigation, statistiques. |
| `js/utils.js` | Fonctions utilitaires (dates, IDs, formats). |
