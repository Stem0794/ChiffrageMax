// 1-based column number -> A1 column letters (1 -> A, 27 -> AA)
export function colLetter(n) {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// "#RRGGBB" -> {red,green,blue} normalised to 0..1 for the Sheets API
export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return {
    red: parseInt(h.slice(0, 2), 16) / 255,
    green: parseInt(h.slice(2, 4), 16) / 255,
    blue: parseInt(h.slice(4, 6), 16) / 255,
  };
}

export function extractSpreadsheetId(url) {
  if (!url) return null;
  const m = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
  return m ? m[1] : null;
}

export function extractFolderId(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.length > 20 && !trimmed.includes('/') && !trimmed.includes('.')) return trimmed;
  const patterns = [/\/folders\/([a-zA-Z0-9_-]+)/, /id=([a-zA-Z0-9_-]+)/, /^([a-zA-Z0-9_-]{28,})$/];
  for (const p of patterns) {
    const match = trimmed.match(p);
    if (match) return match[1] || match[0];
  }
  return null;
}

export function formatDateParts(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const d = pad(date.getDate());
  const m = pad(date.getMonth() + 1);
  const yyyy = date.getFullYear();
  const yy = String(yyyy).slice(-2);
  return {
    yearStr: String(yyyy),
    monthStr: `${yyyy}-${m}`,
    dateStrId: `${d}/${m}/${yy}`,
  };
}

export function cleanProjectName(projet) {
  return String(projet).substring(0, 100).replace(/[\\/:*?[\]]/g, ' ').trim();
}

export function spreadsheetUrl(id) {
  return `https://docs.google.com/spreadsheets/d/${id}/edit`;
}
