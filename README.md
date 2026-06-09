# ChiffrageMax

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Build: none](https://img.shields.io/badge/build-none-success)
![Stack: Vanilla JS](https://img.shields.io/badge/stack-Vanilla%20JS-f7df1e)

A **100% frontend** single-page web app to manage project quotes, hostable on **GitHub Pages**. No build step, no backend, no external dependencies.

The app reads and writes directly to **Google Sheets** and **Google Drive** via their REST APIs, authenticated via **OAuth** using Google Identity Services (GIS).

> **Least-privilege by design**: the app requests only the narrow
> `https://www.googleapis.com/auth/drive.file` scope. It can touch **only the
> files it creates and the folders/files you explicitly select** via the Google
> Picker — never the rest of your Drive. Your other documents (bills, personal
> files, unrelated sheets) are unreachable by the app, even if the page were
> compromised.

## Screenshots

> _Add your screenshots to `docs/` (see [`docs/README.md`](docs/README.md)), then **uncomment** the table below. These will anchor your LinkedIn post._

<!-- Uncomment once screenshots are added to docs/:
| Dashboard | Statistics | Timeline (Gantt) |
|---|---|---|
| ![Dashboard](docs/dashboard.png) | ![Statistics](docs/stats.png) | ![Timeline](docs/timeline.png) |
-->

🔗 **Live demo**: `https://<your-username>.github.io/ChiffrageMax/` _(see [GitHub Pages Deployment](#github-pages-deployment))_

> **Security**: no secrets are stored in the repository. By default, the **OAuth Client ID** and **template Sheet ID** are **not baked in** (empty `BAKED` in `js/config.js`): each user enters them via ⚙️ Settings, or the deployer embeds them in their own private copy. A web OAuth Client ID is *not* a secret (it travels in plaintext in every OAuth request), but baking it in routes all visitors' OAuth traffic and API quota through **your** Google Cloud project — only do this for a controlled internal deployment. Values entered via ⚙️ Settings stay **browser-local** (localStorage); everything else (template, folders, clients, day rates) syncs to your personal Drive.

## Features

### Dashboard
- **Auto-scan** of each client's Drive folders for `CHI-*` files (no master spreadsheet).
- **Progressive loading** client by client with a progress bar, rate limiter, and local cache (see *Performance*).
- **Instant display** on reload: last scan data is shown immediately, then refreshed in the background (*stale-while-revalidate*).
- **Client selector**, **status filters**, and **column sorting** (click any header).
- **Inline cell editing**: quote number, client (dropdown), project, date (picker), ticket. The Drive file is **automatically renamed** when the project or date changes; it is **moved** to the correct `year/month` folder when the client changes.
- **Status** (`Sent`, `Approved`, `In Maintenance`, `Rejected`, `Cancelled`) editable via a dropdown written directly to the sheet.
- **Amount** automatically extracted (row `TOTAL ... WITHOUT VAT`), click to refresh.
- **Archive** (🗃): prepends `[ARCH]` to the filename, which is then skipped on future scans (zero API calls).
- **Delete** (🗑): permanently deletes the Google Sheet.

### New Quote
- Creates a spreadsheet from a **template** (`ModeleChiffrage`), places it in `client folder / year / month`, generates phases and items, applies the client's **roles/day rates**, then adds it to the dashboard without a full reload.

### Statistics
A dedicated tab, accessible from the navigation menu, with SVG charts (no external dependency):
- **Status breakdown**: donut chart + detailed legend (count, percentage, amount).
- **Conversion funnel**: Created → Sent → Approved, with conversion rates between each step.
- Filterable by client (or all clients).

### Timeline
A dedicated tab displaying a **Gantt chart** of projects added to the timeline (no external dependency):
- **🗓 button on each dashboard row**: opens a panel to set date ranges for 4 phases (**Design**, **Development**, **Testing**, **Go-Live**). End date is optional (e.g. Go-Live shows only a start milestone).
- **Quarter view**: fixed-width columns (one quarter), colour-coded phase bars, **today line**.
- **Navigation**: horizontal scrolling, previous/next quarter buttons, and a **Today** button to recenter on the current date.
- **Filterable by client** (great for sharing a validated project schedule with a client).
- Phase dates are saved in Drive config (synced across devices).

## 🏢 Company Deployment

Setting up ChiffrageMax for a whole team? Follow the **[Setup
Guide — A to Z](docs/SETUP.md)**: Google Cloud project, OAuth,
hosting, template Sheet structure, Drive organisation, team config sharing,
daily workflow, security/GDPR, and troubleshooting.

## Google Cloud Setup (one-time)

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com/).
2. Enable **Google Sheets API**, **Google Drive API**, and **Google Picker API**.
3. Configure the OAuth consent screen with the single scope `https://www.googleapis.com/auth/drive.file` (non-sensitive — no Google verification needed).
4. Create an **OAuth 2.0 Client ID** of type *Web application*.
5. Under **Authorized JavaScript origins**, add your site URL, e.g.:
   - `https://<your-username>.github.io`
   - `http://localhost:8000` (for local testing)
6. Copy the **Client ID** (`...apps.googleusercontent.com`).
7. Create a **browser API key** (Credentials → Create credentials → API key), restrict it to your origin + the **Google Picker API**, and note your **project number**. These power the folder/file picker (entered in ⚙️ → advanced settings). Neither is a secret.

## App Configuration

On first launch, fill in the settings via ⚙️ (nothing is baked in by default). For an internal deployment, you can **bake in** your values in `js/config.js` (`BAKED.clientId` / `BAKED.templateId`) so teammates have **nothing to configure**. Fields available in ⚙️:

- **OAuth Client ID**: the Client ID from your Google Cloud project (`...apps.googleusercontent.com`).
- **Browser API key + project number** (advanced): power the Google Picker — see [Google Cloud Setup](#google-cloud-setup-one-time).
- **Template**: select the template Google Sheet (`ModeleChiffrage`/`Chiffrage`) with the **📄 Choisir** button. Under `drive.file` you must *pick* it so the app is granted access (sharing alone is not enough).
- **Root Drive folder (fallback)**: pick it with the **📂** button; used when a client has no dedicated folder.
- **Clients**: for each client, a name and a Drive folder selected with the **📂** button. The 💰 button lets you configure roles and day rates per client.

> Because the app uses the narrow `drive.file` scope, folders and the template are
> granted by **picking them in the Google Picker** rather than by pasting raw IDs.
> Picking a folder grants the app access to that folder and its contents; nothing
> else in your Drive is reachable.

> To bake in your own template, paste its ID into the `BAKED.templateId` constant in `js/config.js`. To change the baked Client ID, edit `BAKED.clientId` in the same file.

The configuration (template, folders, clients, roles/day rates) is saved to a `ChiffrageMax-Config.json` file in your Drive, so it follows you across devices. The Client ID stays browser-local.

## Performance & Quotas

The Sheets API is limited to ~60 reads/min/user. Several mechanisms prevent `429` errors:

- **1 API call per file**: a single `spreadsheets.get?includeGridData` call reads both sheet titles and values.
- **Local cache by `modifiedTime`**: an unchanged file generates zero API calls.
- **Client-side rate limiter** (~50 reads/min, with bursting) + **exponential backoff retries** on `429`.
- **`[ARCH]` files** are skipped before any API call.

## Local Testing

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

(`http://localhost:8000` must be listed in your OAuth *Authorized JavaScript origins*.)

## GitHub Pages Deployment

1. Push the repository to GitHub.
2. **Settings → Pages** → *Source*: main branch, folder `/ (root)`.
3. Add the Pages URL to your OAuth *Authorized JavaScript origins*.

No build step: files are served as-is.

## Project Structure

| File | Role |
|---|---|
| `index.html` | Page structure (login, navigation, dashboard, statistics, modals). |
| `css/styles.css` | Dark theme and styles. |
| `js/auth.js` | OAuth GIS; token persisted in localStorage (survives browser restart). |
| `js/api.js` | Sheets/Drive REST calls, rate limiter, `429` retries. |
| `js/config.js` | Local config (clientId) and Drive serialisation. |
| `js/drive-config.js` | Config persistence in `ChiffrageMax-Config.json`. |
| `js/chiffrage.js` | Quote creation, Drive scan, file reading/caching. |
| `js/app.js` | UI: dashboard, inline editing, filters, navigation, statistics. |
| `js/utils.js` | Utility functions (dates, IDs, formatting). |
