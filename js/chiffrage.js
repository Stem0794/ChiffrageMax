import { SheetsAPI, DriveAPI } from './api.js';
import { Config } from './config.js';
import {
  colLetter, hexToRgb, formatDateParts, cleanProjectName, spreadsheetUrl,
} from './utils.js';

const VALIDATION_STATUSES = ['Envoyé', 'Validé', 'Passé en TMA', 'Refusé', 'Annulé'];
export const STATUS_OPTIONS = ['', ...VALIDATION_STATUSES];

// Rate reference cells (column 2..12 -> $B$7 .. $L$7) used in the phase formulas.
const TJM_MAP = {
  2: '$B$7', 3: '$C$7', 4: '$D$7', 5: '$E$7', 6: '$F$7', 7: '$G$7',
  8: '$H$7', 9: '$I$7', 10: '$J$7', 11: '$K$7', 12: '$L$7',
};

// Locate the model sheet inside the standalone template spreadsheet.
// Prefers a tab named ModeleChiffrage, then Chiffrage, else the first sheet.
export async function getModelSheet() {
  const templateId = Config.get('templateId');
  if (!templateId) throw new Error('ID du modèle manquant. Renseignez-le dans la configuration.');
  const meta = await SheetsAPI.get(templateId, {
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))',
  });
  const sheets = meta.sheets || [];
  const sheet = sheets.find((s) => s.properties.title === 'ModeleChiffrage')
    || sheets.find((s) => s.properties.title === 'Chiffrage')
    || sheets[0];
  if (!sheet) throw new Error('Aucune feuille trouvée dans le modèle.');
  return sheet.properties;
}

// Resolve (creating if needed) the year/month subfolders under the configured root.
async function resolveMonthFolder(yearStr, monthStr) {
  const rootId = Config.get('rootFolderId');

  let res = await DriveAPI.listFolders(yearStr, rootId);
  const yearFolder = res.files?.[0] || (await DriveAPI.createFolder(yearStr, rootId));

  res = await DriveAPI.listFolders(monthStr, yearFolder.id);
  const monthFolder = res.files?.[0] || (await DriveAPI.createFolder(monthStr, yearFolder.id));

  return monthFolder.id;
}

/**
 * Translate genererChiffrageSelonConfig to the Sheets REST API.
 * Mirrors the imperative GAS sequence: structural row inserts + format copies are
 * issued in document order via batchUpdate, then formulas/labels via values:batchUpdate,
 * then total-row formatting. All row positions match the original running counters.
 */
async function genererChiffrageSelonConfig(newSpreadsheetId, sheetId, lastCol, itemsPhase1, otherPhases) {
  const ROW_PHASE = 9; // header row of phase 1 (1-based)
  const ROW_ITEM = 10; // first item row template (1-based)
  const COL_MANDAYS = 14; // N
  const COL_BUDGET = 15; // O

  const structural = [];

  const copyRow = (srcRow1, dstRow1) => ({
    copyPaste: {
      source: {
        sheetId, startRowIndex: srcRow1 - 1, endRowIndex: srcRow1,
        startColumnIndex: 0, endColumnIndex: lastCol,
      },
      destination: {
        sheetId, startRowIndex: dstRow1 - 1, endRowIndex: dstRow1,
        startColumnIndex: 0, endColumnIndex: lastCol,
      },
      pasteType: 'PASTE_NORMAL',
      pasteOrientation: 'NORMAL',
    },
  });

  const insertRows = (startRow1, count) => ({
    insertDimension: {
      range: { sheetId, dimension: 'ROWS', startIndex: startRow1 - 1, endIndex: startRow1 - 1 + count },
      inheritFromBefore: true,
    },
  });

  // --- Phase 1: expand item rows beyond the single template row ---
  const existingItemsPhase1 = 1;
  if (itemsPhase1 > existingItemsPhase1) {
    const extra = itemsPhase1 - existingItemsPhase1;
    structural.push(insertRows(ROW_ITEM + 1, extra)); // insert after row 10
    for (let i = 0; i < extra; i++) {
      structural.push(copyRow(ROW_ITEM, ROW_ITEM + 1 + i));
    }
  }

  const firstItem1 = ROW_ITEM;
  const lastItem1 = firstItem1 + itemsPhase1 - 1;

  const phaseTotalRows = [ROW_PHASE];
  const phasesMeta = [{ rowHeader: ROW_PHASE, rowFirstItem: firstItem1, rowLastItem: lastItem1 }];
  const phaseLabels = []; // {row, label}

  let insertPos = lastItem1 + 1;

  for (const cfg of otherPhases) {
    const p = Number(cfg.phase);
    const nbItems = Number(cfg.items);
    const nbRowsToInsert = 1 + 1 + nbItems; // blank + header + items

    structural.push(insertRows(insertPos, nbRowsToInsert));

    const rowHeader = insertPos + 1;
    const rowFirst = insertPos + 2;
    const rowLast = rowFirst + nbItems - 1;

    structural.push(copyRow(ROW_PHASE, rowHeader));
    for (let r = rowFirst; r <= rowLast; r++) {
      structural.push(copyRow(ROW_ITEM, r));
    }

    phaseLabels.push({ row: rowHeader, label: `${p} - NOUVELLE PHASE` });
    phaseTotalRows.push(rowHeader);
    phasesMeta.push({ rowHeader, rowFirstItem: rowFirst, rowLastItem: rowLast });

    insertPos = rowLast + 1;
  }

  const totalRow = insertPos + 1;
  const COL_LABEL = 12; // L

  if (structural.length) {
    await SheetsAPI.batchUpdate(newSpreadsheetId, structural);
  }

  // --- Formulas + labels (values:batchUpdate, USER_ENTERED) ---
  const data = [];
  const setCell = (row, col, value) => {
    data.push({ range: `Chiffrage!${colLetter(col)}${row}`, values: [[value]] });
  };

  // Phase header rate formulas + budget sums for every phase block.
  for (const meta of phasesMeta) {
    for (const colStr of Object.keys(TJM_MAP)) {
      const col = Number(colStr);
      const a = `${colLetter(col)}${meta.rowFirstItem}`;
      const b = `${colLetter(col)}${meta.rowLastItem}`;
      setCell(meta.rowHeader, col, `=SUM(${a}:${b})*${TJM_MAP[colStr]}`);
    }
    const ba = `${colLetter(COL_BUDGET)}${meta.rowFirstItem}`;
    const bb = `${colLetter(COL_BUDGET)}${meta.rowLastItem}`;
    setCell(meta.rowHeader, COL_BUDGET, `=SUM(${ba}:${bb})`);

    // Mandays sum (column N).
    if (meta.rowLastItem >= meta.rowFirstItem) {
      const ma = `${colLetter(COL_MANDAYS)}${meta.rowFirstItem}`;
      const mb = `${colLetter(COL_MANDAYS)}${meta.rowLastItem}`;
      setCell(meta.rowHeader, COL_MANDAYS, `=SUM(${ma}:${mb})`);
    } else {
      setCell(meta.rowHeader, COL_MANDAYS, 0);
    }
  }

  for (const { row, label } of phaseLabels) setCell(row, 1, label);

  // Global total row.
  setCell(totalRow, COL_LABEL, 'TOTAL (WITHOUT VAT) - BUILD');
  const totalCells = phaseTotalRows.map((r) => `${colLetter(COL_BUDGET)}${r}`);
  setCell(totalRow, COL_BUDGET, `=SUM(${totalCells.join(',')})`);

  await SheetsAPI.batchUpdateValues(newSpreadsheetId, data);

  // --- Total row formatting (bold, dark background, white text) ---
  await SheetsAPI.batchUpdate(newSpreadsheetId, [{
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: totalRow - 1, endRowIndex: totalRow,
        startColumnIndex: COL_LABEL - 1, endColumnIndex: COL_BUDGET,
      },
      cell: {
        userEnteredFormat: {
          backgroundColor: hexToRgb('#555555'),
          textFormat: { bold: true, foregroundColor: hexToRgb('#ffffff') },
        },
      },
      fields: 'userEnteredFormat(backgroundColor,textFormat)',
    },
  }]);

  // --- "Validation chiffrage" dropdown ---
  // Scan column A for the label (it shifts down with phase insertions), then apply
  // a dropdown validation to the cell immediately below it.
  await setValidationChiffrageDropdown(newSpreadsheetId, sheetId);
}

async function setValidationChiffrageDropdown(spreadsheetId, sheetId) {
  const res = await SheetsAPI.getValues(spreadsheetId, 'Chiffrage!A:A');
  const colA = (res.values || []).flat();
  const labelIdx = colA.findIndex((v) => String(v).toLowerCase().includes('validation chiffrage'));
  if (labelIdx < 0) return; // label not present in model — skip

  const dropdownRow0 = labelIdx + 1; // 0-based index of the cell below the label
  await SheetsAPI.batchUpdate(spreadsheetId, [{
    setDataValidation: {
      range: {
        sheetId,
        startRowIndex: dropdownRow0, endRowIndex: dropdownRow0 + 1,
        startColumnIndex: 0, endColumnIndex: 1,
      },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: VALIDATION_STATUSES.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
      },
    },
  }]);
}

/**
 * Create a new estimate file from the standalone template.
 * `entry` = { numDevis, client, projet, ticket, date(Date|null), targetFolderId?, phases }.
 *   targetFolderId: place the file directly in that folder; otherwise root/year/month.
 * Returns { id, url, idChiffrage }.
 */
export async function nouveauChiffrage(entry) {
  const { numDevis, client, projet, ticket, date, targetFolderId, phases } = entry;

  if (!client || !projet) throw new Error('Renseignez au moins le Client et le Projet.');
  if (!phases?.length) throw new Error('Configurez au moins une phase.');

  const phase1Config = phases[0];
  const otherPhases = phases.slice(1);

  // Date handling for ID + folder structure.
  const dateIsUnknown = !date;
  let yearStr; let monthStr; let dateStrId;
  if (dateIsUnknown) {
    yearStr = 'Unknown';
    monthStr = 'Unknown';
    dateStrId = 'Unknown';
  } else {
    ({ yearStr, monthStr, dateStrId } = formatDateParts(date));
  }

  const idChiffrage = `CHI-${dateStrId}- ${cleanProjectName(projet)}`;

  // Resolve target Drive folder.
  const destFolderId = targetFolderId || await resolveMonthFolder(yearStr, monthStr);

  // Create the new spreadsheet, copy the model sheet from the template, rename, drop default sheet.
  const templateId = Config.get('templateId');
  const model = await getModelSheet();
  const created = await SheetsAPI.create(idChiffrage);
  const newId = created.spreadsheetId;
  const defaultSheetId = created.sheets[0].properties.sheetId;

  const copied = await SheetsAPI.copySheetTo(templateId, model.sheetId, newId);
  const copiedSheetId = copied.sheetId;

  await SheetsAPI.batchUpdate(newId, [
    { updateSheetProperties: { properties: { sheetId: copiedSheetId, title: 'Chiffrage' }, fields: 'title' } },
    { deleteSheet: { sheetId: defaultSheetId } },
  ]);

  // Move the file into the chosen folder.
  await DriveAPI.moveFile(newId, destFolderId);

  // Fill the header (C1:C5). Date as YYYY-MM-DD so Sheets parses it in any locale.
  // N° devis is stored in C5 so the dashboard can read it back when scanning Drive.
  const dateValue = dateIsUnknown ? 'Unknown' : date.toISOString().split('T')[0];
  await SheetsAPI.updateValues(newId, 'Chiffrage!C1:C5', [
    [client], [projet], [ticket || ''], [dateValue], [numDevis || ''],
  ]);

  // Apply client-specific TJM rates to row 7 (B7:L7), overriding the model defaults.
  const clientTjm = Config.getClientTjm(client);
  if (Array.isArray(clientTjm)) {
    const tjmUpdates = [];
    clientTjm.forEach((rate, i) => {
      if (rate !== null && rate !== undefined && rate !== '') {
        tjmUpdates.push({ range: `Chiffrage!${colLetter(2 + i)}7`, values: [[rate]] });
      }
    });
    if (tjmUpdates.length) await SheetsAPI.batchUpdateValues(newId, tjmUpdates);
  }

  // Generate phases / items / formulas.
  const lastCol = model.gridProperties?.columnCount || 15;
  await genererChiffrageSelonConfig(newId, copiedSheetId, lastCol, phase1Config.items, otherPhases);

  return { id: newId, url: spreadsheetUrl(newId), idChiffrage };
}

/* ---------- Dashboard: scan Drive folders for chiffrage files ---------- */

// Recursively collect CHI-* spreadsheet files under the given folders.
async function collectChiffrageFiles(folderIds) {
  const found = [];
  const seen = new Set();

  async function walk(folderId) {
    if (!folderId || seen.has(folderId)) return;
    seen.add(folderId);
    const children = await DriveAPI.listChildren(folderId);
    for (const f of children) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        await walk(f.id);
      } else if (
        f.mimeType === 'application/vnd.google-apps.spreadsheet'
        && f.name.startsWith('CHI-')
      ) {
        found.push(f);
      }
    }
  }

  for (const id of folderIds) await walk(id);
  return found;
}

// Read one chiffrage file in a single pass: header (C1:C5), validation status, total.
export async function readChiffrageFile(file) {
  const meta = await SheetsAPI.get(file.id, { fields: 'sheets(properties(title))' });
  const titles = (meta.sheets || []).map((s) => s.properties.title);
  const sheetName = titles.includes('Chiffrage') ? 'Chiffrage' : (titles[0] || 'Chiffrage');

  const res = await SheetsAPI.getValues(file.id, `'${sheetName.replace(/'/g, "''")}'`);
  const data = res.values || [];
  const cell = (r, c) => (data[r] && data[r][c] != null ? String(data[r][c]) : '');

  // Validation status: cell below the "Validation chiffrage" label (column A).
  let status = '';
  let statusRow = 0; // 1-based
  const labelIdx = data.findIndex((row) => row.some((v) => String(v).toLowerCase().includes('validation chiffrage')));
  if (labelIdx >= 0) {
    statusRow = labelIdx + 2;
    status = cell(labelIdx + 1, 0);
  }

  return {
    id: file.id,
    name: file.name,
    url: file.webViewLink || spreadsheetUrl(file.id),
    sheetName,
    client: cell(0, 2), // C1
    projet: cell(1, 2), // C2
    ticket: cell(2, 2), // C3
    date: cell(3, 2), // C4
    numDevis: cell(4, 2), // C5
    status,
    statusRow,
    montant: extractMontant(data),
  };
}

// Find the total amount (port of getMontantFromChiffrage's scan) from sheet values.
function extractMontant(data) {
  let buildCandidate = 0;
  let specificCandidate = 0;
  for (let i = 0; i < data.length; i++) {
    const row = data[i] || [];
    for (let j = 0; j < row.length; j++) {
      const c = String(row[j]).toUpperCase();
      if (!c.includes('TOTAL') || !c.includes('WITHOUT VAT')) continue;
      let amount = 0;
      for (let k = j + 1; k < row.length; k++) {
        const val = parseAmount(row[k]);
        if (val > 0) { amount = val; break; }
      }
      if (!amount) continue;
      if (c.includes('BUILD') && !c.replace('BUILD', '').match(/[A-Z]{3,}/)) buildCandidate = amount;
      else specificCandidate = amount;
    }
  }
  return specificCandidate || buildCandidate;
}

function parseAmount(val) {
  if (typeof val === 'number') return val;
  if (val == null) return 0;
  const n = parseFloat(String(val).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

// List all chiffrages by scanning client folders + the global root folder.
export async function listChiffrages() {
  const folderIds = [
    ...Config.getClients().map((c) => c.folderId).filter(Boolean),
    Config.get('rootFolderId'),
  ].filter(Boolean);
  const unique = [...new Set(folderIds)];

  const files = await collectChiffrageFiles(unique);
  const results = await Promise.all(files.map((f) => readChiffrageFile(f)));
  // Most recent first by file name (CHI-DD/MM/YY...), best-effort.
  return results.sort((a, b) => b.name.localeCompare(a.name));
}

// Persist a status change to the validation dropdown cell of a chiffrage file.
export async function setChiffrageStatus(fileId, sheetName, statusRow, status) {
  if (!statusRow) throw new Error("Cellule « Validation chiffrage » introuvable dans ce fichier.");
  const sn = `'${sheetName.replace(/'/g, "''")}'`;
  await SheetsAPI.updateValues(fileId, `${sn}!A${statusRow}`, [[status]]);
}
