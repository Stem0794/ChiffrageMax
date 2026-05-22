import { SheetsAPI } from './api.js';
import { Config } from './config.js';
import { hexToRgb } from './utils.js';

const PLANNING_SHEET = 'Upcoming projects';

const PHASES = [
  { nom: 'Conception', couleur: '#c8e6c9' },
  { nom: 'Developpement', couleur: '#bbdefb' },
  { nom: 'Recette', couleur: '#ffccbc' },
  { nom: 'MEP', couleur: '#f8bbd0' },
];

async function getPlanningSheet() {
  const spreadsheetId = Config.get('spreadsheetId');
  const meta = await SheetsAPI.get(spreadsheetId, {
    fields: 'sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))',
  });
  const sheet = meta.sheets.find((s) => s.properties.title === PLANNING_SHEET);
  if (!sheet) throw new Error(`L'onglet « ${PLANNING_SHEET} » n'a pas été trouvé.`);
  return { spreadsheetId, props: sheet.properties };
}

// Append a project (4 coloured phase rows) to the planning sheet.
export async function ajouterProjetAuPlanning(nomProjet) {
  const name = nomProjet || 'Project name';
  const { spreadsheetId, props } = await getPlanningSheet();
  const sheetId = props.sheetId;

  // Find the current last data row (column A) so we know where new rows land.
  const existing = await SheetsAPI.getValues(spreadsheetId, `'${PLANNING_SHEET}'!A:A`);
  const startRow = (existing.values?.length || 0); // 0-based index of first new row

  const values = PHASES.map((p) => [name, p.nom]);
  await SheetsAPI.appendValues(spreadsheetId, `'${PLANNING_SHEET}'!A1`, values);

  // Colour column B of each new phase row.
  const requests = PHASES.map((p, i) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: startRow + i, endRowIndex: startRow + i + 1,
        startColumnIndex: 1, endColumnIndex: 2,
      },
      cell: { userEnteredFormat: { backgroundColor: hexToRgb(p.couleur) } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  }));
  await SheetsAPI.batchUpdate(spreadsheetId, requests);
}

// Alternate white / light-grey background per project group (port of colorierGroupesAlternes).
export async function colorierGroupesAlternes() {
  const { spreadsheetId, props } = await getPlanningSheet();
  const sheetId = props.sheetId;

  const res = await SheetsAPI.getValues(spreadsheetId, `'${PLANNING_SHEET}'`);
  const values = res.values || [];
  if (values.length < 2) return;

  const numCols = Math.max(...values.map((r) => r.length), props.gridProperties.columnCount || 0);
  const couleurs = ['#FFFFFF', '#F3F3F3'];

  let couleurActuelle = 0;
  let dernierProjet = '';
  const requests = [];

  for (let i = 1; i < values.length; i++) {
    const projet = values[i][0];
    if (projet !== dernierProjet && projet) {
      dernierProjet = projet;
      couleurActuelle = (couleurActuelle + 1) % couleurs.length;
    }
    const bg = hexToRgb(couleurs[couleurActuelle]);

    // Column A.
    requests.push(colourCell(sheetId, i, 0, 1, bg));
    // Columns C..end (skip column B = phase).
    if (numCols >= 3) requests.push(colourCell(sheetId, i, 2, numCols, bg));
  }

  if (requests.length) await SheetsAPI.batchUpdate(spreadsheetId, requests);
}

function colourCell(sheetId, rowIdx, startCol, endCol, backgroundColor) {
  return {
    repeatCell: {
      range: { sheetId, startRowIndex: rowIdx, endRowIndex: rowIdx + 1, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: { userEnteredFormat: { backgroundColor } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  };
}
