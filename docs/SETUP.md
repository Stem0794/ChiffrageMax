# ChiffrageMax — Setup Guide (installation de A à Z pour une entreprise)

Ce guide décrit, pas à pas, comment déployer ChiffrageMax pour toute une équipe :
de la création du projet Google Cloud jusqu'à l'utilisation quotidienne par vos
chargés d'affaires. Comptez **30 à 60 minutes** pour la première mise en place.

> **Rien à coder.** L'application est 100 % frontend (HTML/CSS/JS, sans build).
> Vous l'hébergez telle quelle, et chaque utilisateur travaille avec **son propre
> compte Google** : les données restent dans **le Google Drive de l'entreprise**,
> ChiffrageMax n'a aucun serveur ni base de données intermédiaire.

---

## 0. Comprendre l'architecture (à lire avant de commencer)

```
┌────────────────────┐      OAuth (navigateur)      ┌──────────────────────┐
│  Navigateur de      │  ─────────────────────────▶ │  Google Sheets API   │
│  l'utilisateur      │                              │  Google Drive API    │
│  (ChiffrageMax,     │ ◀─────────────────────────  │                      │
│   GitHub Pages)     │      données JSON            └──────────────────────┘
└────────────────────┘                                         │
                                                               ▼
                                        Vos fichiers : Drive / Sheets de l'entreprise
```

- **Aucun backend ChiffrageMax** : l'app appelle directement les API Google depuis
  le navigateur. Vos chiffrages, votre config et vos clients ne transitent par
  aucun serveur tiers.
- **Authentification** : Google Identity Services (OAuth). Chaque utilisateur se
  connecte avec son compte Google d'entreprise (Workspace).
- **Stockage** :
  - Les **chiffrages** sont des Google Sheets `CHI-*` rangés dans des dossiers Drive.
  - La **configuration** (modèle, clients, TJM, timeline) est un fichier
    `ChiffrageMax-Config.json` dans le Drive de chaque utilisateur (ou partagé, voir §7).

### Ce qu'il faut préparer

| Élément | Qui | Une seule fois ? |
|---|---|---|
| Projet **Google Cloud** + OAuth Client ID | Admin | ✅ Oui |
| **Hébergement** de l'app (GitHub Pages) | Admin | ✅ Oui |
| **Google Sheet modèle** (`ModeleChiffrage`) | Admin | ✅ Oui |
| **Dossiers Drive** par client | Admin / chargé d'affaires | À la création de chaque client |
| **Configuration dans l'app** (⚙️) | Chaque utilisateur (ou partagée) | À la première connexion |

---

## 1. Récupérer le code

Deux options :

**A. Fork (recommandé)** — vous gardez votre propre copie, vous pourrez y embarquer
votre Client ID et y ajouter vos captures.

```bash
# Forkez le dépôt sur GitHub, puis :
git clone https://github.com/<votre-organisation>/ChiffrageMax.git
cd ChiffrageMax
```

**B. Hébergement interne** — copiez simplement les fichiers (`index.html`, `css/`,
`js/`, `manifest.json`, `favicon.svg`) sur n'importe quel serveur web statique
(Nginx, Apache, S3, IIS…). Aucune étape de build.

---

## 2. Configurer Google Cloud (le cœur de l'installation)

> 🔑 C'est l'étape la plus importante. Faites-la avec un compte **administrateur**
> du Google Workspace de l'entreprise.

### 2.1 Créer le projet

1. Allez sur [console.cloud.google.com](https://console.cloud.google.com/).
2. En haut, **Sélectionner un projet → Nouveau projet**. Nommez-le p. ex.
   `ChiffrageMax-Prod`. Créez.

### 2.2 Activer les API

Menu **API et services → Bibliothèque**, activez les **deux** :

- **Google Sheets API**
- **Google Drive API**

### 2.3 Écran de consentement OAuth

Menu **API et services → Écran de consentement OAuth**.

- **Type d'utilisateur** :
  - **Interne** (recommandé si vous avez Google Workspace) → seuls les comptes de
    votre organisation peuvent l'utiliser, **aucune vérification Google requise**,
    pas de limite de 100 utilisateurs, pas d'écran d'avertissement.
  - **Externe** → nécessaire si vos utilisateurs ont des comptes Gmail hors
    Workspace. Tant que l'app n'est pas **vérifiée** par Google, elle est plafonnée
    à 100 utilisateurs de test et affiche un avertissement « application non
    vérifiée ». Pour un usage entreprise, préférez **Interne**.
- Renseignez le **nom de l'app** (`ChiffrageMax`), l'**e-mail de support** et un
  e-mail développeur.
- **Scopes** : ajoutez les deux scopes utilisés par l'app :
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`

  > Ce sont des scopes « sensibles/restreints ». En mode **Interne** aucune
  > vérification n'est nécessaire. En mode **Externe**, leur usage déclenche une
  > procédure de vérification Google (avec preuve d'usage et éventuel audit).

### 2.4 Créer l'identifiant OAuth (Client ID)

Menu **API et services → Identifiants → Créer des identifiants → ID client OAuth**.

1. **Type d'application** : *Application Web*.
2. **Nom** : `ChiffrageMax Web`.
3. **Origines JavaScript autorisées** — ajoutez **exactement** les URL d'où l'app
   sera servie (sans chemin, sans `/` final) :
   - `https://<votre-organisation>.github.io` (déploiement GitHub Pages)
   - `http://localhost:8000` (tests locaux)
   - le cas échéant, votre domaine interne : `https://chiffrage.entreprise.com`
4. **Créez**, puis copiez le **Client ID** (`...apps.googleusercontent.com`).

> ⚠️ Si l'origine ne correspond pas exactement, la connexion échoue avec une
> erreur `redirect_uri_mismatch` / `origin not allowed`. C'est la cause n°1 de
> blocage. Le port compte (`:8000`), le `https` aussi.

---

## 3. Héberger l'application (GitHub Pages)

1. Poussez votre fork sur GitHub.
2. **Settings → Pages** → *Source* : branche principale, dossier **`/ (root)`**.
3. Attendez l'URL publiée, p. ex. `https://<votre-organisation>.github.io/ChiffrageMax/`.
4. Vérifiez que cette URL d'origine figure bien dans les **Origines JavaScript
   autorisées** (étape 2.4). Sinon, ajoutez-la.

> Hébergement interne ? Servez simplement le dossier en HTTPS et ajoutez son
> origine dans les identifiants OAuth. Aucun build, aucune variable serveur.

### (Optionnel) Embarquer le Client ID pour que l'équipe n'ait rien à saisir

Par défaut, rien n'est embarqué (`js/config.js`). Pour un déploiement **interne
maîtrisé**, vous pouvez pré-remplir le Client ID et l'ID du modèle :

```js
// js/config.js
const BAKED = {
  clientId:   '....apps.googleusercontent.com', // votre Client ID
  templateId: '1AbC...XyZ',                      // ID du Sheet modèle (voir §4)
};
```

> ✅ Avantage : vos collègues se connectent et c'est tout.
> ⚠️ À ne faire que pour **votre** déploiement privé. Ne committez jamais ces
> valeurs dans un dépôt **public** (vous routeriez le trafic OAuth d'inconnus par
> votre projet Google Cloud).

---

## 4. Créer le Google Sheet modèle (`ModeleChiffrage`)

ChiffrageMax génère chaque devis en **copiant un onglet modèle** puis en y insérant
les phases/items et les formules. La structure du modèle doit respecter ce format.

### 4.1 Créer le classeur

1. Créez un Google Sheet dans le Drive de l'entreprise, nommé p. ex.
   `ModeleChiffrage`.
2. Nommez l'**onglet** `ModeleChiffrage` (ou `Chiffrage`). L'app cherche d'abord un
   onglet `ModeleChiffrage`, puis `Chiffrage`, sinon le premier onglet.

### 4.2 Disposition attendue des cellules

| Emplacement | Contenu | Rempli par |
|---|---|---|
| **C1** | Client | l'app (à la création) |
| **C2** | Projet | l'app |
| **C3** | Ticket | l'app |
| **C4** | Date (`AAAA-MM-JJ`) | l'app |
| **C5** | N° de devis | l'app |
| **Ligne 6, colonnes B→L** | **Noms des rôles** (11 max) | l'app (depuis la config TJM du client) |
| **Ligne 7, colonnes B→L** | **TJM** de chaque rôle (`$B$7`…`$L$7`) | l'app |
| **Ligne 9** | En-tête de la **phase 1** | modèle (sert de gabarit) |
| **Ligne 10** | Première **ligne d'item** | modèle (sert de gabarit) |
| Colonne **N** (14) | Jours-homme (mandays) par item | utilisateur, dans le Sheet |
| Colonne **O** (15) | Budget par item | utilisateur, dans le Sheet |
| Une cellule colonne A contenant **« Validation chiffrage »** | un menu déroulant de statut est posé **juste en dessous** | l'app |
| Une ligne contenant **`TOTAL (WITHOUT VAT) - BUILD`** | total global ; **c'est de là que le tableau de bord lit le montant** | l'app (formule `=SUM(...)`) |

**Points à respecter impérativement :**

- La **ligne 9 = en-tête de phase** et la **ligne 10 = item** servent de gabarits :
  l'app les recopie pour générer toutes les phases et tous les items. Mettez-y la
  mise en forme souhaitée (couleurs, bordures).
- Les formules de phase calculent automatiquement : pour chaque rôle,
  `=SUM(items)*$<col>$7` (jours × TJM), le budget `=SUM(colonne O)` et les
  jours-homme `=SUM(colonne N)`.
- Le **libellé du total** doit contenir les mots **`TOTAL`** et **`WITHOUT VAT`**
  (l'extraction du montant cherche cette chaîne). Le suffixe `- BUILD` est reconnu
  comme total principal.
- Le **libellé « Validation chiffrage »** (colonne A) déclenche la pose du menu
  déroulant de statut (`Envoyé`, `Validé`, `Passé en TMA`, `Refusé`, `Annulé`)
  sur la cellule juste en dessous.

> 💡 Le plus simple : créez **un chiffrage manuel complet et propre**, vérifiez
> qu'il rend bien, puis videz les valeurs variables (C1–C5, items) pour en faire le
> modèle.

### 4.3 Récupérer l'ID du modèle et le partager

- L'**ID** est dans l'URL : `https://docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`.
- **Partagez** ce classeur **en lecture** avec les comptes Google de tous les
  utilisateurs (ou avec votre groupe Workspace). Sans cela, ils ne pourront pas
  créer de chiffrage.

---

## 5. Organiser Google Drive

ChiffrageMax ne maintient **aucun classeur maître** : il **scanne des dossiers
Drive** à la recherche des fichiers `CHI-*`.

1. Créez **un dossier Drive par client** (p. ex. `Clients/ACME`, `Clients/Globex`).
2. **Partagez** chaque dossier en **édition** avec les utilisateurs concernés.
3. À la création d'un chiffrage, l'app range automatiquement le fichier dans :

   ```
   <dossier du client> / <année> / <année-mois>
   ex. : Clients/ACME / 2026 / 2026-05 / CHI-2026-05-12- Portail-RH
   ```

   Les sous-dossiers `année` et `année-mois` sont **créés automatiquement** au besoin.
4. (Optionnel) Un **dossier racine de repli** sert quand un client n'a pas de
   dossier propre.

> 🗃 **Archiver** ajoute `[ARCH]` au nom du fichier : il est alors ignoré par les
> scans (zéro appel API). 🗑 **Supprimer** efface définitivement le Sheet.

---

## 6. Première configuration dans l'application (⚙️)

Chaque utilisateur (ou l'admin, voir §7 pour partager) ouvre l'app, se connecte
avec son compte Google, puis ouvre **⚙️ Configuration** et renseigne :

1. **OAuth Client ID** — le Client ID de l'étape 2.4 *(déjà pré-rempli si embarqué)*.
2. **ID du modèle** — l'ID du Sheet `ModeleChiffrage` (§4.3). Une URL complète est
   acceptée.
3. **Dossier Drive racine (fallback)** — l'ID du dossier de repli (optionnel).
4. **Clients** — pour chaque client : un **nom** + l'**ID de son dossier Drive**
   (§5). Le bouton **💰** ouvre la configuration des **rôles et TJM** du client
   (jusqu'à 11 rôles, colonnes B→L), appliqués automatiquement à chaque nouveau
   chiffrage de ce client.

La configuration est sauvegardée dans `ChiffrageMax-Config.json` sur le Drive de
l'utilisateur : elle le suit donc d'un appareil à l'autre.

---

## 7. Déployer auprès de l'équipe (3 stratégies)

| Stratégie | Pour qui | Comment |
|---|---|---|
| **A. Config partagée (recommandé)** | Équipes : une config commune (modèle, clients, TJM) | L'admin configure tout, partage `ChiffrageMax-Config.json` (Drive) **en lecture/édition** avec l'équipe, et chacun colle son **ID/URL** dans ⚙️ → champ « **Config partagée** ». Tout le monde voit les mêmes clients/TJM. |
| **B. Valeurs embarquées** | Déploiement interne figé | Embarquez `clientId` + `templateId` dans `js/config.js` (§3). Les utilisateurs n'ont que leurs clients à ajouter. |
| **C. Config individuelle** | Petites équipes / indépendants | Chacun saisit sa config dans ⚙️. |

> La **stratégie A** est idéale en entreprise : un seul endroit pour gérer la liste
> des clients et les grilles de TJM, partagé à tous. Le Client ID, lui, reste
> toujours **local au navigateur**.

---

## 8. Workflow quotidien (pour les chargés d'affaires)

1. **Se connecter** avec son compte Google.
2. **Nouveau chiffrage** : choisir le client, saisir projet / n° devis / date /
   ticket, définir les phases et le nombre d'items. L'app crée le Sheet à partir du
   modèle, applique les TJM du client, et l'ajoute au tableau de bord.
3. **Remplir** les jours-homme par item dans le Sheet (les totaux et budgets se
   calculent automatiquement).
4. **Suivre** sur le tableau de bord : éditer en ligne (n° devis, client, projet,
   date, ticket), changer le **statut** (`Envoyé`, `Validé`…), voir le **montant**.
5. **Statistiques** : répartition par statut, tunnel de conversion
   Créés → Envoyés → Validés.
6. **Timeline** : planning de Gantt par phases (Conception, Développement, Recette,
   MEP), filtrable par client — pratique pour partager un planning à un client.

---

## 9. Quotas et performances

L'API Sheets est limitée à ~60 lectures/min/utilisateur. ChiffrageMax minimise les
appels :

- **1 seul appel par fichier** (lecture groupée onglets + valeurs).
- **Cache local par `modifiedTime`** : un fichier inchangé n'engendre aucun appel.
- **Limiteur de débit** (~50 lectures/min) + **réessais** avec backoff sur les `429`.
- Fichiers **`[ARCH]`** ignorés avant tout appel.

En pratique, un portefeuille de plusieurs centaines de chiffrages se recharge sans
heurter les quotas, et l'affichage est instantané au rechargement
(*stale-while-revalidate*).

---

## 10. Sécurité, données et RGPD

- **Aucune donnée ne quitte l'écosystème Google de l'entreprise** : ChiffrageMax
  n'a pas de serveur. Les appels vont du navigateur directement aux API Google.
- **OAuth Client ID** : public par nature (il circule en clair dans chaque requête
  OAuth) — ce **n'est pas un secret**. L'accès reste protégé par la connexion
  Google de chacun et par les **partages Drive** que vous accordez.
- **Jeton d'accès** : court (~1 h), stocké en `localStorage`, renouvelé
  silencieusement. La déconnexion le révoque.
- **Maîtrise des accès** : pour retirer l'accès à quelqu'un, retirez-le des partages
  Drive (dossiers clients + modèle + config partagée), comme pour n'importe quel
  fichier Google.
- En mode consentement **Interne**, seuls les comptes de votre Workspace peuvent
  même se connecter.

---

## 11. Dépannage (erreurs fréquentes)

| Symptôme | Cause probable | Solution |
|---|---|---|
| `origin not allowed` / popup OAuth qui se ferme | Origine non déclarée | Ajoutez l'URL **exacte** (protocole + domaine + port, sans `/`) dans les Origines JavaScript autorisées (§2.4). |
| Écran « application non vérifiée » | Consentement **Externe** non vérifié | Passez en **Interne** (Workspace), ou lancez la vérification Google. |
| « Modèle introuvable » à la création | `templateId` faux ou modèle non partagé | Vérifiez l'ID dans ⚙️ et **partagez le modèle en lecture** avec le compte (§4.3). |
| « Impossible de déplacer le fichier vers le dossier » (404/403) | Dossier client non partagé en édition | Partagez le dossier Drive du client avec le compte (§5). |
| Le montant ne s'affiche pas | Libellé du total non reconnu | La ligne de total doit contenir **`TOTAL`** et **`WITHOUT VAT`** (§4.2). |
| Le menu de statut tombe au mauvais endroit | Libellé absent/mal placé | Gardez **« Validation chiffrage »** en colonne A dans le modèle (§4.2). |
| Erreurs `429` répétées | Trop d'appels (gros portefeuille rechargé d'un coup) | Normalement géré automatiquement ; patientez, le backoff réessaie. Archivez (`[ARCH]`) les vieux chiffrages. |
| Connexion impossible après changement de Client ID | Cache de jeton | Déconnectez-vous, rechargez, reconnectez-vous. |

---

## 12. Checklist de mise en production

- [ ] Projet Google Cloud créé, **Sheets API** + **Drive API** activées
- [ ] Écran de consentement OAuth configuré (**Interne** de préférence) avec les 2 scopes
- [ ] **OAuth Client ID** (Application Web) créé, origines autorisées renseignées
- [ ] App déployée (GitHub Pages ou interne), origine ajoutée aux identifiants
- [ ] Sheet **`ModeleChiffrage`** créé au bon format et **partagé en lecture**
- [ ] **Dossiers clients** Drive créés et **partagés en édition**
- [ ] Configuration ⚙️ remplie (Client ID, modèle, racine, clients + TJM)
- [ ] Stratégie de partage choisie (config partagée / embarquée / individuelle)
- [ ] Test de bout en bout : connexion → nouveau chiffrage → statut → montant → stats

---

Bon chiffrage ! Pour les questions de structure de fichiers et de modules,
voir la section **Structure du projet** du [README](../README.md).
