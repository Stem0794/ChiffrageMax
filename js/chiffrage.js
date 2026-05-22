import { SheetsAPI, DriveAPI } from './api.js';
import { Config } from './config.js';
import {
  colLetter, hexToRgb, formatDateParts, cleanProjectName, spreadsheetUrl,
} from './utils.js';

const MODEL_SHEET_NAME = 'ModeleChiffrage';

// Rate reference cells (column 2..12 -> $B$7 .. $L$7) used in the phase formulas.
const TJM_MAP = {
  2: '$B$7', 3: '$C$7', 4: '$D$7', 5: '$E$7', 6: '$F$7', 7: '$G$7',
  8: '$H$7', 9: '$I$7', 10: '$J$7', 11: '$K$7', 12: '$L$7',
};

// Read ConfigPhases (columns A: phase, B: items) and return sorted [{phase, items}].
export async function readPhasesConfig() {
  const spreadsheetId = Config.get('spreadsheetId');
  const res = await SheetsAPI.getValues(spreadsheetId, 'ConfigPhases!A2:B');
  const rows = res.values || [];
  const phases = rows
    .filter((r) => r[0] && r[1])
    .map((r) => ({ phase: Number(r[0]), items: Number(r[1]) }));
  phases.sort((a, b) => a.phase - b.phase);
  return phases;
}

// Locate the ModeleChiffrage sheet inside the dashboard spreadsheet.
async function getModelSheet() {
  const spreadsheetId = Config.get('spreadsheetId');
  const meta = await SheetsAPI.get(spreadsheetId, {
    fields: 'sheets(properties(sheetId,title,gridProperties(columnCount)))',
  });
  const sheet = meta.sheets.find((s) => s.properties.title === MODEL_SHEET_NAME);
  if (!sheet) throw new Error(`Feuille « ${MODEL_SHEET_NAME} » introuvable dans le classeur.`);
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

const VALIDATION_OPTIONS = ['Envoyé', 'Validé', 'Passé en TMA', 'Refusé', 'Annulé'];

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
          values: VALIDATION_OPTIONS.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        strict: false,
      },
    },
  }]);
}

/**
 * Create a new estimate file for the dashboard row at `rowNumber` (1-based, header = 1).
 * `entry` = { numDevis, client, projet, ticket, date(Date|null), status, targetFolderId? }.
 *   targetFolderId: if provided, place the file directly in that folder instead of the
 *   default root/year/month hierarchy.
 * Returns { id, url, idChiffrage }.
 */
export async function nouveauChiffrage(rowNumber, entry) {
  const spreadsheetId = Config.get('spreadsheetId');
  const { numDevis, client, projet, ticket, date, status, targetFolderId } = entry;

  if (!client || !projet) throw new Error('Renseignez au moins le Client et le Projet.');

  // Use phases passed by the caller; fall back to the ConfigPhases sheet.
  const phases = (entry.phases?.length)
    ? entry.phases
    : await readPhasesConfig();
  if (!phases.length) throw new Error('Aucune configuration dans ConfigPhases.');

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
  // If caller passed a specific folder ID, use it directly; otherwise resolve year/month.
  const destFolderId = targetFolderId || await resolveMonthFolder(yearStr, monthStr);

  // Create the new spreadsheet, copy the model sheet into it, rename, drop default sheet.
  const model = await getModelSheet();
  const created = await SheetsAPI.create(idChiffrage);
  const newId = created.spreadsheetId;
  const defaultSheetId = created.sheets[0].properties.sheetId;

  const copied = await SheetsAPI.copySheetTo(spreadsheetId, model.sheetId, newId);
  const copiedSheetId = copied.sheetId;

  await SheetsAPI.batchUpdate(newId, [
    { updateSheetProperties: { properties: { sheetId: copiedSheetId, title: 'Chiffrage' }, fields: 'title' } },
    { deleteSheet: { sheetId: defaultSheetId } },
  ]);

  // Move the file into the chosen folder.
  await DriveAPI.moveFile(newId, destFolderId);

  // Fill the model header (C1:C4).
  // Pass date as YYYY-MM-DD so Sheets parses it correctly in any locale.
  const dateValue = dateIsUnknown ? 'Unknown' : date.toISOString().split('T')[0];
  await SheetsAPI.updateValues(newId, 'Chiffrage!C1:C4', [
    [client], [projet], [ticket || ''], [dateValue],
  ]);

  // Apply client-specific TJM rates to row 7 (B7:L7), overriding the model defaults.
  // Only cells with an explicit rate are written; blank entries keep the model value.
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

  // Update the dashboard row: A=ID, G=status (if empty), H=URL, I=montant(0).
  const url = spreadsheetUrl(newId);
  const updates = [
    { range: `Chiffrage!A${rowNumber}`, values: [[idChiffrage]] },
    { range: `Chiffrage!H${rowNumber}`, values: [[url]] },
    { range: `Chiffrage!I${rowNumber}`, values: [[0]] },
  ];
  if (!status) updates.push({ range: `Chiffrage!G${rowNumber}`, values: [['Brouillon']] });
  await SheetsAPI.batchUpdateValues(spreadsheetId, updates);

  return { id: newId, url, idChiffrage };
}
