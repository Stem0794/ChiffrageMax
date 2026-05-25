# ChiffrageMax

Application web (SPA) **100 % frontend** pour gérer des chiffrages de projets, hébergeable sur **GitHub Pages**. Aucune étape de build, aucun backend.

L'application lit et écrit directement dans **Google Sheets** et **Google Drive** via leurs API REST, avec authentification **OAuth** par Google Identity Services (GIS).

> **Sécurité** : aucun secret n'est stocké dans le dépôt. L'OAuth Client ID est saisi par l'utilisateur et conservé **uniquement dans le navigateur** (localStorage). Le reste de la configuration (modèle, dossiers, clients, TJM) est synchronisé dans votre Drive personnel.

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

Ouvrez l'application, connectez-vous, puis cliquez sur ⚙️ et renseignez :

- **OAuth Client ID** : l'identifiant créé ci-dessus (stocké uniquement dans le navigateur).
- **ID du modèle** : l'ID ou l'URL du Google Sheet servant de modèle (`ModeleChiffrage`/`Chiffrage`). Partagez-le en lecture avec votre compte.
- **Dossier Drive racine (fallback)** : utilisé si un client n'a pas de dossier propre.
- **Clients** : pour chaque client, un nom et un dossier Drive racine. Le bouton 💰 permet de configurer les rôles et TJM par client.

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
