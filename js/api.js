import { Auth } from './auth.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

// supportsAllDrives=true is required for any folder that lives in a
// Google Workspace Shared Drive (otherwise Drive returns 404).
const DRIVE_SHARED = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

// Proactive rate limiter. The Sheets API enforces separate ~60/min/user quotas
// for reads and writes, so we track them in independent buckets — otherwise a
// user-initiated write (e.g. editing a cell) would needlessly queue behind a
// dashboard scan's reads and could wait nearly a full minute. We cap each
// bucket below quota, let short bursts through, then pace the rest.
const RATE_LIMIT = 50;
const RATE_WINDOW = 60000;
const reqTimes = { read: [], write: [] };
async function rateLimit(bucket) {
  for (;;) {
    const now = Date.now();
    reqTimes[bucket] = reqTimes[bucket].filter((t) => now - t < RATE_WINDOW);
    if (reqTimes[bucket].length < RATE_LIMIT) {
      reqTimes[bucket].push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, RATE_WINDOW - (now - reqTimes[bucket][0]) + 50));
  }
}

async function gfetch(url, options = {}, { retryOn401 = true, attempt = 0 } = {}) {
  const method = (options.method || 'GET').toUpperCase();
  await rateLimit(method === 'GET' ? 'read' : 'write');
  const token = await Auth.getToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && retryOn401) {
    Auth.signOut();
    return gfetch(url, options, { retryOn401: false, attempt });
  }

  // Retry on 429 (quota exceeded) with exponential backoff, up to 6 attempts
  // (1,2,4,8,16,30s) — enough to outlast a full one-minute quota window.
  if (res.status === 429 && attempt < 6) {
    const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
    const delay = retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 1000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, delay));
    return gfetch(url, options, { retryOn401, attempt: attempt + 1 });
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body?.error?.message || JSON.stringify(body);
    } catch {
      detail = await res.text();
    }
    throw new Error(`Erreur API (${res.status}) : ${detail}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

export const SheetsAPI = {
  get(spreadsheetId, { fields } = {}) {
    const q = fields ? `?fields=${encodeURIComponent(fields)}` : '';
    return gfetch(`${SHEETS}/${spreadsheetId}${q}`);
  },

  getValues(spreadsheetId, range) {
    return gfetch(`${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  },

  // Single-call read: returns every sheet's title + formatted cell values.
  // Lets a chiffrage file be parsed in one request regardless of tab name.
  getGrid(spreadsheetId) {
    const fields = 'sheets(properties(title),data(rowData(values(formattedValue))))';
    return gfetch(`${SHEETS}/${spreadsheetId}?includeGridData=true&fields=${encodeURIComponent(fields)}`);
  },

  updateValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
    return gfetch(
      `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=${valueInputOption}`,
      { method: 'PUT', body: JSON.stringify({ values }) },
    );
  },

  batchUpdateValues(spreadsheetId, data, valueInputOption = 'USER_ENTERED') {
    return gfetch(`${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption, data }),
    });
  },

  appendValues(spreadsheetId, range, values, valueInputOption = 'USER_ENTERED') {
    return gfetch(
      `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=${valueInputOption}&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values }) },
    );
  },

  batchUpdate(spreadsheetId, requests) {
    return gfetch(`${SHEETS}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests }),
    });
  },

  create(title) {
    return gfetch(SHEETS, {
      method: 'POST',
      body: JSON.stringify({ properties: { title } }),
    });
  },

  copySheetTo(sourceSpreadsheetId, sheetId, destinationSpreadsheetId) {
    return gfetch(`${SHEETS}/${sourceSpreadsheetId}/sheets/${sheetId}:copyTo`, {
      method: 'POST',
      body: JSON.stringify({ destinationSpreadsheetId }),
    });
  },
};

export const DriveAPI = {
  listFolders(name, parentId) {
    const q = [
      "mimeType='application/vnd.google-apps.folder'",
      'trashed=false',
      `name='${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
    ].join(' and ');
    return gfetch(`${DRIVE}?q=${encodeURIComponent(q)}&fields=files(id,name)&${DRIVE_SHARED}`);
  },

  // Direct children (folders + files) of a folder, paginated.
  async listChildren(parentId) {
    const q = `'${parentId}' in parents and trashed=false`;
    const files = [];
    let pageToken = '';
    do {
      const params = new URLSearchParams({
        q,
        fields: 'nextPageToken,files(id,name,mimeType,webViewLink,modifiedTime)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await gfetch(`${DRIVE}?${params.toString()}`);
      files.push(...(res.files || []));
      pageToken = res.nextPageToken || '';
    } while (pageToken);
    return files;
  },

  // Create a blank spreadsheet via the Drive API so the file is always in the
  // app's authorised set — this ensures files.delete works even when the OAuth
  // token only covers drive.file scope.  Returns {id, ...} (Drive response).
  createSpreadsheet(name) {
    return gfetch(`${DRIVE}?${DRIVE_SHARED}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.spreadsheet',
      }),
    });
  },

  createFolder(name, parentId) {
    return gfetch(`${DRIVE}?${DRIVE_SHARED}`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId],
      }),
    });
  },

  async getFile(fileId) {
    return gfetch(`${DRIVE}/${fileId}?fields=id,name,parents&${DRIVE_SHARED}`);
  },

  async moveFile(fileId, addParentId) {
    const file = await gfetch(`${DRIVE}/${fileId}?fields=parents&${DRIVE_SHARED}`);
    const removeParents = (file.parents || []).join(',');
    const params = new URLSearchParams({
      addParents: addParentId,
      fields: 'id,parents',
      supportsAllDrives: 'true',
    });
    if (removeParents) params.set('removeParents', removeParents);
    return gfetch(`${DRIVE}/${fileId}?${params.toString()}`, { method: 'PATCH', body: '{}' });
  },

  renameFile(fileId, name) {
    return gfetch(`${DRIVE}/${fileId}?${DRIVE_SHARED}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    });
  },

  // Permanently delete a file. files.delete only works for files the user
  // owns (and, inside a Shared Drive, requires an organizer role); otherwise
  // Drive answers 403. In that case fall back to moving the file to the trash,
  // which only needs write access and still removes it from every scan
  // (all our Drive queries filter on trashed=false).
  async deleteFile(fileId) {
    try {
      return await gfetch(`${DRIVE}/${fileId}?${DRIVE_SHARED}`, { method: 'DELETE' });
    } catch (e) {
      if (!/\(403\)/.test(e.message)) throw e;
      return gfetch(`${DRIVE}/${fileId}?${DRIVE_SHARED}`, {
        method: 'PATCH',
        body: JSON.stringify({ trashed: true }),
      });
    }
  },
};
