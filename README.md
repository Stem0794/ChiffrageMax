# ChiffrageMax

Application web (SPA) 100 % frontend pour gérer des chiffrages de projets, hébergeable sur **GitHub Pages**. Migration de l'add-on Google AppScript d'origine vers des appels **REST** aux API Google Sheets et Drive, avec authentification **OAuth** via Google Identity Services.

Aucun backend, aucun secret stocké dans le dépôt : l'utilisateur renseigne sa configuration dans le navigateur (localStorage).

## Fonctionnalités

- **Tableau de bord** des chiffrages (lecture de l'onglet `Chiffrage`).
- **Nouveau chiffrage** : crée un classeur Google Sheets à partir de `ModeleChiffrage`, le range dans le dossier Drive (sous `année / mois`), génère les phases/items selon `ConfigPhases`, puis met à jour la ligne du tableau de bord.
- **Récupération automatique des montants** depuis chaque fichier de chiffrage (lignes `TOTAL ... WITHOUT VAT`).
- **Changement de statut** : `Envoyé` / `Devis validé` met à jour le montant ; `Devis validé` ajoute le projet au planning (`Upcoming projects`).
- **Graphique Budget vs Consommé** par devis (Chart.js).
- **Planning** : ajout d'un projet (4 phases colorées) et coloration alternée des groupes.

## Configuration Google Cloud (une fois)

1. Créez un projet sur [console.cloud.google.com](https://console.cloud.google.com/).
2. Activez **Google Sheets API** et **Google Drive API**.
3. Configurez l'écran de consentement OAuth.
4. Créez un identifiant **OAuth 2.0 Client ID** de type *Web application*.
5. Dans **Authorized JavaScript origins**, ajoutez l'URL de votre site, par ex. :
   - `https://<votre-utilisateur>.github.io`
   - `http://localhost:8000` (pour les tests locaux)
6. Copiez le **Client ID** (`...apps.googleusercontent.com`).

## Configuration de l'application

Ouvrez l'application, cliquez sur ⚙️ et renseignez :

- **OAuth Client ID** : l'identifiant créé ci-dessus.
- **ID du classeur (Dashboard)** : l'ID (ou l'URL) du Google Sheet contenant les onglets `Chiffrage`, `ConfigPhases`, `ModeleChiffrage`, `Fonctionnalitées`, `Upcoming projects`.
- **ID du dossier Drive racine** : le dossier où créer les chiffrages.

Ces valeurs sont enregistrées uniquement dans le navigateur.

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

## Onglets attendus dans le classeur

| Onglet | Rôle |
|---|---|
| `Chiffrage` | Tableau de bord (A: ID, B: N° devis, C: Client, D: Projet, E: Ticket, F: Date, G: Statut, H: Lien, I: Montant) |
| `ConfigPhases` | A: numéro de phase, B: nombre d'items |
| `ModeleChiffrage` | Modèle copié pour chaque nouveau chiffrage |
| `Fonctionnalitées` | Suivi du consommé (colonnes N° devis + Budget) |
| `Upcoming projects` | Planning des projets |
