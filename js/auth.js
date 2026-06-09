import { Config } from './config.js';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
].join(' ');

const STORAGE_KEY = 'chiffragemax.token';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(Boolean(accessToken));
}

// Persist the token in sessionStorage so the session survives a page reload
// (within its ~1h lifetime) but is NOT written to long-term disk and is cleared
// automatically when the browser/tab is closed — shrinking the window in which a
// leaked token could be reused. It's short-lived; after expiry getToken()
// refreshes silently.
function persistToken() {
  try {
    if (accessToken && Date.now() < tokenExpiry) {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, tokenExpiry }));
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* storage unavailable — degrade to in-memory only */ }
}

function restoreToken() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { accessToken: tok, tokenExpiry: exp } = JSON.parse(raw);
    if (tok && typeof exp === 'number' && Date.now() < exp) {
      accessToken = tok;
      tokenExpiry = exp;
    } else {
      sessionStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* ignore malformed/unavailable storage */ }
}

// One-time migration: scrub any token persisted to localStorage by older
// versions so it no longer lingers on disk.
try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }

restoreToken();

function ensureClient() {
  const clientId = Config.get('clientId');
  if (!clientId) throw new Error('Client ID OAuth manquant. Renseignez-le dans la configuration.');
  if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
    throw new Error("La librairie Google Identity n'est pas encore chargée. Réessayez dans un instant.");
  }
  if (!tokenClient || tokenClient.__clientId !== clientId) {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {},
    });
    tokenClient.__clientId = clientId;
  }
  return tokenClient;
}

function requestToken({ prompt } = {}) {
  return new Promise((resolve, reject) => {
    const client = ensureClient();
    client.callback = (resp) => {
      if (resp.error) {
        reject(new Error(resp.error_description || resp.error));
        return;
      }
      accessToken = resp.access_token;
      tokenExpiry = Date.now() + (Number(resp.expires_in) - 60) * 1000;
      persistToken();
      notify();
      resolve(accessToken);
    };
    try {
      client.requestAccessToken(prompt !== undefined ? { prompt } : {});
    } catch (e) {
      reject(e);
    }
  });
}

export const Auth = {
  onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  isSignedIn() {
    return Boolean(accessToken) && Date.now() < tokenExpiry;
  },

  signIn() {
    return requestToken({ prompt: 'consent' });
  },

  signOut() {
    if (accessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiry = 0;
    persistToken();
    notify();
  },

  async getToken() {
    if (this.isSignedIn()) return accessToken;
    return requestToken({ prompt: '' });
  },
};
