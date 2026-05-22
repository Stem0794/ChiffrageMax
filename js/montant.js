import { SheetsAPI } from './api.js';
import { Config } from './config.js';
import { extractSpreadsheetId } from './utils.js';

/**
 * Read the total amount from an estimate file (faithful port of getMontantFromChiffrage).
 * Prefers a more specific "TOTAL ... WITHOUT VAT" line (ANNUEL, REMISÉ, DISCOUNT, …)
 * over the base "- BUILD" line; falls back to BUILD.
 */
export async function getMontantFromChiffrage(url) {
  const fileId = extractSpreadsheetId(url);
  if (!fileId) return 0;

  try {
    const meta = await SheetsAPI.get(fileId, { fields: 'sheets(properties(title))' });
    const titles = meta.sheets.map((s) => s.properties.title);
    const sheetName = titles.includes('Chiffrage') ? 'Chiffrage' : titles[0];

    const res = await SheetsAPI.getValues(fileId, `'${sheetName.replace(/'/g, "''")}'`);
    const data = res.values || [];

    let buildCandidate = 0;
    let specificCandidate = 0;

    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      for (let j = 0; j < row.length; j++) {
        const cell = String(row[j]).toUpperCase();
        if (!cell.includes('TOTAL') || !cell.includes('WITHOUT VAT')) continue;

        let amount = 0;
        for (let k = j + 1; k < row.length; k++) {
          const val = parseAmount(row[k]);
          if (val > 0) { amount = val; break; }
        }
        if (!amount) continue;

        if (cell.includes('BUILD') && !cell.replace('BUILD', '').match(/[A-Z]{3,}/)) {
          buildCandidate = amount;
        } else {
          specificCandidate = amount;
        }
      }
    }

    return specificCandidate || buildCandidate;
  } catch (e) {
    console.error('getMontantFromChiffrage:', e.message);
    return 0;
  }
}

// Values come back as strings; accept "1 234,56 €" style numbers too.
function parseAmount(val) {
  if (typeof val === 'number') return val;
  if (val == null) return 0;
  const cleaned = String(val).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Update column I for a single dashboard row from the file URL in column H.
export async function updateMontantForRow(rowNumber, url) {
  if (!url) return 0;
  const montant = await getMontantFromChiffrage(url);
  const spreadsheetId = Config.get('spreadsheetId');
  await SheetsAPI.updateValues(spreadsheetId, `Chiffrage!I${rowNumber}`, [[montant]]);
  return montant;
}
