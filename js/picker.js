// Google Picker integration.
//
// With the narrow `drive.file` OAuth scope the app has NO blanket access to the
// user's Drive — it can only touch files it creates and items the user grants
// explicitly. The Google Picker is that consent surface: when the user selects a
// folder, the app gains access to that folder and its contents (and to the
// files it later creates inside). This replaces pasting raw folder/file IDs,
// which no longer works under `drive.file` (the app can't reach a folder it was
// never granted).
//
// The Picker needs three things in addition to the OAuth token:
//   - developerKey : a browser API key from the same Google Cloud project
//   - appId        : the Cloud project NUMBER (so picked files are associated
//                    with this app for `drive.file`)
// Both are public values (not secrets), entered in ⚙️ Configuration.

let pickerReady = null;

function loadPickerApi() {
  if (pickerReady) return pickerReady;
  pickerReady = new Promise((resolve, reject) => {
    if (!window.gapi) {
      reject(new Error("La librairie Google API (api.js) n'est pas chargée."));
      return;
    }
    window.gapi.load('picker', {
      callback: () => resolve(),
      onerror: () => reject(new Error('Chargement du Google Picker impossible.')),
    });
  });
  return pickerReady;
}

// Open a Picker and resolve with the array of selected docs ({id, name, mimeType}).
// Resolves with [] if the user cancels.
async function openPicker({ token, developerKey, appId, buildView }) {
  if (!token) throw new Error('Connectez-vous avant de choisir un dossier ou un fichier.');
  if (!developerKey) {
    throw new Error("Clé API manquante : renseignez la « Clé API navigateur » dans ⚙️ Configuration (Paramètres avancés).");
  }
  await loadPickerApi();
  const g = window.google;

  return new Promise((resolve) => {
    const builder = new g.picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(developerKey)
      .addView(buildView(g))
      .setCallback((data) => {
        const action = data[g.picker.Response.ACTION];
        if (action === g.picker.Action.PICKED) {
          const docs = (data[g.picker.Response.DOCUMENTS] || []).map((d) => ({
            id: d[g.picker.Document.ID],
            name: d[g.picker.Document.NAME],
            mimeType: d[g.picker.Document.MIME_TYPE],
          }));
          resolve(docs);
        } else if (action === g.picker.Action.CANCEL) {
          resolve([]);
        }
      });
    // appId associates picked files with this Cloud project for drive.file.
    if (appId) builder.setAppId(String(appId));
    builder.build().setVisible(true);
  });
}

export const Picker = {
  // Let the user navigate Drive and select a single folder.
  async pickFolder({ token, developerKey, appId }) {
    const docs = await openPicker({
      token, developerKey, appId,
      buildView: (g) => new g.picker.DocsView(g.picker.ViewId.FOLDERS)
        .setIncludeFolders(true)
        .setSelectFolderEnabled(true)
        .setMimeTypes('application/vnd.google-apps.folder'),
    });
    return docs[0] || null;
  },

  // Let the user select a single Google Sheet (used for the template).
  async pickSpreadsheet({ token, developerKey, appId }) {
    const docs = await openPicker({
      token, developerKey, appId,
      buildView: (g) => new g.picker.DocsView(g.picker.ViewId.SPREADSHEETS),
    });
    return docs[0] || null;
  },

  // Let the user select any single file (used for the shared team config JSON,
  // which a colleague shared with them — picking it grants drive.file access).
  async pickFile({ token, developerKey, appId }) {
    const docs = await openPicker({
      token, developerKey, appId,
      buildView: (g) => new g.picker.DocsView(g.picker.ViewId.DOCS)
        .setIncludeFolders(true),
    });
    return docs[0] || null;
  },
};
