import { Config } from './config.js';
import { Auth } from './auth.js';
import { SheetsAPI } from './api.js';
import { nouveauChiffrage } from './chiffrage.js';
import { updateMontantForRow, getMontantFromChiffrage } from './montant.js';
import { renderTmaChart } from './charts.js';
import { ajouterProjetAuPlanning, colorierGroupesAlternes } from './planning.js';
import { formatDateParts, extractSpreadsheetId, extractFolderId } from './utils.js';

const STATUS_OPTIONS = ['', 'Brouillon', 'Envoyé', 'Devis validé', 'Refusé'];

const $ = (id) => document.getElementById(id);

let rows = []; // [{ rowNumber, data: [A..I] }]

/* ---------- UI helpers ---------- */
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  setTimeout(() => el.classList.add('hidden'), 3500);
}

function showGlobalError(msg) {
  const el = $('globalError');
  if (!msg) { el.classList.add('hidden'); return; }
  el.textContent = msg;
  el.classList.remove('hidden');
}

function busy(button, isBusy, label) {
  if (!button) return;
  if (isBusy) {
    button.dataset.label = button.innerHTML;
    button.innerHTML = `<span class="spinner"></span> ${label || ''}`.trim();
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.label || button.innerHTML;
    button.disabled = false;
  }
}

function refreshConfigWarning() {
  $('configWarning').classList.toggle('hidden', Config.isComplete());
}

/* ---------- Auth wiring ---------- */
Auth.onChange((signedIn) => {
  $('userStatus').textContent = signedIn ? 'Connecté' : 'Non connecté';
  $('btnSignIn').classList.toggle('hidden', signedIn);
  $('btnSignOut').classList.toggle('hidden', !signedIn);
});

/* ---------- Dashboard ---------- */
async function loadDashboard() {
  if (!Config.isComplete()) { refreshConfigWarning(); return; }
  showGlobalError('');
  busy($('btnRefresh'), true, 'Chargement…');
  try {
    const res = await SheetsAPI.getValues(Config.get('spreadsheetId'), 'Chiffrage!A2:I');
    const values = res.values || [];
    rows = values.map((data, i) => ({ rowNumber: i + 2, data }));
    renderTable();
  } catch (e) {
    showGlobalError(e.message);
  } finally {
    busy($('btnRefresh'), false);
  }
}

function renderTable() {
  const body = $('chiffrageBody');
  body.innerHTML = '';

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="10" class="empty">Aucun chiffrage. Cliquez sur « Nouveau chiffrage ».</td></tr>';
    return;
  }

  for (const row of rows) {
    const [id, numDevis, client, projet, ticket, date, statut, url, montant] = row.data;
    const tr = document.createElement('tr');

    const cells = [id, numDevis, client, projet, ticket, date].map((v) => cell(v));
    cells.forEach((c) => tr.appendChild(c));

    // Status select
    const tdStatus = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'status-select';
    for (const opt of STATUS_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt; o.textContent = opt || '—';
      if ((statut || '') === opt) o.selected = true;
      select.appendChild(o);
    }
    select.addEventListener('change', () => onStatusChange(row, select.value, select));
    tdStatus.appendChild(select);
    tr.appendChild(tdStatus);

    // File link
    const tdFile = document.createElement('td');
    if (url) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Ouvrir';
      tdFile.appendChild(a);
    } else {
      tdFile.textContent = '—';
    }
    tr.appendChild(tdFile);

    // Amount
    const tdMontant = cell(formatMontant(montant));
    tdMontant.className = 'amount';
    tr.appendChild(tdMontant);

    // Row actions
    const tdActions = document.createElement('td');
    tdActions.className = 'row-actions';
    if (url) {
      const btn = document.createElement('button');
      btn.className = 'btn'; btn.textContent = '💶';
      btn.title = 'Mettre à jour le montant';
      btn.addEventListener('click', () => updateOneMontant(row, btn));
      tdActions.appendChild(btn);
    }
    tr.appendChild(tdActions);

    body.appendChild(tr);
  }
}

function cell(value) {
  const td = document.createElement('td');
  td.textContent = value == null ? '' : String(value);
  return td;
}

function formatMontant(v) {
  const n = typeof v === 'number' ? v : parseFloat(String(v || '').replace(',', '.'));
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 });
}

/* ---------- Status change (onEdit port) ---------- */
async function onStatusChange(row, newValue, select) {
  select.disabled = true;
  try {
    const spreadsheetId = Config.get('spreadsheetId');
    await SheetsAPI.updateValues(spreadsheetId, `Chiffrage!G${row.rowNumber}`, [[newValue]]);
    row.data[6] = newValue;

    const url = row.data[7];
    if ((newValue === 'Envoyé' || newValue === 'Devis validé') && url) {
      const montant = await getMontantFromChiffrage(url);
      if (montant > 0) {
        await SheetsAPI.updateValues(spreadsheetId, `Chiffrage!I${row.rowNumber}`, [[montant]]);
        row.data[8] = montant;
      }
    }

    if (newValue === 'Devis validé') {
      const projet = row.data[3];
      if (projet) {
        await ajouterProjetAuPlanning(projet);
        toast(`Projet « ${projet} » ajouté au planning.`, 'success');
      }
    } else {
      toast('Statut mis à jour.', 'success');
    }
    renderTable();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    select.disabled = false;
  }
}

/* ---------- Montant updates ---------- */
async function updateOneMontant(row, btn) {
  busy(btn, true);
  try {
    const montant = await updateMontantForRow(row.rowNumber, row.data[7]);
    row.data[8] = montant;
    renderTable();
    toast('Montant mis à jour.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

async function updateAllMontants() {
  const btn = $('btnUpdateAll');
  busy(btn, true, 'MAJ…');
  let count = 0;
  try {
    for (const row of rows) {
      const url = row.data[7];
      if (!url) continue;
      const montant = await getMontantFromChiffrage(url);
      await SheetsAPI.updateValues(Config.get('spreadsheetId'), `Chiffrage!I${row.rowNumber}`, [[montant]]);
      row.data[8] = montant;
      count++;
    }
    renderTable();
    toast(`${count} chiffrage(s) mis à jour.`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

/* ---------- New chiffrage ---------- */
async function createChiffrage() {
  const btn = $('btnCreate');
  const errEl = $('newError');
  errEl.classList.add('hidden');

  const numDevis = $('newNumDevis').value.trim();
  const client = $('newClient').value.trim();
  const projet = $('newProjet').value.trim();
  const ticket = $('newTicket').value.trim();
  const dateVal = $('newDate').value;
  const date = dateVal ? new Date(`${dateVal}T00:00:00`) : null;
  const folderRaw = $('newFolderId').value.trim();
  const targetFolderId = extractFolderId(folderRaw) || null;

  if (!client || !projet) {
    errEl.textContent = 'Le Client et le Projet sont obligatoires.';
    errEl.classList.remove('hidden');
    return;
  }

  busy(btn, true, 'Création…');
  try {
    const spreadsheetId = Config.get('spreadsheetId');
    const dateStr = date ? formatDateParts(date).dateStrId : 'Unknown';

    // Append the dashboard row, then resolve its row number.
    const appendRes = await SheetsAPI.appendValues(
      spreadsheetId,
      'Chiffrage!A1',
      [['', numDevis, client, projet, ticket, dateStr, '', '', '']],
    );
    const updatedRange = appendRes.updates.updatedRange; // e.g. Chiffrage!A7:I7
    const rowNumber = parseInt(updatedRange.match(/!\D+(\d+):/)[1], 10);

    await nouveauChiffrage(rowNumber, { numDevis, client, projet, ticket, date, status: '', targetFolderId });

    closeModal('newModal');
    toast('Chiffrage créé.', 'success');
    await loadDashboard();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    busy(btn, false);
  }
}

/* ---------- Chart ---------- */
async function refreshChart() {
  const btn = $('btnChart');
  busy(btn, true, '…');
  try {
    const n = await renderTmaChart($('tmaChart'));
    toast(`${n} devis représenté(s).`, 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

/* ---------- Planning ---------- */
async function addPlanning() {
  const btn = $('btnAddPlanning');
  const name = $('planningProjectName').value.trim();
  busy(btn, true, '…');
  try {
    await ajouterProjetAuPlanning(name);
    $('planningProjectName').value = '';
    toast('Projet ajouté au planning (4 phases).', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

async function colorPlanning() {
  const btn = $('btnColorPlanning');
  busy(btn, true, '…');
  try {
    await colorierGroupesAlternes();
    toast('Groupes colorés.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

/* ---------- Modals / settings ---------- */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function openSettings() {
  const c = Config.load();
  $('cfgClientId').value = c.clientId;
  $('cfgSpreadsheetId').value = c.spreadsheetId;
  $('cfgRootFolderId').value = c.rootFolderId;
  openModal('settingsModal');
}

function saveSettings() {
  Config.save({
    clientId: $('cfgClientId').value.trim(),
    spreadsheetId: extractSpreadsheetId($('cfgSpreadsheetId').value.trim()) || $('cfgSpreadsheetId').value.trim(),
    rootFolderId: $('cfgRootFolderId').value.trim(),
  });
  closeModal('settingsModal');
  refreshConfigWarning();
  toast('Configuration enregistrée.', 'success');
  if (Auth.isSignedIn()) loadDashboard();
}

/* ---------- Wire up ---------- */
function init() {
  $('btnSignIn').addEventListener('click', async () => {
    if (!Config.isComplete()) { openSettings(); return; }
    try {
      await Auth.signIn();
      await loadDashboard();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('btnSignOut').addEventListener('click', () => Auth.signOut());

  $('btnSettings').addEventListener('click', openSettings);
  $('openSettingsLink').addEventListener('click', openSettings);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnCloseSettings').addEventListener('click', () => closeModal('settingsModal'));

  $('btnRefresh').addEventListener('click', loadDashboard);
  $('btnUpdateAll').addEventListener('click', updateAllMontants);

  $('btnNew').addEventListener('click', () => {
    if (!Auth.isSignedIn()) { toast('Connectez-vous d\'abord.', 'error'); return; }
    $('newError').classList.add('hidden');
    ['newNumDevis', 'newClient', 'newProjet', 'newTicket', 'newDate', 'newFolderId'].forEach((id) => { $(id).value = ''; });
    openModal('newModal');
  });
  $('btnCreate').addEventListener('click', createChiffrage);
  $('btnCloseNew').addEventListener('click', () => closeModal('newModal'));

  $('btnChart').addEventListener('click', refreshChart);
  $('btnAddPlanning').addEventListener('click', addPlanning);
  $('btnColorPlanning').addEventListener('click', colorPlanning);

  refreshConfigWarning();
}

init();
