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
  // Priority: explicit folder field → client-level folder config → fall back to root/year/month
  const targetFolderId = extractFolderId(folderRaw) || Config.getClientFolder(client) || null;

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

    await nouveauChiffrage(rowNumber, { numDevis, client, projet, ticket, date, status: '', targetFolderId, phases: getPhases() });

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

/* ---------- Phase builder ---------- */
let phasesData = [{ items: 1 }]; // [{items: number}], index+1 = phase number

function renderPhaseRows() {
  const container = $('phaseRows');
  container.innerHTML = '';
  phasesData.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'phase-row';
    row.innerHTML = `
      <span class="phase-row-label">Phase ${i + 1}</span>
      <input type="number" min="1" max="50" value="${p.items}" data-idx="${i}" />
      <span class="phase-row-unit">ligne(s)</span>
      <button type="button" class="btn btn-del" data-idx="${i}" ${phasesData.length === 1 ? 'disabled' : ''}>✕</button>
    `;
    row.querySelector('input').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      phasesData[i].items = Number.isFinite(v) && v > 0 ? v : 1;
    });
    row.querySelector('.btn-del').addEventListener('click', (e) => {
      const idx = Number(e.currentTarget.dataset.idx);
      phasesData.splice(idx, 1);
      renderPhaseRows();
    });
    container.appendChild(row);
  });
}

function addPhase() {
  phasesData.push({ items: 1 });
  renderPhaseRows();
}

function getPhases() {
  return phasesData.map((p, i) => ({ phase: i + 1, items: Math.max(1, p.items) }));
}

async function initPhasesFromConfig() {
  try {
    const { readPhasesConfig } = await import('./chiffrage.js');
    const cfgPhases = await readPhasesConfig();
    if (cfgPhases.length) {
      phasesData = cfgPhases.map((p) => ({ items: p.items }));
      renderPhaseRows();
    }
  } catch {
    // Leave default if ConfigPhases is unreadable.
  }
}

/* ---------- Modals / settings ---------- */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

function renderClientList() {
  const container = $('clientList');
  const clients = Config.getClients();
  if (!clients.length) {
    container.innerHTML = '<p class="hint" style="margin:0 0 8px">Aucun client configuré.</p>';
    return;
  }
  container.innerHTML = clients.map((c) => {
    const tjm = Config.getClientTjm(c.name);
    const tjmCount = tjm ? tjm.filter((r) => r !== null && r !== undefined && r !== '').length : 0;
    const badge = tjmCount ? `<span class="client-tjm-badge">${tjmCount} TJM</span>` : '';
    return `
      <div class="client-row">
        <span class="client-name">${escHtml(c.name)}</span>
        <span class="client-folder" title="${escHtml(c.folderId)}">${escHtml(c.folderId)}</span>
        ${badge}
        <button class="btn btn-sm" data-tjm="${escHtml(c.name)}">💰</button>
        <button class="btn btn-sm" data-delete="${escHtml(c.name)}">✕</button>
      </div>
    `;
  }).join('');
  container.querySelectorAll('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Config.deleteClient(btn.dataset.delete);
      renderClientList();
      refreshClientDatalist();
    });
  });
  container.querySelectorAll('[data-tjm]').forEach((btn) => {
    btn.addEventListener('click', () => openTjmModal(btn.dataset.tjm));
  });
}

function refreshClientDatalist() {
  const dl = $('clientDatalist');
  if (!dl) return;
  dl.innerHTML = Config.getClients()
    .map((c) => `<option value="${escHtml(c.name)}">`)
    .join('');
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function openSettings() {
  const c = Config.load();
  $('cfgClientId').value = c.clientId;
  $('cfgSpreadsheetId').value = c.spreadsheetId;
  $('cfgRootFolderId').value = c.rootFolderId;
  $('addClientName').value = '';
  $('addClientFolder').value = '';
  renderClientList();
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
  refreshClientDatalist();
  toast('Configuration enregistrée.', 'success');
  if (Auth.isSignedIn()) loadDashboard();
}

function addClient() {
  const name = $('addClientName').value.trim();
  const folderRaw = $('addClientFolder').value.trim();
  if (!name || !folderRaw) { toast('Renseignez le nom et le dossier.', 'error'); return; }
  const folderId = extractFolderId(folderRaw) || folderRaw;
  Config.upsertClient(name, folderId);
  $('addClientName').value = '';
  $('addClientFolder').value = '';
  renderClientList();
  refreshClientDatalist();
  toast(`Client « ${name} » enregistré.`, 'success');
}

/* ---------- Auto-fill folder from client ---------- */
let folderAutoFilled = false;

function onClientInput() {
  const clientName = $('newClient').value.trim();
  const folderInput = $('newFolderId');
  const hint = $('folderHint');
  const configured = Config.getClientFolder(clientName);

  if (configured) {
    folderInput.value = configured;
    folderAutoFilled = true;
    hint.textContent = `Dossier configuré pour « ${clientName} ». Modifiable.`;
  } else if (folderAutoFilled) {
    folderInput.value = '';
    folderAutoFilled = false;
    hint.textContent = 'Laissez vide pour utiliser le dossier racine global.';
  }
}

/* ---------- TJM modal ---------- */
// Fallback role names matching the model's B6:L6 header row (cols 2–12).
const FALLBACK_ROLE_NAMES = [
  'Production Director', 'Project Director', 'Senior Project Manager',
  'Project Manager', 'Data Analyst', 'Designer UX', 'Designer UI',
  'CTO', 'Tech lead', 'SRE', 'Full Stack Developer',
];
const TJM_COL_COUNT = 11; // B through L

let tjmClientTarget = null;
let tjmRoleNames = [...FALLBACK_ROLE_NAMES];

async function openTjmModal(clientName) {
  tjmClientTarget = clientName;
  $('tjmClientLabel').textContent = clientName;
  // Show existing saved values immediately (or blanks).
  const existing = Config.getClientTjm(clientName) || new Array(TJM_COL_COUNT).fill('');
  renderTjmRows(existing, tjmRoleNames);
  openModal('tjmModal');
  // Then try to load real role names from the model sheet header row (B6:L6).
  await refreshTjmRoleNames();
}

async function refreshTjmRoleNames() {
  if (!Auth.isSignedIn() || !Config.get('spreadsheetId')) return;
  try {
    const res = await SheetsAPI.getValues(Config.get('spreadsheetId'), 'ModeleChiffrage!B6:L6');
    const names = res.values?.[0] || [];
    if (names.filter(Boolean).length > 0) {
      tjmRoleNames = names;
      // Re-render labels in place without resetting values.
      const inputs = $('tjmRows').querySelectorAll('input[type=number]');
      const labels = $('tjmRows').querySelectorAll('.tjm-role');
      names.forEach((name, i) => {
        if (labels[i] && name) labels[i].textContent = name;
      });
    }
  } catch { /* keep fallback names */ }
}

function renderTjmRows(values, names) {
  const container = $('tjmRows');
  container.innerHTML = '';
  for (let i = 0; i < TJM_COL_COUNT; i++) {
    const row = document.createElement('div');
    row.className = 'tjm-row';
    row.innerHTML = `
      <span class="tjm-role">${escHtml(names[i] || `Rôle ${i + 1}`)}</span>
      <input type="number" min="0" step="10" value="${values[i] ?? ''}" placeholder="Modèle" data-idx="${i}" />
      <span class="tjm-unit">€/j</span>
    `;
    container.appendChild(row);
  }
}

async function loadTjmFromModel() {
  const btn = $('btnLoadTjmModel');
  busy(btn, true, '…');
  try {
    const res = await SheetsAPI.getValues(Config.get('spreadsheetId'), 'ModeleChiffrage!B7:L7');
    const values = (res.values?.[0] || []).map((v) => {
      const n = parseFloat(String(v).replace(',', '.'));
      return Number.isFinite(n) ? n : '';
    });
    renderTjmRows(values, tjmRoleNames);
    toast('Tarifs chargés depuis le modèle.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy(btn, false);
  }
}

function saveTjm() {
  const inputs = $('tjmRows').querySelectorAll('input[type=number]');
  const values = Array.from(inputs).map((inp) => {
    const n = parseFloat(inp.value);
    return Number.isFinite(n) ? n : null;
  });
  Config.setClientTjm(tjmClientTarget, values);
  closeModal('tjmModal');
  renderClientList(); // refresh badge count
  toast(`TJM enregistrés pour « ${tjmClientTarget} ».`, 'success');
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
  $('btnAddClient').addEventListener('click', addClient);
  $('btnLoadTjmModel').addEventListener('click', loadTjmFromModel);
  $('btnSaveTjm').addEventListener('click', saveTjm);
  $('btnCloseTjm').addEventListener('click', () => closeModal('tjmModal'));

  $('btnRefresh').addEventListener('click', loadDashboard);
  $('btnUpdateAll').addEventListener('click', updateAllMontants);

  $('btnNew').addEventListener('click', async () => {
    if (!Auth.isSignedIn()) { toast('Connectez-vous d\'abord.', 'error'); return; }
    $('newError').classList.add('hidden');
    $('folderHint').textContent = 'Laissez vide pour utiliser le dossier racine global.';
    folderAutoFilled = false;
    ['newNumDevis', 'newClient', 'newProjet', 'newTicket', 'newDate', 'newFolderId'].forEach((id) => { $(id).value = ''; });
    // Reset to 1 phase / 1 item, then try to pre-fill from ConfigPhases.
    phasesData = [{ items: 1 }];
    renderPhaseRows();
    openModal('newModal');
    await initPhasesFromConfig();
  });
  $('btnAddPhase').addEventListener('click', addPhase);
  $('newClient').addEventListener('input', onClientInput);
  $('newClient').addEventListener('change', onClientInput);
  $('newFolderId').addEventListener('input', () => { folderAutoFilled = false; });

  $('btnCreate').addEventListener('click', createChiffrage);
  $('btnCloseNew').addEventListener('click', () => closeModal('newModal'));

  $('btnChart').addEventListener('click', refreshChart);
  $('btnAddPlanning').addEventListener('click', addPlanning);
  $('btnColorPlanning').addEventListener('click', colorPlanning);

  refreshConfigWarning();
  refreshClientDatalist();
}

init();
