const STORAGE_KEY = 'chiffragemax.config';

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
};
