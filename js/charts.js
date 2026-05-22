import { SheetsAPI } from './api.js';
import { Config } from './config.js';

const TMA_SHEET = 'Fonctionnalitées';

// Detect the header row by scanning the first rows for "devis"/"fonctionnalit".
function trouverLigneEntete(data) {
  for (let i = 0; i < data.length; i++) {
    const rowStr = (data[i] || []).join('|').toLowerCase();
    if (rowStr.includes('devis') || rowStr.includes('fonctionnalit')) return i;
  }
  return 0;
}

function num(v) {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/[^\d.,-]/g, '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

let chartInstance = null;

/**
 * Build Budget vs Consommé per devis (port of creerGraphiqueTMA) and render it
 * with Chart.js into the #tmaChart canvas.
 */
export async function buildTmaChartData() {
  const spreadsheetId = Config.get('spreadsheetId');

  const chiffrageRes = await SheetsAPI.getValues(spreadsheetId, 'Chiffrage!A2:I');
  const chiffrageData = chiffrageRes.values || [];

  const budgetParDevis = {};
  const devisOrder = [];
  for (const row of chiffrageData) {
    const numDevis = String(row[1] ?? '').trim(); // B
    const montant = num(row[8]); // I
    if (!numDevis) continue;
    if (!(numDevis in budgetParDevis)) {
      devisOrder.push(numDevis);
      budgetParDevis[numDevis] = 0;
    }
    budgetParDevis[numDevis] += montant;
  }

  if (!devisOrder.length) throw new Error('Aucun N° devis trouvé dans la feuille Chiffrage.');

  // Read Fonctionnalitées and locate the N°devis + Budget columns.
  const tmaRes = await SheetsAPI.getValues(spreadsheetId, `'${TMA_SHEET}'`);
  const tma = tmaRes.values || [];
  if (!tma.length) throw new Error(`La feuille « ${TMA_SHEET} » est vide.`);

  const headerRowIdx = trouverLigneEntete(tma.slice(0, 5));
  const headers = tma[headerRowIdx] || [];
  const lastColTMA = Math.max(...tma.map((r) => r.length));

  let colNumDevis = -1;
  let colBudget = -1;
  headers.forEach((header, idx) => {
    const h = String(header).toLowerCase().replace(/\s+/g, '').replace(/°/g, '');
    if (colNumDevis === -1 && (h.includes('ndevis') || h.includes('numdevis'))) colNumDevis = idx;
    if (colBudget === -1 && h === 'budget') colBudget = idx;
  });
  if (colNumDevis === -1) colNumDevis = 3;
  if (colBudget === -1) colBudget = lastColTMA - 1;

  const consommeParDevis = {};
  for (let i = headerRowIdx + 1; i < tma.length; i++) {
    const row = tma[i] || [];
    const numDevis = String(row[colNumDevis] ?? '').trim();
    if (!numDevis) continue;
    consommeParDevis[numDevis] = (consommeParDevis[numDevis] || 0) + num(row[colBudget]);
  }

  return devisOrder.map((devis) => {
    const budget = budgetParDevis[devis] || 0;
    const consomme = consommeParDevis[devis] || 0;
    const pct = budget > 0 ? `${Math.round((consomme / budget) * 100)}%` : '0%';
    return { label: `${devis} (${pct})`, budget, consomme };
  });
}

export async function renderTmaChart(canvas) {
  const rows = await buildTmaChartData();

  if (chartInstance) chartInstance.destroy();
  chartInstance = new window.Chart(canvas, {
    type: 'bar',
    data: {
      labels: rows.map((r) => r.label),
      datasets: [
        { label: 'Budget Chiffrage (€)', data: rows.map((r) => r.budget), backgroundColor: '#4285F4' },
        { label: 'Consommé (€)', data: rows.map((r) => r.consomme), backgroundColor: '#EA4335' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'Montant (€)' } },
        y: { title: { display: true, text: 'N° Devis' } },
      },
      plugins: { legend: { position: 'bottom' } },
    },
  });

  canvas.parentElement.style.height = `${Math.max(240, rows.length * 60 + 100)}px`;
  return rows.length;
}
