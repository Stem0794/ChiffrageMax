const STORAGE_KEY = 'chiffragemax.config';
const CLIENTS_KEY = 'chiffragemax.clients';

const DEFAULTS = {
  clientId: '',
  spreadsheetId: '',
  rootFolderId: '',
};

export const Config = {
  load() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch {
      return { ...DEFAULTS };
    }
  },

  save(cfg) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...this.load(), ...cfg }));
  },

  get(key) {
    return this.load()[key];
  },

  isComplete() {
    const c = this.load();
    return Boolean(c.clientId && c.spreadsheetId && c.rootFolderId);
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

  upsertClient(name, folderId) {
    const clients = this.getClients();
    const idx = clients.findIndex((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
    if (idx >= 0) {
      clients[idx] = { name: name.trim(), folderId: folderId.trim() };
    } else {
      clients.push({ name: name.trim(), folderId: folderId.trim() });
    }
    this.saveClients(clients);
  },

  deleteClient(name) {
    const clients = this.getClients().filter(
      (c) => c.name.trim().toLowerCase() !== name.trim().toLowerCase(),
    );
    this.saveClients(clients);
  },
};
