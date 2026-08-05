import { Auth } from './auth.js';

const DRIVE  = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FILE_NAME = 'ChiffrageMax-Config.json';
const DRIVE_SHARED = 'supportsAllDrives=true&includeItemsFromAllDrives=true';

async function tok() { return Auth.getToken(); }

export const DriveConfig = {
  _fileId: null,
  _sharedId: null, // when set, use this file ID directly (shared team config)

  reset() { this._fileId = null; },

  setSharedConfigId(id) {
    // Accept a pasted Drive URL (…/d/<id>/view) as well as a bare file ID —
    // otherwise the full URL gets used as the ID and every Drive call 404s.
    const m = id && String(id).match(/\/d\/([a-zA-Z0-9_-]+)/);
    this._sharedId = (m ? m[1] : id) || null;
    this._fileId = null; // force re-resolution on next operation
  },

  getFileId() { return this._fileId; },

  async _find() {
    if (this._fileId) return this._fileId;
    // If a shared config file is configured, use it directly.
    if (this._sharedId) {
      this._fileId = this._sharedId;
      return this._fileId;
    }
    const t = await tok();
    const q = `name='${FILE_NAME}' and trashed=false and mimeType='application/json'`;
    const res = await fetch(
      `${DRIVE}?q=${encodeURIComponent(q)}&spaces=drive&orderBy=modifiedTime%20desc&fields=files(id,modifiedTime)&${DRIVE_SHARED}`,
      { headers: { Authorization: `Bearer ${t}` } },
    );
    if (!res.ok) throw new Error(`Recherche Drive (${res.status})`);
    const data = await res.json();
    this._fileId = data.files?.[0]?.id || null;
    return this._fileId;
  },

  async load() {
    const id = await this._find();
    if (!id) return null;
    const t = await tok();
    let res = await fetch(`${DRIVE}/${id}?alt=media&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${t}` },
    });
    if (res.status === 404 && !this._sharedId && this._fileId === id) {
      this._fileId = null;
      const replacement = await this._find();
      if (!replacement) return null;
      res = await fetch(`${DRIVE}/${replacement}?alt=media&supportsAllDrives=true`, {
        headers: { Authorization: `Bearer ${t}` },
      });
    }
    if (!res.ok) throw new Error(`Lecture config Drive (${res.status})`);
    try { return await res.json(); } catch { return null; }
  },

  async save(data, retry = true) {
    const t   = await tok();
    const body = JSON.stringify(data, null, 2);
    const id   = await this._find();

    if (id) {
      const res = await fetch(`${UPLOAD}/${id}?uploadType=media&supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body,
      });
      if (!res.ok) {
        if (res.status === 404 && retry && !this._sharedId && this._fileId === id) {
          this._fileId = null;
          return this.save(data, false);
        }
        throw new Error(`Sauvegarde Drive (${res.status})`);
      }
    } else {
      // Multipart create: metadata + content in one request
      const bnd  = `cfgmax_${Date.now()}`;
      const meta = JSON.stringify({ name: FILE_NAME, mimeType: 'application/json' });
      const mp   = `--${bnd}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`
                 + `${meta}\r\n--${bnd}\r\nContent-Type: application/json\r\n\r\n`
                 + `${body}\r\n--${bnd}--`;
      const res  = await fetch(`${UPLOAD}?uploadType=multipart&fields=id&${DRIVE_SHARED}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${t}`,
          'Content-Type': `multipart/related; boundary=${bnd}`,
        },
        body: mp,
      });
      if (!res.ok) throw new Error(`Création config Drive (${res.status}): ${await res.text()}`);
      this._fileId = (await res.json()).id;
    }
  },
};
