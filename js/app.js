import { Config } from './config.js';
import { Auth } from './auth.js';
import { SheetsAPI, DriveAPI } from './api.js';
import {
  nouveauChiffrage, listChiffrages, setChiffrageStatus, deleteChiffrage, STATUS_OPTIONS,
} from './chiffrage.js';
import { extractSpreadsheetId, extractFolderId } from './utils.js';

const $ = (id) => document.getElementById(id);

let chiffrages = [];
let selectedClient = '';
let filterStatuses = new Set();

/* ---- Roles ---- */
const DEFAULT_ROLES = [
  { name: 'Production Director',    rate: 920  },
  { name: 'Project Director',       rate: 920  },
  { name: 'Senior Project Manager', rate: 880  },
  { name: 'Project Manager',        rate: 720  },
  { name: 'Data Analyst',           rate: 880  },
  { name: 'Designer UX',            rate: 720  },
  { name: 'Designer UI',            rate: 720  },
  { name: 'CTO',                    rate: 1400 },
  { name: 'Tech lead',              rate: 1050 },
  { name: 'SRE',                    rate: 1050 },
  { name: 'Full Stack Developer',   rate: 880  },
];

function getRolesForClient(clientName) {
  const saved = clientName ? Config.getClientRoles(clientName) : null;
  return DEFAULT_ROLES.map((def, i) => {
    const s = saved?.[i];
    return {
      name:    s?.name    !== undefined ? s.name    : def.name,
      rate:    s?.rate    !== undefined ? s.rate    : def.rate,
      enabled: s?.enabled !== undefined ? s.enabled : true,
    };
  });
}

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
  if (signedIn) { refreshClientSelector(); loadDashboard(); }
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
    renderFilters();
    renderTable();
  } catch (e) {
    showGlobalError(e.message);
  } finally {
    busy($('btnRefresh'), false);
  }
}

/* ---- Filters / sort ---- */
function parseDate(str) {
  if (!str) return 0;
  const m = str.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime();
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function visibleChiffrages() {
  let list = chiffrages;

  if (selectedClient) {
    const key = selectedClient.trim().toLowerCase();
    list = list.filter((c) => (c.client || '').trim().toLowerCase() === key);
  }

  if (filterStatuses.size > 0) {
    list = list.filter((c) => filterStatuses.has(c.status || ''));
  }

  const sortVal = $('sortSelect')?.value || 'name-desc';
  const dashIdx = sortVal.lastIndexOf('-');
  const field = sortVal.slice(0, dashIdx);
  const asc   = sortVal.slice(dashIdx + 1) === 'asc';

  return [...list].sort((a, b) => {
    let va, vb;
    if (field === 'montant') {
      va = typeof a.montant === 'number' ? a.montant : parseFloat(String(a.montant || '').replace(',', '.')) || 0;
      vb = typeof b.montant === 'number' ? b.montant : parseFloat(String(b.montant || '').replace(',', '.')) || 0;
    } else if (field === 'date') {
      va = parseDate(a.date);
      vb = parseDate(b.date);
    } else {
      va = (a.name || '').toLowerCase();
      vb = (b.name || '').toLowerCase();
    }
    if (va < vb) return asc ? -1 : 1;
    if (va > vb) return asc ? 1 : -1;
    return 0;
  });
}

function renderFilters() {
  const pillsEl = $('statusPills');
  pillsEl.innerHTML = '';

  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = `status-pill${filterStatuses.size === 0 ? ' active' : ''}`;
  allPill.textContent = 'Tous';
  allPill.addEventListener('click', () => { filterStatuses.clear(); renderFilters(); renderTable(); });
  pillsEl.appendChild(allPill);

  STATUS_OPTIONS.filter((s) => s).forEach((s) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    const st = STATUS_STYLES[s];
    const active = filterStatuses.has(s);
    pill.className = `status-pill${active ? ' active' : ''}`;
    if (active && st) {
      pill.style.background = st.bg;
      pill.style.color = st.color;
      pill.style.borderColor = st.bg;
    }
    pill.textContent = s;
    pill.addEventListener('click', () => {
      if (filterStatuses.has(s)) filterStatuses.delete(s);
      else filterStatuses.add(s);
      renderFilters();
      renderTable();
    });
    pillsEl.appendChild(pill);
  });
}

/* ---- Table rendering ---- */
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

    // Filename — not directly editable (would need Drive rename)
    tr.appendChild(cell(ch.name));

    // Editable fields
    const tdDevis = cell(ch.numDevis);
    makeEditableCell(tdDevis, ch, 'numDevis');
    tr.appendChild(tdDevis);

    const tdClient = cell(ch.client);
    makeEditableCell(tdClient, ch, 'client');
    tr.appendChild(tdClient);

    const tdProjet = cell(ch.projet);
    makeEditableCell(tdProjet, ch, 'projet');
    tr.appendChild(tdProjet);

    const tdTicket = cell(ch.ticket);
    makeEditableCell(tdTicket, ch, 'ticket');
    tr.appendChild(tdTicket);

    const tdDate = cell(ch.date);
    makeEditableCell(tdDate, ch, 'date');
    tr.appendChild(tdDate);

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
      a.href = ch.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Ouvrir';
      tdFile.appendChild(a);
    } else {
      tdFile.textContent = '—';
    }
    tr.appendChild(tdFile);

    // Amount
    const tdMontant = cell(formatMontant(ch.montant));
    tdMontant.className = 'amount';
    tr.appendChild(tdMontant);

    // Delete
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

/* ---- Inline cell editing ---- */
const FIELD_CELL = { numDevis: 'C5', client: 'C1', projet: 'C2', ticket: 'C3', date: 'C4' };

async function saveField(ch, field, value) {
  const cellAddr = FIELD_CELL[field];
  if (!cellAddr) throw new Error(`Champ inconnu : ${field}`);
  await SheetsAPI.updateValues(ch.id, `${ch.sheetName}!${cellAddr}`, [[value]]);
  if (field === 'client') {
    const newFolderId = Config.getClientFolder(value);
    if (newFolderId) {
      await DriveAPI.moveFile(ch.id, newFolderId);
    }
  }
}

function makeEditableCell(td, ch, field) {
  td.classList.add('editable-cell');
  td.addEventListener('click', () => {
    if (td.classList.contains('editing')) return;
    const prev = String(ch[field] ?? '');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = prev;
    input.className = 'inline-edit-input';
    td.textContent = '';
    td.classList.add('editing');
    td.appendChild(input);
    input.focus();
    input.select();

    let done = false;

    const cancel = () => {
      if (done) return;
      done = true;
      td.classList.remove('editing');
      td.textContent = prev;
    };

    const confirm = async () => {
      if (done) return;
      done = true;
      const newVal = input.value.trim();
      td.classList.remove('editing');
      if (newVal === prev) { td.textContent = prev; return; }
      td.textContent = '…';
      try {
        await saveField(ch, field, newVal);
        ch[field] = newVal;
        td.textContent = newVal;
        toast('Modifié.', 'success');
        if (field === 'client') renderTable();
      } catch (e) {
        td.textContent = prev;
        toast(e.message, 'error');
      }
    };

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') cancel();
    });
    input.addEventListener('blur', confirm);
  });
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

/* ---- Role picker (new chiffrage modal) ---- */
function renderRoleCheckboxes(clientName) {
  const container = $('roleCheckboxes');
  const roles = getRolesForClient(clientName);
  container.innerHTML = '';
  roles.forEach((r, i) => {
    const item = document.createElement('label');
    item.className = 'role-check-row';
    item.innerHTML = `
      <input type="checkbox" ${r.enabled ? 'checked' : ''} data-role-idx="${i}" />
      <span class="role-check-name">${escHtml(r.name)}</span>
      <span class="role-check-rate">${r.rate} €/j</span>
    `;
    container.appendChild(item);
  });
}

function getSelectedRoles(clientName) {
  const base = getRolesForClient(clientName);
  const checks = $('roleCheckboxes').querySelectorAll('input[type=checkbox]');
  return base.map((r, i) => ({
    ...r,
    enabled: checks[i] ? checks[i].checked : r.enabled,
  }));
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
    errEl.textContent = `Aucun dossier Drive configuré pour « ${client} ». Ajoutez ce client dans ⚙️ Configuration.`;
    errEl.classList.remove('hidden');
    return;
  }

  const roles = getSelectedRoles(client);
  if (!roles.some((r) => r.enabled)) {
    errEl.textContent = 'Activez au moins un rôle.';
    errEl.classList.remove('hidden');
    return;
  }

  busy(btn, true, 'Création…');
  try {
    await nouveauChiffrage({ numDevis, client, projet, ticket, date, targetFolderId, phases: getPhases(), roles });
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
  container.innerHTML = '';
  clients.forEach((c) => {
    const row = document.createElement('div');
    row.className = 'client-row';
    renderClientRow(row, c, false);
    container.appendChild(row);
  });
}

function renderClientRow(row, c, editing) {
  const roles = Config.getClientRoles(c.name);
  const activeCount = roles ? roles.filter((r) => r.enabled !== false).length : DEFAULT_ROLES.length;
  const hasCustom = Boolean(roles);

  if (editing) {
    row.innerHTML = `
      <input class="input-sm client-edit-name" type="text" value="${escHtml(c.name)}" placeholder="Nom du client" style="min-width:100px;flex:0 0 auto" />
      <input class="input-sm input-sm--grow client-edit-folder" type="text" value="${escHtml(c.folderId)}" placeholder="URL ou ID du dossier Drive" />
      <button class="btn btn-sm btn-primary" data-save>✓</button>
      <button class="btn btn-sm btn-ghost" data-cancel>✕</button>
    `;
    row.querySelector('[data-save]').addEventListener('click', () => {
      const newName = row.querySelector('.client-edit-name').value.trim();
      const newFolderRaw = row.querySelector('.client-edit-folder').value.trim();
      if (!newName || !newFolderRaw) { toast('Nom et dossier requis.', 'error'); return; }
      const newFolder = extractFolderId(newFolderRaw) || newFolderRaw;
      Config.updateClient(c.name, newName, newFolder);
      refreshClientDatalist();
      refreshClientSelector();
      renderClientList();
      toast(`Client « ${newName} » mis à jour.`, 'success');
      if (Auth.isSignedIn()) loadDashboard();
    });
    row.querySelector('[data-cancel]').addEventListener('click', () => renderClientRow(row, c, false));
  } else {
    const badge = hasCustom
      ? `<span class="client-tjm-badge">${activeCount}/${DEFAULT_ROLES.length} rôles</span>`
      : '';
    row.innerHTML = `
      <span class="client-name">${escHtml(c.name)}</span>
      <span class="client-folder" title="${escHtml(c.folderId)}">${escHtml(c.folderId)}</span>
      ${badge}
      <button class="btn btn-sm" data-edit title="Modifier">✏️</button>
      <button class="btn btn-sm" data-roles title="Configurer les rôles et TJM">💰</button>
      <button class="btn btn-sm" data-delete title="Supprimer">✕</button>
    `;
    row.querySelector('[data-edit]').addEventListener('click', () => renderClientRow(row, c, true));
    row.querySelector('[data-roles]').addEventListener('click', () => openRolesModal(c.name));
    row.querySelector('[data-delete]').addEventListener('click', () => {
      Config.deleteClient(c.name);
      renderClientList();
      refreshClientDatalist();
      refreshClientSelector();
    });
  }
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

/* ---- Roles modal (per-client) ---- */
let rolesClientTarget = null;

function openRolesModal(clientName) {
  rolesClientTarget = clientName;
  $('rolesClientLabel').textContent = clientName;
  renderRoleModalRows(getRolesForClient(clientName));
  openModal('rolesModal');
}

function renderRoleModalRows(roles) {
  const container = $('roleModalRows');
  container.innerHTML = '';
  roles.forEach((r, i) => {
    const row = document.createElement('div');
    row.className = `role-modal-row${r.enabled ? '' : ' role-disabled'}`;
    row.dataset.idx = i;
    row.innerHTML = `
      <input type="checkbox" class="rm-enabled" ${r.enabled ? 'checked' : ''} title="Activer / désactiver ce rôle" />
      <input type="text"   class="input-sm rm-name"    value="${escHtml(r.name)}"  placeholder="Nom du rôle" />
      <input type="number" class="input-sm rm-rate"    value="${r.rate}"           placeholder="${DEFAULT_ROLES[i]?.rate ?? ''}" min="0" step="10" />
      <span class="tjm-unit">€/j</span>
      <button type="button" class="btn btn-sm btn-ghost rm-reset" title="Réinitialiser aux valeurs par défaut">↩</button>
    `;
    const cbx = row.querySelector('.rm-enabled');
    cbx.addEventListener('change', () => row.classList.toggle('role-disabled', !cbx.checked));
    row.querySelector('.rm-reset').addEventListener('click', () => {
      const def = DEFAULT_ROLES[i];
      if (def) {
        row.querySelector('.rm-name').value = def.name;
        row.querySelector('.rm-rate').value = def.rate;
        cbx.checked = true;
        row.classList.remove('role-disabled');
      }
    });
    container.appendChild(row);
  });
}

function saveRoles() {
  const rows = $('roleModalRows').querySelectorAll('.role-modal-row');
  const roles = Array.from(rows).map((row, i) => ({
    name:    row.querySelector('.rm-name').value.trim() || DEFAULT_ROLES[i]?.name || '',
    rate:    parseFloat(row.querySelector('.rm-rate').value) || 0,
    enabled: row.querySelector('.rm-enabled').checked,
  }));
  Config.setClientRoles(rolesClientTarget, roles);
  closeModal('rolesModal');
  renderClientList();
  toast(`Rôles enregistrés pour « ${rolesClientTarget} ».`, 'success');
}

function resetAllRoles() {
  renderRoleModalRows(DEFAULT_ROLES.map((r) => ({ ...r, enabled: true })));
}

/* ---- Wire up ---- */
function init() {
  $('btnSignIn').addEventListener('click', async () => {
    if (!Config.get('clientId')) {
      openSettings();
      toast('Configurez votre OAuth Client ID d\'abord.', 'error');
      return;
    }
    try { await Auth.signIn(); } catch (e) { toast(e.message, 'error'); }
  });
  $('btnSignOut').addEventListener('click', () => Auth.signOut());
  $('openSettingsFromLogin').addEventListener('click', openSettings);

  $('btnSettings').addEventListener('click', openSettings);
  $('btnSaveSettings').addEventListener('click', saveSettings);
  $('btnCloseSettings').addEventListener('click', () => closeModal('settingsModal'));
  $('btnAddClient').addEventListener('click', addClient);

  $('clientSelector').addEventListener('change', (e) => {
    selectedClient = e.target.value;
    renderTable();
  });

  $('sortSelect').addEventListener('change', () => renderTable());

  $('btnRefresh').addEventListener('click', loadDashboard);

  $('btnNew').addEventListener('click', () => {
    $('newError').classList.add('hidden');
    $('newNumDevis').value = '';
    $('newClient').value = selectedClient;
    $('newProjet').value = '';
    $('newTicket').value = '';
    $('newDate').value = new Date().toISOString().split('T')[0];
    phasesData = [{ items: 1 }];
    renderPhaseRows();
    renderRoleCheckboxes(selectedClient);
    openModal('newModal');
  });
  $('btnAddPhase').addEventListener('click', addPhase);
  $('newClient').addEventListener('change', (e) => renderRoleCheckboxes(e.target.value.trim()));
  $('newClient').addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (Config.getClients().some((c) => c.name.toLowerCase() === val.toLowerCase())) {
      renderRoleCheckboxes(val);
    }
  });
  $('btnCreate').addEventListener('click', createChiffrage);
  $('btnCloseNew').addEventListener('click', () => closeModal('newModal'));

  $('btnSaveRoles').addEventListener('click', saveRoles);
  $('btnResetRoles').addEventListener('click', resetAllRoles);
  $('btnCloseRoles').addEventListener('click', () => closeModal('rolesModal'));

  refreshClientDatalist();
  renderFilters();
  showApp(Auth.isSignedIn());
  if (Auth.isSignedIn()) { refreshClientSelector(); loadDashboard(); }
}

init();
