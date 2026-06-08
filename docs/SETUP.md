# ChiffrageMax — Setup Guide (A to Z for a company)

This guide walks you through deploying ChiffrageMax for an entire team —
from creating the Google Cloud project to daily use by your account managers.
Allow **30 to 60 minutes** for the initial setup.

> **No coding required.** The app is 100% frontend (HTML/CSS/JS, no build step).
> Host it as-is, and every user works with **their own Google account**: data
> stays inside **your company's Google Drive** — ChiffrageMax has no server or
> intermediate database.

---

## 0. Understand the architecture (read before you start)

```
┌────────────────────┐      OAuth (browser)         ┌──────────────────────┐
│  User's browser     │  ────────────────────────▶  │  Google Sheets API   │
│  (ChiffrageMax,     │                              │  Google Drive API    │
│   GitHub Pages)     │  ◀────────────────────────  │                      │
└────────────────────┘      JSON responses           └──────────────────────┘
                                                               │
                                                               ▼
                                          Your files: company Drive / Sheets
```

- **No ChiffrageMax backend**: the app calls Google APIs directly from the browser. Your quotes, config, and client data never pass through a third-party server.
- **Authentication**: Google Identity Services (OAuth). Each user signs in with their company Google account (Workspace).
- **Storage**:
  - **Quotes** are Google Sheets named `CHI-*` stored in Drive folders.
  - **Configuration** (template, clients, day rates, timeline) is a `ChiffrageMax-Config.json` file in each user's Drive (or shared — see §7).

### What needs to be prepared

| Item | Who | One-time? |
|---|---|---|
| **Google Cloud project** + OAuth Client ID | Admin | ✅ Yes |
| **App hosting** (GitHub Pages) | Admin | ✅ Yes |
| **Template Google Sheet** (`ModeleChiffrage`) | Admin | ✅ Yes |
| **Drive folders** per client | Admin / account manager | At each new client |
| **In-app configuration** (⚙️) | Each user (or shared) | At first login |

---

## 1. Get the code

Two options:

**A. Fork (recommended)** — you keep your own copy and can bake in your Client ID and add screenshots.

```bash
# Fork the repo on GitHub, then:
git clone https://github.com/<your-org>/ChiffrageMax.git
cd ChiffrageMax
```

**B. Internal hosting** — copy the files (`index.html`, `css/`, `js/`, `manifest.json`, `favicon.svg`) to any static web server (Nginx, Apache, S3, IIS…). No build step.

---

## 2. Configure Google Cloud (the heart of the setup)

> 🔑 This is the most critical step. Use an **administrator** account of your company's Google Workspace.

### 2.1 Create the project

1. Go to [console.cloud.google.com](https://console.cloud.google.com/).
2. At the top, **Select a project → New project**. Name it e.g. `ChiffrageMax-Prod`. Create.

### 2.2 Enable the APIs

Menu **APIs & Services → Library**, enable **both**:

- **Google Sheets API**
- **Google Drive API**

### 2.3 OAuth consent screen

Menu **APIs & Services → OAuth consent screen**.

- **User type**:
  - **Internal** (recommended if you have Google Workspace) → only accounts in your organisation can use it, **no Google verification required**, no 100-user cap, no warning screen.
  - **External** → required if users have Gmail accounts outside Workspace. Until the app is **verified** by Google, it is capped at 100 test users and shows an "unverified app" warning. For a company deployment, prefer **Internal**.
- Fill in the **app name** (`ChiffrageMax`), **support email**, and a developer email.
- **Scopes** — add the two scopes the app uses:
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/drive`

  > These are "sensitive/restricted" scopes. In **Internal** mode no verification is needed. In **External** mode they trigger a Google verification process (proof of use and possible audit).

### 2.4 Create the OAuth credential (Client ID)

Menu **APIs & Services → Credentials → Create credentials → OAuth client ID**.

1. **Application type**: *Web application*.
2. **Name**: `ChiffrageMax Web`.
3. **Authorized JavaScript origins** — add **exactly** the URLs from which the app will be served (no path, no trailing `/`):
   - `https://<your-org>.github.io` (GitHub Pages deployment)
   - `http://localhost:8000` (local testing)
   - your internal domain if applicable: `https://quotes.company.com`
4. **Create**, then copy the **Client ID** (`...apps.googleusercontent.com`).

> ⚠️ If the origin does not match exactly, sign-in fails with `redirect_uri_mismatch` / `origin not allowed`. This is the #1 cause of setup failures. The port matters (`:8000`), and so does `https` vs `http`.

---

## 3. Host the app (GitHub Pages)

1. Push your fork to GitHub.
2. **Settings → Pages** → *Source*: main branch, folder **`/ (root)`**.
3. Wait for the published URL, e.g. `https://<your-org>.github.io/ChiffrageMax/`.
4. Make sure this origin is listed in the **Authorized JavaScript origins** (step 2.4). Add it if not.

> Internal hosting? Serve the folder over HTTPS and add its origin to the OAuth credentials. No build, no server-side variables.

### (Optional) Bake in the Client ID so teammates configure nothing

By default nothing is baked in (`js/config.js`). For a **controlled internal deployment**, you can pre-fill the Client ID and template ID:

```js
// js/config.js
const BAKED = {
  clientId:   '....apps.googleusercontent.com', // your Client ID
  templateId: '1AbC...XyZ',                      // template Sheet ID (see §4)
};
```

> ✅ Benefit: teammates sign in and they're done.
> ⚠️ Only do this for **your own** private deployment. Never commit these values to a **public** repository — you would route strangers' OAuth traffic through your Google Cloud project.

---

## 4. Create the template Google Sheet (`ModeleChiffrage`)

ChiffrageMax generates each quote by **copying a template tab** and then inserting phases, items, and formulas. The template must follow this exact structure.

### 4.1 Create the spreadsheet

1. Create a Google Sheet in the company Drive, named e.g. `ModeleChiffrage`.
2. Name the **tab** `ModeleChiffrage` (or `Chiffrage`). The app looks for a tab named `ModeleChiffrage` first, then `Chiffrage`, otherwise it uses the first tab.

### 4.2 Expected cell layout

| Location | Content | Filled by |
|---|---|---|
| **C1** | Client name | the app (on creation) |
| **C2** | Project | the app |
| **C3** | Ticket | the app |
| **C4** | Date (`YYYY-MM-DD`) | the app |
| **C5** | Quote number | the app |
| **Row 6, columns B→L** | **Role names** (11 max) | the app (from client day-rate config) |
| **Row 7, columns B→L** | **Day rates** per role (`$B$7`…`$L$7`) | the app |
| **Row 9** | **Phase 1** header row | template (used as a blueprint) |
| **Row 10** | First **item row** | template (used as a blueprint) |
| Column **N** (14) | Mandays per item | user, in the Sheet |
| Column **O** (15) | Budget per item | user, in the Sheet |
| A cell in column A containing **"Validation chiffrage"** | a status dropdown is placed **immediately below** it | the app |
| A row containing **`TOTAL (WITHOUT VAT) - BUILD`** | global total; **this is where the dashboard reads the amount** | the app (`=SUM(...)` formula) |

**Rules to follow strictly:**

- **Row 9 = phase header** and **row 10 = item** act as blueprints: the app copies them to generate all phases and items. Apply your desired formatting (colours, borders) there.
- Phase formulas are auto-generated: for each role, `=SUM(items)*$<col>$7` (days × day rate), budget `=SUM(column O)`, and mandays `=SUM(column N)`.
- The **total label** must contain the words **`TOTAL`** and **`WITHOUT VAT`** (the amount extractor searches for this string). The `- BUILD` suffix is recognised as the main total.
- The **"Validation chiffrage" label** (column A) triggers the status dropdown (`Sent`, `Approved`, `In Maintenance`, `Rejected`, `Cancelled`) on the cell immediately below it.

> 💡 Easiest approach: build **one complete, clean quote manually**, verify it looks right, then clear the variable values (C1–C5, items) to turn it into the template.

### 4.3 Get the template ID and share it

- The **ID** is in the URL: `https://docs.google.com/spreadsheets/d/`**`<ID>`**`/edit`.
- **Share** the spreadsheet **read-only** with all users' Google accounts (or your Workspace group). Without this, they cannot create quotes.

---

## 5. Organise Google Drive

ChiffrageMax maintains **no master spreadsheet**: it **scans Drive folders** for `CHI-*` files.

1. Create **one Drive folder per client** (e.g. `Clients/ACME`, `Clients/Globex`).
2. **Share** each folder with **edit access** for the relevant users.
3. When a quote is created, the app automatically places the file in:

   ```
   <client folder> / <year> / <year-month>
   e.g.: Clients/ACME / 2026 / 2026-05 / CHI-2026-05-12- HR-Portal
   ```

   The `year` and `year-month` subfolders are **created automatically** as needed.
4. (Optional) A **root fallback folder** is used when a client has no dedicated folder.

> 🗃 **Archive** prepends `[ARCH]` to the filename: it is then skipped on future scans (zero API calls). 🗑 **Delete** permanently removes the Sheet.

---

## 6. First in-app configuration (⚙️)

Each user (or the admin — see §7 for sharing) opens the app, signs in with their Google account, opens **⚙️ Settings**, and fills in:

1. **OAuth Client ID** — the Client ID from step 2.4 *(pre-filled if baked in)*.
2. **Template ID** — the `ModeleChiffrage` Sheet ID (§4.3). A full URL is accepted.
3. **Root Drive folder (fallback)** — the fallback folder ID (optional).
4. **Clients** — for each client: a **name** + their **Drive folder ID** (§5). The **💰** button opens the **roles and day rates** config for that client (up to 11 roles, columns B→L), applied automatically to every new quote for that client.

The config is saved to `ChiffrageMax-Config.json` in the user's Drive, so it follows them across devices.

---

## 7. Rolling out to the team (3 strategies)

| Strategy | Best for | How |
|---|---|---|
| **A. Shared config (recommended)** | Teams: one shared config (template, clients, day rates) | Admin configures everything, shares `ChiffrageMax-Config.json` (Drive) with **edit access**, and each user pastes its **ID/URL** in ⚙️ → **Shared config** field. Everyone sees the same clients/day rates. |
| **B. Baked-in values** | Fixed internal deployment | Bake `clientId` + `templateId` into `js/config.js` (§3). Users only need to add their clients. |
| **C. Individual config** | Small teams / freelancers | Each person fills in their own ⚙️ settings. |

> **Strategy A** is ideal for companies: one place to manage the client list and day-rate grids, shared with everyone. The Client ID always stays **browser-local**.

---

## 8. Daily workflow (for account managers)

1. **Sign in** with your Google account.
2. **New quote**: select the client, enter project / quote number / date / ticket, define phases and item counts. The app creates the Sheet from the template, applies the client's day rates, and adds it to the dashboard.
3. **Fill in** mandays per item in the Sheet (totals and budgets calculate automatically).
4. **Track** on the dashboard: inline edit (quote number, client, project, date, ticket), change the **status** (`Sent`, `Approved`…), view the **amount**.
5. **Statistics**: status breakdown, conversion funnel Created → Sent → Approved.
6. **Timeline**: Gantt chart by phase (Design, Development, Testing, Go-Live), filterable by client — great for sharing a schedule with a client.

---

## 9. Quotas & performance

The Sheets API is limited to ~60 reads/min/user. ChiffrageMax minimises calls:

- **1 API call per file** (one grouped read for tab titles + values).
- **Local cache by `modifiedTime`**: an unchanged file generates zero API calls.
- **Rate limiter** (~50 reads/min) + **exponential backoff retries** on `429`.
- **`[ARCH]` files** are skipped before any API call.

In practice, a portfolio of several hundred quotes reloads without hitting quotas, and the display is instant on reload (*stale-while-revalidate*).

---

## 10. Security, data & GDPR

- **No data leaves the company's Google ecosystem**: ChiffrageMax has no server. Calls go from the browser directly to Google APIs.
- **OAuth Client ID**: public by nature (travels in plaintext in every OAuth request) — it is **not a secret**. Access is protected by each user's Google sign-in and by the **Drive sharing** permissions you grant.
- **Access token**: short-lived (~1 h), stored in `localStorage`, silently refreshed. Sign-out revokes it.
- **Access control**: to revoke someone's access, remove them from the Drive shares (client folders + template + shared config) — just like any Google file.
- In **Internal** consent mode, only accounts in your Workspace can sign in at all.

---

## 11. Troubleshooting (common errors)

| Symptom | Likely cause | Fix |
|---|---|---|
| `origin not allowed` / OAuth popup closes immediately | Origin not declared | Add the **exact** URL (protocol + domain + port, no trailing `/`) to Authorized JavaScript origins (§2.4). |
| "Unverified app" warning screen | **External** consent, not verified | Switch to **Internal** (Workspace), or start Google's verification process. |
| "Template not found" on quote creation | Wrong `templateId` or template not shared | Check the ID in ⚙️ and **share the template read-only** with the account (§4.3). |
| "Cannot move file to folder" (404/403) | Client Drive folder not shared with edit access | Share the client's Drive folder with the account (§5). |
| Amount not displayed | Total label not recognised | The total row must contain **`TOTAL`** and **`WITHOUT VAT`** (§4.2). |
| Status dropdown lands on the wrong cell | Label missing or misplaced | Keep **"Validation chiffrage"** in column A of the template (§4.2). |
| Repeated `429` errors | Too many calls (large portfolio reloaded at once) | Normally handled automatically; wait, the backoff will retry. Archive (`[ARCH]`) old quotes. |
| Cannot sign in after changing Client ID | Stale token in cache | Sign out, reload, sign in again. |

---

## 12. Go-live checklist

- [ ] Google Cloud project created, **Sheets API** + **Drive API** enabled
- [ ] OAuth consent screen configured (**Internal** preferred) with both scopes
- [ ] **OAuth Client ID** (Web application) created, authorized origins set
- [ ] App deployed (GitHub Pages or internal), origin added to credentials
- [ ] **`ModeleChiffrage`** Sheet created with the correct layout and **shared read-only**
- [ ] **Client Drive folders** created and **shared with edit access**
- [ ] ⚙️ Configuration filled in (Client ID, template, root folder, clients + day rates)
- [ ] Sharing strategy chosen (shared config / baked-in / individual)
- [ ] End-to-end test: sign in → new quote → status → amount → statistics

---

Happy quoting! For questions about file structure and modules,
see the **Project Structure** section in the [README](../README.md).
