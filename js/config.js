const STORAGE_KEY = 'chiffragemax.config';
const CLIENTS_KEY = 'chiffragemax.clients';

// --- Baked-in defaults (shipped in the app) ---------------------------------
// These let colleagues use the app without configuring anything. They are NOT
// secrets: a web OAuth Client ID is public by design (it travels in plaintext
// in every OAuth request), and a Sheet ID is just a file identifier. Access is
// still gated by Google sign-in and by who the template Sheet is shared with.
// Users can override either value in ⚙️ Configuration; their entry wins.
const BAKED = {
  clientId: '557845598051-fkvj620tspj1oalgd9j7sa8avadqli00.apps.googleusercontent.com',
  // Paste your ModeleChiffrage Sheet ID (or full URL) here to ship it as the
  // default template, e.g. '1AbC...xyz'. Leave empty to require manual entry.
  templateId: '',
};

const DEFAULTS = {
  clientId: BAKED.clientId,
  templateId: BAKED.templateId,
  rootFolderId: '',
};

export const Config = {
  load() {
    let stored = {};
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch { /* malformed — fall back to defaults */ }
    const cfg = { ...DEFAULTS, ...stored };
    // A blank stored value must not erase a baked-in default.
    if (!cfg.clientId)   cfg.clientId   = DEFAULTS.clientId;
    if (!cfg.templateId) cfg.templateId = DEFAULTS.templateId;
    return cfg;
  },

  save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.load(), ...cfg }));
  },

  get(key) {
    return this.load()[key];
  },

  isComplete() {
    const c = this.load();
    return Boolean(c.clientId && c.templateId && c.rootFolderId);
  },

  // --- Client folder map: [{ name, folderId }] ---

  getClients() {
    try {
      return JSON.parse(localStorage.getItem(CLIENTS_KEY) || '[]');
    } catch {
      return [];
    }
  },

  saveClients(clients) {
    localStorage.setItem(CLIENTS_KEY, JSON.stringify(clients));
  },

  getClientFolder(clientName) {
    if (!clientName) return null;
    const key = clientName.trim().toLowerCase();
    const entry = this.getClients().find((c) => c.name.trim().toLowerCase() === key);
    return entry?.folderId || null;
  },

  // roles: [{name, rate, enabled}] aligned to columns B-L (11 items).
  getClientRoles(clientName) {
    if (!clientName) return null;
    const key = clientName.trim().toLowerCase();
    const entry = this.getClients().find((c) => c.name.trim().toLowerCase() === key);
    return entry?.roles || null;
  },

  setClientRoles(clientName, roles) {
    const clients = this.getClients();
    const idx = clients.findIndex((c) => c.name.trim().toLowerCase() === clientName.trim().toLowerCase());
    if (idx >= 0) {
      clients[idx] = { ...clients[idx], roles };
      this.saveClients(clients);
    }
  },

  upsertClient(name, folderId) {
    const clients = this.getClients();
    const idx = clients.findIndex((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (idx >= 0) {
      clients[idx] = { ...clients[idx], name: name.trim(), folderId: folderId.trim() };
    } else {
      clients.push({ name: name.trim(), folderId: folderId.trim() });
    }
    this.saveClients(clients);
  },

  // Update name/folderId while preserving TJM data.
  updateClient(oldName, newName, folderId) {
    const clients = this.getClients();
    const idx = clients.findIndex((c) => c.name.trim().toLowerCase() === oldName.trim().toLowerCase());
    if (idx >= 0) {
      clients[idx] = { ...clients[idx], name: newName.trim(), folderId: folderId.trim() };
      this.saveClients(clients);
    }
  },

  deleteClient(name) {
    const clients = this.getClients().filter(
      (c) => c.name.trim().toLowerCase() !== name.trim().toLowerCase(),
    );
    this.saveClients(clients);
  },

  // Serialise everything except clientId for Drive persistence.
  toDriveData() {
    const c = this.load();
    return {
      templateId:   c.templateId   || '',
      rootFolderId: c.rootFolderId || '',
      clients:      this.getClients(),
    };
  },

  // Restore from Drive data — never touches clientId (stays browser-local).
  fromDriveData(data) {
    if (!data) return;
    this.save({
      templateId:   data.templateId   ?? '',
      rootFolderId: data.rootFolderId ?? '',
    });
    if (Array.isArray(data.clients)) this.saveClients(data.clients);
  },
};
