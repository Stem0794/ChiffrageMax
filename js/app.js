import { Config } from './config.js';
import { Auth } from './auth.js';
import {
  nouveauChiffrage, listChiffrages, setChiffrageStatus, deleteChiffrage, STATUS_OPTIONS,
} from './chiffrage.js';
import { extractSpreadsheetId, extractFolderId } from './utils.js';

const $ = (id) => document.getElementById(id);

let chiffrages = []; // full list from Drive scan
let selectedClient = ''; // '' = all clients

/* ---- UI helpers ---- */
function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  el.classList.remove('hidden');
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

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---- Auth gate ---- */
function showApp(signedIn) {
  $('loginPage').classList.toggle('hidden', signedIn);
  $('appPage').classList.toggle('hidden', !signedIn);
  $('btnSignOut').classList.toggle('hidden', !signedIn);
  $('userStatus').textContent = signedIn ? 'Connecté' : 'Non connecté';
}

Auth.onChange((signedIn) => {
  showApp(signedIn);
  if (signedIn) {
    refreshClientSelector();
    loadDashboard();
  }
});

/* ---- Client selector ---- */
function refreshClientSelector() {
  const sel = $('clientSelector');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Tous les clients</option>';
  Config.getClients().forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
    selectedClient = prev;
  } else {
    selectedClient = '';
  }
}

function refreshClientDatalist() {
  const dl = $('clientDatalist');
  if (!dl) return;
  dl.innerHTML = Config.getClients().map((c) => `<option value="${escHtml(c.name)}">`).join('');
}

/* ---- Dashboard ---- */
async function loadDashboard() {
  if (!Auth.isSignedIn()) return;
  showGlobalError('');
  busy($('btnRefresh'), true, 'Chargement…');
  try {
    chiffrages = await listChiffrages();
    renderTable();
  } catch (e) {
    showGlobalError(e.message);
  } finally {
    busy($('btnRefresh'), false);
  }
}

function visibleChiffrages() {
  if (!selectedClient) return chiffrages;
  const key = selectedClient.trim().toLowerCase();
  return chiffrages.filter((c) => (c.client || '').trim().toLowerCase() === key);
}

function renderTable() {
  const body = $('chiffrageBody');
  body.innerHTML = '';
  const visible = visibleChiffrages();

  if (!visible.length) {
    const msg = selectedClient
      ? `Aucun chiffrage trouvé pour « ${escHtml(selectedClient)} ».`
      : 'Aucun chiffrage trouvé. Cliquez sur « Nouveau chiffrage ».';
    body.innerHTML = `<tr><td colspan="10" class="empty">${msg}</td></tr>`;
    return;
  }

  for (const ch of visible) {
    const tr = document.createElement('tr');
    [ch.name, ch.numDevis, ch.client, ch.projet, ch.ticket, ch.date].forEach((v) => tr.appendChild(cell(v)));

    // Status select
    const tdStatus = document.createElement('td');
    const select = document.createElement('select');
    select.className = 'status-select';
    for (const opt of STATUS_OPTIONS) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt || '—';
      if ((ch.status || '') === opt) o.selected = true;
      select.appendChild(o);
    }
    applyStatusStyle(select, ch.status || '');
    select.addEventListener('change', () => {
      applyStatusStyle(select, select.value);
      onStatusChange(ch, select.value, select);
    });
    tdStatus.appendChild(select);
    tr.appendChild(tdStatus);

    // File link
    const tdFile = document.createElement('td');
    if (ch.url) {
      const a = document.createElement('a');
      a.href = ch.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Ouvrir';
      tdFile.appendChild(a);
    } else {
      tdFile.textContent = '—';
    }
    tr.appendChild(tdFile);

    // Amount
    const tdMontant = cell(formatMontant(ch.montant));
    tdMontant.className = 'amount';
    tr.appendChild(tdMontant);

    // Delete action
    const tdDel = document.createElement('td');
    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-sm btn-delete';
    btnDel.textContent = '🗑';
    btnDel.title = 'Supprimer ce chiffrage (Google Sheet)';
    btnDel.addEventListener('click', () => onDeleteChiffrage(ch, btnDel));
    tdDel.appendChild(btnDel);
    tr.appendChild(tdDel);

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
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';
}

const STATUS_STYLES = {
  '':             { bg: '#1c2030', color: '#7a8698' },
  'Envoyé':       { bg: '#78350f', color: '#fde68a' },
  'Validé':       { bg: '#064e3b', color: '#6ee7b7' },
  'Passé en TMA': { bg: '#1e3a8a', color: '#93c5fd' },
  'Refusé':       { bg: '#7f1d1d', color: '#fca5a5' },
  'Annulé':       { bg: '#1f2937', color: '#9ca3af' },
};

function applyStatusStyle(select, value) {
  const s = STATUS_STYLES[value] || STATUS_STYLES[''];
  select.style.background = s.bg;
  select.style.color = s.color;
  select.style.borderColor = s.bg;
}

/* ---- Status change ---- */
async function onStatusChange(ch, newValue, select) {
  const prev = ch.status;
  select.disabled = true;
  try {
    await setChiffrageStatus(ch.id, ch.sheetName, ch.statusRow, newValue);
    ch.status = newValue;
    toast('Statut mis à jour.', 'success');
  } catch (e) {
    toast(e.message, 'error');
    select.value = prev || '';
    applyStatusStyle(select, prev || '');
  } finally {
    select.disabled = false;
  }
}

/* ---- Delete chiffrage ---- */
async function onDeleteChiffrage(ch, btn) {
  const label = ch.projet ? `« ${ch.projet} »` : ch.name;
  if (!window.confirm(`Supprimer définitivement le chiffrage ${label} ?\n\nCette action supprime le Google Sheet — elle est irréversible.`)) return;
  busy(btn, true);
  try {
    await deleteChiffrage(ch.id);
    chiffrages = chiffrages.filter((c) => c.id !== ch.id);
    renderTable();
    toast('Chiffrage supprimé.', 'success');
  } catch (e) {
    toast(e.message, 'error');
    busy(btn, false);
  }
}

/* ---- Phase builder ---- */
let phasesData = [{ items: 1 }];

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
      phasesData.splice(Number(e.currentTarget.dataset.idx), 1);
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

/* ---- New chiffrage ---- */
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
  const targetFolderId = Config.getClientFolder(client) || null;

  if (!client || !projet) {
    errEl.textContent = 'Le Client et le Projet sont obligatoires.';
    errEl.classList.remove('hidden');
    return;
  }
  if (!Config.get('templateId')) {
    errEl.textContent = 'Configurez l\'ID du modèle dans les paramètres (⚙️).';
    errEl.classList.remove('hidden');
    return;
  }
  if (!targetFolderId && !Config.get('rootFolderId')) {
    errEl.textContent = `Aucun dossier Drive configuré pour « ${client} » et le dossier racine est absent. Configurez un dossier pour ce client dans ⚙️ Configuration.`;
    errEl.classList.remove('hidden');
    return;
  }

  busy(btn, true, 'Création…');
  try {
    await nouveauChiffrage({ numDevis, client, projet, ticket, date, targetFolderId, phases: getPhases() });
    closeModal('newModal');
    toast('Chiffrage créé avec succès.', 'success');
    await loadDashboard();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.classList.remove('hidden');
  } finally {
    busy(btn, false);
  }
}

/* ---- Modals ---- */
function openModal(id) { $(id).classList.remove('hidden'); }
function closeModal(id) { $(id).classList.add('hidden'); }

/* ---- Settings ---- */
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
      refreshClientSelector();
    });
  });
  container.querySelectorAll('[data-tjm]').forEach((btn) => {
    btn.addEventListener('click', () => openTjmModal(btn.dataset.tjm));
  });
}

function openSettings() {
  const c = Config.load();
  $('cfgClientId').value = c.clientId;
  $('cfgTemplateId').value = c.templateId;
  $('cfgRootFolderId').value = c.rootFolderId;
  $('addClientName').value = '';
  $('addClientFolder').value = '';
  renderClientList();
  openModal('settingsModal');
}

function saveSettings() {
  const rawTemplate = $('cfgTemplateId').value.trim();
  const rawRoot = $('cfgRootFolderId').value.trim();
  Config.save({
    clientId: $('cfgClientId').value.trim(),
    templateId: extractSpreadsheetId(rawTemplate) || rawTemplate,
    rootFolderId: extractFolderId(rawRoot) || rawRoot,
  });
  closeModal('settingsModal');
  refreshClientDatalist();
  refreshClientSelector();
  toast('Configuration enregistrée.', 'success');
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
  refreshClientSelector();
  toast(`Client « ${name} » enregistré — scan des chiffrages en cours…`, 'success');
  if (Auth.isSignedIn()) loadDashboard();
}

/* ---- TJM modal ---- */
const TJM_ROLE_NAMES = [
  'Production Director', 'Project Director', 'Senior Project Manager',
  'Project Manager', 'Data Analyst', 'Designer UX', 'Designer UI',
  'CTO', 'Tech lead', 'SRE', 'Full Stack Developer',
];
const TJM_DEFAULTS = [920, 920, 880, 720, 880, 720, 720, 1400, 1050, 1050, 880];
const TJM_COL_COUNT = TJM_ROLE_NAMES.length;

let tjmClientTarget = null;

function openTjmModal(clientName) {
  tjmClientTarget = clientName;
  $('tjmClientLabel').textContent = clientName;
  const saved = Config.getClientTjm(clientName);
  renderTjmRows(saved || [...TJM_DEFAULTS]);
  openModal('tjmModal');
}

function renderTjmRows(values) {
  const container = $('tjmRows');
  container.innerHTML = '';
  for (let i = 0; i < TJM_COL_COUNT; i++) {
    const row = document.createElement('div');
    row.className = 'tjm-row';
    row.innerHTML = `
      <span class="tjm-role">${escHtml(TJM_ROLE_NAMES[i])}</span>
      <input type="number" min="0" step="10" value="${values[i] ?? TJM_DEFAULTS[i]}" placeholder="${TJM_DEFAULTS[i]}" data-idx="${i}" />
      <span class="tjm-unit">€/j</span>
    `;
    container.appendChild(row);
  }
}

function resetTjmToDefaults() {
  renderTjmRows([...TJM_DEFAULTS]);
}

function saveTjm() {
  const inputs = $('tjmRows').querySelectorAll('input[type=number]');
  const values = Array.from(inputs).map((inp) => {
    const n = parseFloat(inp.value);
    return Number.isFinite(n) ? n : null;
  });
  Config.setClientTjm(tjmClientTarget, values);
  closeModal('tjmModal');
  renderClientList();
  toast(`TJM enregistrés pour « ${tjmClientTarget} ».`, 'success');
}

/* ---- Wire up ---- */
function init() {
  // Auth
  $('btnSignIn').addEventListener('click', async () => {
    if (!Config.get('clientId')) {
      openSettings();
      toast('Configurez votre OAuth Client ID d\'abord.', 'error');
      return;
    }
    try {
      await Auth.signIn();
    } catch (e) {
      toast(e.message, 'error');
    }
  });
  $('btnSignOut').addEventListener('click', () => Auth.signOut());
  $('openSettingsFromLogin').addEventListener('click', openSettings);

  // Settings
  $('btnSettings').addEventListener('click', openSettings);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnCloseSettings').addEventListener('click', () => closeModal('settingsModal'));
  $('btnAddClient').addEventListener('click', addClient);

  // Client selector
  $('clientSelector').addEventListener('change', (e) => {
    selectedClient = e.target.value;
    renderTable();
  });

  // Dashboard
  $('btnRefresh').addEventListener('click', loadDashboard);

  // New chiffrage
  $('btnNew').addEventListener('click', () => {
    $('newError').classList.add('hidden');
    $('newNumDevis').value = '';
    $('newClient').value = selectedClient;
    $('newProjet').value = '';
    $('newTicket').value = '';
    $('newDate').value = new Date().toISOString().split('T')[0];
    phasesData = [{ items: 1 }];
    renderPhaseRows();
    openModal('newModal');
  });
  $('btnAddPhase').addEventListener('click', addPhase);
  $('btnCreate').addEventListener('click', createChiffrage);
  $('btnCloseNew').addEventListener('click', () => closeModal('newModal'));

  // TJM
  $('btnResetTjm').addEventListener('click', resetTjmToDefaults);
  $('btnSaveTjm').addEventListener('click', saveTjm);
  $('btnCloseTjm').addEventListener('click', () => closeModal('tjmModal'));

  // Init state
  refreshClientDatalist();
  showApp(Auth.isSignedIn());
  if (Auth.isSignedIn()) {
    refreshClientSelector();
    loadDashboard();
  }
}

init();
