import { Config } from './config.js';

// Least-privilege scope: `drive.file` grants access ONLY to files this app
// creates and to items the user explicitly selects via the Google Picker — never
// the user's whole Drive. This is what keeps unrelated files (bills, personal
// docs, other spreadsheets) out of reach even if the page is ever compromised.
// The Sheets API operates on those same per-file-granted spreadsheets, so no
// separate `spreadsheets` scope is needed.
const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
].join(' ');

const STORAGE_KEY = 'chiffragemax.token';

let tokenClient = null;
let accessToken = null;
let tokenExpiry = 0;
const listeners = new Set();

function notify() {
  for (const fn of listeners) fn(Boolean(accessToken));
}

// Persist the token so the session survives a browser restart (within its
// ~1h lifetime). It's short-lived; after expiry getToken() refreshes silently.
function persistToken() {
  try {
    if (accessToken && Date.now() < tokenExpiry) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ accessToken, tokenExpiry }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* storage unavailable — degrade to in-memory only */ }
}

function restoreToken() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const { accessToken: tok, tokenExpiry: exp } = JSON.parse(raw);
    if (tok && typeof exp === 'number' && Date.now() < exp) {
      accessToken = tok;
      tokenExpiry = exp;
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch { /* ignore malformed/unavailable storage */ }
}

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
