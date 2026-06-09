import { Config } from './config.js';
import { Auth } from './auth.js';
import { DriveConfig } from './drive-config.js';
import { Picker } from './picker.js';
import { SheetsAPI, DriveAPI } from './api.js';
import {
  nouveauChiffrage, listChiffrages, listArchivedChiffrages, readChiffrageFile, readChiffrageMontant,
  setChiffrageStatus, deleteChiffrage, resolveMonthFolder, STATUS_OPTIONS,
} from './chiffrage.js';
import { extractSpreadsheetId, extractFolderId, cleanProjectName } from './utils.js';

const $ = (id) => document.getElementById(id);

let chiffrages = [];
let selectedClient = '';
let filterStatuses = new Set();
let sortField = 'date';
let sortAsc = false;
let dashboardLoading = false;

// Archived view — loaded lazily (only when the "Archivés" filter is opened) so
// the initial dashboard scan never touches [ARCH] files.
let showArchived = false;
let archivedChiffrages = [];
let archivedLoaded = false;
let archivedLoading = false;

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
    // Only capture the original label on the first busy(true) call so that
    // repeated busy(true, newLabel) updates don't overwrite it with spinner HTML.
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    button.innerHTML = '<span class="spinner"></span>';
    if (label) button.appendChild(document.createTextNode(` ${label}`));
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.label || button.innerHTML;
    button.dataset.label = '';
    button.disabled = false;
  }
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ---- Drive config sync ---- */
async function syncFromDrive() {
  $('userStatus').textContent = 'Synchronisation…';
  try {
    // Wire the shared config file ID (if configured) before any Drive call.
    DriveConfig.setSharedConfigId(Config.get('sharedConfigId') || null);
    const remote = await DriveConfig.load();
    if (remote) {
      Config.fromDriveData(remote);
    } else if (!Config.get('sharedConfigId')) {
      // No Drive file yet and no shared config — push local state (first-run).
      await DriveConfig.save(Config.toDriveData());
    }
  } catch (e) {
    console.warn('Sync Drive échoué :', e.message);
    // Non-fatal: fall through and use whatever is in localStorage
  } finally {
    $('userStatus').textContent = 'Connecté';
  }
}

async function saveConfigToDrive() {
  try {
    await DriveConfig.save(Config.toDriveData());
  } catch (e) {
    toast(`Config non sauvegardée dans Drive : ${e.message}`, 'error');
  }
}

/* ---- Auth gate ---- */
function showApp(signedIn) {
  $('loginPage').classList.toggle('hidden', signedIn);
  $('appPage').classList.toggle('hidden', !signedIn);
  $('btnSignOut').classList.toggle('hidden', !signedIn);
  $('userStatus').textContent = signedIn ? 'Connecté' : 'Non connecté';
}

Auth.onChange(async (signedIn) => {
  if (!signedIn) {
    DriveConfig.reset();
    clearStoredDashboard();
    showApp(false);
    return;
  }
  showApp(true);
  await syncFromDrive();
  refreshClientSelector();
  refreshClientDatalist();
  loadDashboard();
});

/* ---- Client selector ---- */
function refreshClientSelector() {
  const sel = $('clientSelector');
  const prev = selectedClient;
  sel.innerHTML = '';
  const clients = Config.getClients();
  clients.forEach((c) => {
    const opt = document.createElement('option');
    opt.value = c.name;
    opt.textContent = c.name;
    sel.appendChild(opt);
  });
  // Keep current selection if still valid, otherwise default to first client
  if (prev && clients.some((c) => c.name === prev)) {
    sel.value = prev;
    selectedClient = prev;
  } else if (clients.length) {
    sel.value = clients[0].name;
    selectedClient = clients[0].name;
  } else {
    selectedClient = '';
  }
  refreshStatsClientSelector();
  refreshTimelineClientSelector();
}

function refreshClientDatalist() {
  const dl = $('clientDatalist');
  if (!dl) return;
  dl.innerHTML = Config.getClients().map((c) => `<option value="${escHtml(c.name)}">`).join('');
}

/* ---- Dashboard ---- */
function showProgress(loaded, total) {
  const bar = $('loadingProgress');
  const fill = $('loadingProgressFill');
  const text = $('loadingProgressText');
  bar.classList.remove('hidden');
  if (total === 0) {
    fill.style.width = '0%';
    text.textContent = 'Scan…';
  } else {
    const pct = Math.min(100, Math.round((loaded / total) * 100));
    fill.style.width = `${pct}%`;
    text.textContent = `${loaded} / ${total}`;
  }
}

function hideProgress() {
  $('loadingProgress').classList.add('hidden');
  $('loadingProgressFill').style.width = '0%';
}

async function loadDashboard() {
  if (!Auth.isSignedIn()) return;
  showGlobalError('');

  // A full scan invalidates the lazily-loaded archived set; refresh it only if
  // the archived view is currently open.
  archivedLoaded = false;
  if (showArchived) loadArchivedChiffrages();

  // Show stale data immediately — perceived load is instant.
  const stored = loadStoredDashboard();
  if (stored?.length) {
    chiffrages = stored;
    dashboardLoading = false;
    renderFilters();
    renderTable();
  } else {
    dashboardLoading = true;
    chiffrages = [];
    renderTable();
  }

  showProgress(0, 0);
  busy($('btnRefresh'), true, stored?.length ? 'Actualisation…' : 'Chargement…');
  try {
    const allFresh = await listChiffrages(
      (batch, clientLabel) => {
        for (const ch of batch) {
          const idx = chiffrages.findIndex((c) => c.id === ch.id);
          if (idx >= 0) chiffrages[idx] = ch; // update stale entry in place
          else chiffrages.push(ch);
        }
        busy($('btnRefresh'), true, `${clientLabel} — ${chiffrages.length} chargé${chiffrages.length > 1 ? 's' : ''}`);
        renderFilters();
        renderTable();
      },
      { onProgress: (loaded, total) => showProgress(loaded, total) },
    );
    // Replace with authoritative list — removes files deleted or archived since last load.
    chiffrages = allFresh;
    dashboardLoading = false;
    storeDashboard(chiffrages);
    renderFilters();
    renderTable();
    if (currentView === 'stats') renderStats();
  } catch (e) {
    dashboardLoading = false;
    showGlobalError(e.message);
    renderTable();
  } finally {
    busy($('btnRefresh'), false);
    hideProgress();
  }
}

/* ---- Filters ---- */
function renderFilters() {
  const pillsEl = $('statusPills');
  pillsEl.innerHTML = '';

  const allPill = document.createElement('button');
  allPill.type = 'button';
  allPill.className = `status-pill${!showArchived && filterStatuses.size === 0 ? ' active' : ''}`;
  allPill.textContent = 'Tous';
  allPill.addEventListener('click', () => {
    filterStatuses.clear();
    showArchived = false;
    renderFilters();
    renderTable();
  });
  pillsEl.appendChild(allPill);

  STATUS_OPTIONS.filter((s) => s).forEach((s) => {
    const pill = document.createElement('button');
    pill.type = 'button';
    const st = STATUS_STYLES[s];
    const active = !showArchived && filterStatuses.has(s);
    pill.className = `status-pill${active ? ' active' : ''}`;
    if (active && st) {
      pill.style.background = st.bg;
      pill.style.color = st.color;
      pill.style.borderColor = st.bg;
    }
    pill.textContent = s;
    pill.addEventListener('click', () => {
      showArchived = false;
      if (filterStatuses.has(s)) filterStatuses.delete(s);
      else filterStatuses.add(s);
      renderFilters();
      renderTable();
    });
    pillsEl.appendChild(pill);
  });

  // Archived filter — mutually exclusive with the status filters above. The
  // [ARCH] scan only fires the first time it's opened (lazy load).
  const archPill = document.createElement('button');
  archPill.type = 'button';
  archPill.className = `status-pill${showArchived ? ' active' : ''}`;
  if (showArchived) {
    archPill.style.background = '#374151';
    archPill.style.color = '#d1d5db';
    archPill.style.borderColor = '#374151';
  }
  archPill.textContent = archivedLoading ? '⏳ Archivés…' : '🗃 Archivés';
  archPill.addEventListener('click', () => {
    if (showArchived) {
      showArchived = false;
      renderFilters();
      renderTable();
      return;
    }
    showArchived = true;
    filterStatuses.clear();
    renderFilters();
    renderTable();
    loadArchivedChiffrages();
  });
  pillsEl.appendChild(archPill);
}

async function loadArchivedChiffrages() {
  if (archivedLoaded || archivedLoading || !Auth.isSignedIn()) return;
  archivedLoading = true;
  showGlobalError('');
  renderFilters();
  showProgress(0, 0);
  try {
    const all = await listArchivedChiffrages(
      (batch) => {
        for (const ch of batch) {
          const idx = archivedChiffrages.findIndex((c) => c.id === ch.id);
          if (idx >= 0) archivedChiffrages[idx] = ch;
          else archivedChiffrages.push(ch);
        }
        if (showArchived) renderTable();
      },
      { onProgress: (loaded, total) => showProgress(loaded, total) },
    );
    archivedChiffrages = all;
    archivedLoaded = true;
  } catch (e) {
    showGlobalError(e.message);
  } finally {
    archivedLoading = false;
    hideProgress();
    renderFilters();
    if (showArchived) renderTable();
  }
}

/* ---- Stats page ---- */
const STATUS_DISPLAY_LABELS = {
  '': 'Non envoyé', 'Envoyé': 'Envoyé', 'Validé': 'Validé',
  'Passé en TMA': 'Passé en TMA', 'Refusé': 'Refusé', 'Annulé': 'Annulé',
};

// Brighter palette than STATUS_STYLES (which is tuned for dark chip backgrounds).
const STATUS_CHART_COLORS = {
  '': '#64748b', 'Envoyé': '#f59e0b', 'Validé': '#10b981',
  'Passé en TMA': '#3b82f6', 'Refusé': '#ef4444', 'Annulé': '#6b7280',
};

let currentView = 'dashboard';
let statsClient = ''; // '' = all clients

function showView(view) {
  currentView = view;
  $('dashboardView').classList.toggle('hidden', view !== 'dashboard');
  $('statsView').classList.toggle('hidden', view !== 'stats');
  $('timelineView').classList.toggle('hidden', view !== 'timeline');
  $('navDashboard').classList.toggle('active', view === 'dashboard');
  $('navStats').classList.toggle('active', view === 'stats');
  $('navTimeline').classList.toggle('active', view === 'timeline');
  if (view === 'stats') renderStats();
  if (view === 'timeline') renderTimeline();
}

function refreshStatsClientSelector() {
  const sel = $('statsClientSelector');
  if (!sel) return;
  const prev = statsClient;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = 'Tous les clients';
  sel.appendChild(all);
  for (const c of Config.getClients()) {
    const opt = document.createElement('option');
    opt.value = c.name; opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  statsClient = sel.value;
}

function refreshTimelineClientSelector() {
  const sel = $('timelineClientSelector');
  if (!sel) return;
  const prev = timelineClient;
  sel.innerHTML = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = 'Tous les clients';
  sel.appendChild(all);
  for (const c of Config.getClients()) {
    const opt = document.createElement('option');
    opt.value = c.name; opt.textContent = c.name;
    sel.appendChild(opt);
  }
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  timelineClient = sel.value;
}

function statsScope() {
  if (!statsClient) return chiffrages;
  const key = statsClient.trim().toLowerCase();
  return chiffrages.filter((c) => (c.client || '').trim().toLowerCase() === key);
}

// SVG donut from [{value, color}] segments.
function buildDonut(segments, size = 160, thickness = 26) {
  const ns = 'http://www.w3.org/2000/svg';
  const total = segments.reduce((s, x) => s + x.value, 0);
  const r = (size - thickness) / 2;
  const cx = size / 2; const cy = size / 2;
  const circ = 2 * Math.PI * r;
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));

  const ring = (color, dash, offset) => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', String(cx)); c.setAttribute('cy', String(cy)); c.setAttribute('r', String(r));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', color);
    c.setAttribute('stroke-width', String(thickness));
    if (dash != null) { c.setAttribute('stroke-dasharray', dash); c.setAttribute('stroke-dashoffset', String(offset)); }
    c.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
    return c;
  };

  if (total === 0) { svg.appendChild(ring('#252c3a')); return svg; }
  let offset = 0;
  for (const seg of segments) {
    if (seg.value <= 0) continue;
    const len = (seg.value / total) * circ;
    svg.appendChild(ring(seg.color, `${len} ${circ - len}`, -offset));
    offset += len;
  }
  return svg;
}

function renderStats() {
  const scope = statsScope();
  renderStatusBreakdown(scope);
  renderFunnel(scope);
}

function renderStatusBreakdown(scope) {
  const donutEl = $('statsDonut');
  const legendEl = $('statsLegend');
  donutEl.innerHTML = '';
  legendEl.innerHTML = '';

  const groups = {};
  for (const ch of scope) {
    const s = ch.status || '';
    if (!groups[s]) groups[s] = { count: 0, montant: 0 };
    groups[s].count++;
    groups[s].montant += typeof ch.montant === 'number' ? ch.montant : 0;
  }

  const segments = STATUS_OPTIONS
    .filter((s) => groups[s])
    .map((s) => ({ value: groups[s].count, color: STATUS_CHART_COLORS[s] ?? '#64748b', status: s }));

  const total = scope.length;

  // Donut + center total
  const wrap = document.createElement('div');
  wrap.style.position = 'relative';
  wrap.appendChild(buildDonut(segments));
  const center = document.createElement('div');
  center.className = 'stats-donut-center';
  center.innerHTML = `<span class="stats-donut-center-count">${total}</span><span class="stats-donut-center-label">chiffrage${total > 1 ? 's' : ''}</span>`;
  wrap.appendChild(center);
  donutEl.appendChild(wrap);

  if (!total) {
    legendEl.innerHTML = '<div class="stats-empty">Aucune donnée.</div>';
    return;
  }

  for (const s of STATUS_OPTIONS) {
    const g = groups[s];
    if (!g) continue;
    const row = document.createElement('div');
    row.className = 'stats-legend-row';
    const dot = document.createElement('span');
    dot.className = 'stats-legend-dot';
    dot.style.background = STATUS_CHART_COLORS[s] ?? '#64748b';
    const label = document.createElement('span');
    label.className = 'stats-legend-label';
    label.textContent = STATUS_DISPLAY_LABELS[s] ?? s;
    const vals = document.createElement('span');
    vals.className = 'stats-legend-vals';
    const pct = Math.round((g.count / total) * 100);
    vals.innerHTML = `<b>${g.count}</b> · ${pct}%${g.montant > 0 ? ` · ${escHtml(formatMontant(g.montant))}` : ''}`;
    row.append(dot, label, vals);
    legendEl.appendChild(row);
  }
}

function renderFunnel(scope) {
  const el = $('statsFunnel');
  el.innerHTML = '';
  if (!scope.length) { el.innerHTML = '<div class="stats-empty">Aucune donnée.</div>'; return; }

  const sum = (pred) => scope.reduce((acc, c) => {
    if (!pred(c.status || '')) return acc;
    return { count: acc.count + 1, montant: acc.montant + (typeof c.montant === 'number' ? c.montant : 0) };
  }, { count: 0, montant: 0 });

  const SENT = new Set(['Envoyé', 'Validé', 'Passé en TMA', 'Refusé']);
  const WON = new Set(['Validé', 'Passé en TMA']);

  const stages = [
    { label: 'Créés', color: '#64748b', ...sum(() => true) },
    { label: 'Envoyés', color: '#f59e0b', ...sum((s) => SENT.has(s)) },
    { label: 'Validés', color: '#10b981', ...sum((s) => WON.has(s)) },
  ];

  const top = stages[0].count || 1;
  stages.forEach((st, i) => {
    const stage = document.createElement('div');
    stage.className = 'funnel-stage';

    const head = document.createElement('div');
    head.className = 'funnel-stage-head';
    const lbl = document.createElement('span');
    lbl.className = 'funnel-stage-label';
    lbl.textContent = st.label;
    const vals = document.createElement('span');
    vals.className = 'funnel-stage-vals';
    vals.innerHTML = `<b>${st.count}</b>${st.montant > 0 ? ` · ${escHtml(formatMontant(st.montant))}` : ''}`;
    head.append(lbl, vals);

    const track = document.createElement('div');
    track.className = 'funnel-bar-track';
    const fill = document.createElement('div');
    fill.className = 'funnel-bar-fill';
    fill.style.width = `${Math.max(2, Math.round((st.count / top) * 100))}%`;
    fill.style.background = st.color;
    track.appendChild(fill);

    stage.append(head, track);

    if (i > 0) {
      const prev = stages[i - 1].count;
      const rate = prev > 0 ? Math.round((st.count / prev) * 100) : 0;
      const r = document.createElement('div');
      r.className = 'funnel-rate';
      r.textContent = `↳ ${rate}% depuis « ${stages[i - 1].label} »`;
      stage.appendChild(r);
    }
    el.appendChild(stage);
  });
}

/* ---- Timeline (Gantt) ---- */
const TIMELINE_PHASES = [
  { key: 'conception',    label: 'Conception',    bg: '#7ec77e', text: '#0d2b0d' },
  { key: 'developpement', label: 'Developpement', bg: '#7fb1f0', text: '#0a2747' },
  { key: 'recette',       label: 'Recette',       bg: '#f3b878', text: '#4a2c08' },
  { key: 'mep',           label: 'MEP',           bg: '#ec8b8b', text: '#4a1212' },
];
const FR_MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const QUARTER_W = 240; // px per quarter — fixed "quarter size" columns
const TL_LABEL_W = 200;
const TL_LANE_H = 28;
const TL_ROW_PAD = 8;
const TL_BAR_H = 16;
const TL_MIN_BAR = 9;
const DAY_MS = 86400000;

let timelineClient = ''; // '' = all clients
let tlGeom = null;       // { spanStartIdx, numQ, dateToX, totalW }
let tlEditTarget = null;

const pad2 = (n) => String(n).padStart(2, '0');
function tlParse(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return isNaN(d.getTime()) ? null : d;
}
function quarterIndex(d) { return d.getFullYear() * 4 + Math.floor(d.getMonth() / 3); }
function startOfQuarter(d) { return new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); }
function tlShort(d) { return `${d.getDate()} ${FR_MONTHS[d.getMonth()]}`; }
function phaseDateLabel(start, end) {
  if (start && end) return `${tlShort(start)} – ${tlShort(end)}`;
  if (start) return `Démarre ${tlShort(start)}`;
  return '';
}

function timelineEntries() {
  let arr = Object.values(Config.getTimeline());
  if (timelineClient) {
    const key = timelineClient.trim().toLowerCase();
    arr = arr.filter((e) => (e.client || '').trim().toLowerCase() === key);
  }
  const earliest = (e) => {
    let min = Infinity;
    for (const p of TIMELINE_PHASES) {
      const s = tlParse(e.phases?.[p.key]?.start);
      if (s) min = Math.min(min, s.getTime());
    }
    return min;
  };
  return arr.sort((a, b) => earliest(a) - earliest(b));
}

function renderTimeline() {
  const host = $('timelineChart');
  host.innerHTML = '';
  const entries = timelineEntries();

  if (!entries.length) {
    tlGeom = null;
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.innerHTML = timelineClient
      ? `Aucun projet dans la timeline pour « ${escHtml(timelineClient)} ».`
      : 'Aucun projet dans la timeline.<br>Ajoutez-en un via le bouton 🗓 sur une ligne du tableau de bord.';
    host.appendChild(empty);
    return;
  }

  // Collect every phase date to size the time span.
  const dates = [];
  for (const e of entries) {
    for (const p of TIMELINE_PHASES) {
      const s = tlParse(e.phases?.[p.key]?.start);
      const en = tlParse(e.phases?.[p.key]?.end);
      if (s) dates.push(s);
      if (en) dates.push(en);
    }
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  dates.push(today);
  const minD = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxD = new Date(Math.max(...dates.map((d) => d.getTime())));
  const spanStartIdx = quarterIndex(startOfQuarter(minD));
  const spanEndIdx = quarterIndex(startOfQuarter(maxD)) + 1; // pad a trailing quarter
  const numQ = spanEndIdx - spanStartIdx + 1;
  const totalW = numQ * QUARTER_W;

  const dateToX = (d) => {
    const qs = startOfQuarter(d);
    const qe = new Date(qs.getFullYear(), qs.getMonth() + 3, 1);
    const frac = (d.getTime() - qs.getTime()) / (qe.getTime() - qs.getTime());
    return (quarterIndex(d) - spanStartIdx + frac) * QUARTER_W;
  };
  tlGeom = { spanStartIdx, numQ, dateToX, totalW };

  const scroll = document.createElement('div');
  scroll.className = 'timeline-scroll';
  scroll.id = 'timelineScroll';

  const inner = document.createElement('div');
  inner.className = 'tl-inner';
  inner.style.width = `${TL_LABEL_W + totalW}px`;

  // --- Header: years + quarters ---
  const header = document.createElement('div');
  header.className = 'tl-header';
  const corner = document.createElement('div');
  corner.className = 'tl-corner';
  corner.textContent = 'Projet';
  corner.style.width = `${TL_LABEL_W}px`;
  const qcols = document.createElement('div');
  qcols.className = 'tl-qcols';
  qcols.style.width = `${totalW}px`;
  for (let i = 0; i < numQ; i++) {
    const qi = spanStartIdx + i;
    const year = Math.floor(qi / 4);
    const q = (qi % 4) + 1;
    const col = document.createElement('div');
    col.className = 'tl-qcol';
    col.style.left = `${i * QUARTER_W}px`;
    col.style.width = `${QUARTER_W}px`;
    const showYear = q === 1 || i === 0;
    col.innerHTML = `${showYear ? `<span class="tl-year">${year}</span>` : ''}<span class="tl-quarter">T${q}</span>`;
    qcols.appendChild(col);
  }
  header.append(corner, qcols);

  // --- Today vertical line (scrolls with content) ---
  const todayLine = document.createElement('div');
  todayLine.className = 'tl-today';
  todayLine.style.left = `${TL_LABEL_W + dateToX(today)}px`;

  inner.append(todayLine, header);

  // --- Rows ---
  for (const e of entries) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.style.height = `${TIMELINE_PHASES.length * TL_LANE_H + TL_ROW_PAD * 2}px`;

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.style.width = `${TL_LABEL_W}px`;
    label.title = 'Modifier le planning';
    const name = document.createElement('span');
    name.className = 'tl-label-name';
    name.textContent = e.label || '(sans nom)';
    label.appendChild(name);
    if (e.client) {
      const cl = document.createElement('span');
      cl.className = 'tl-label-client';
      cl.textContent = e.client;
      label.appendChild(cl);
    }
    label.addEventListener('click', () => openTimelineModal(e));

    const track = document.createElement('div');
    track.className = 'tl-track';
    track.style.width = `${totalW}px`;
    track.style.backgroundSize = `${QUARTER_W}px 100%`;

    TIMELINE_PHASES.forEach((p, li) => {
      const ph = e.phases?.[p.key];
      const s = tlParse(ph?.start);
      if (!s) return;
      const en = tlParse(ph?.end);
      const x1 = dateToX(s);
      // End date is inclusive → extend to the start of the following day.
      const x2 = en ? dateToX(new Date(en.getTime() + DAY_MS)) : x1;
      const w = Math.max(TL_MIN_BAR, x2 - x1);
      const top = TL_ROW_PAD + li * TL_LANE_H + (TL_LANE_H - TL_BAR_H) / 2;

      const bar = document.createElement('div');
      bar.className = 'tl-bar';
      bar.style.left = `${x1}px`;
      bar.style.width = `${w}px`;
      bar.style.top = `${top}px`;
      bar.style.height = `${TL_BAR_H}px`;
      bar.style.background = p.bg;
      track.appendChild(bar);

      const text = `${p.label} • ${phaseDateLabel(s, en)}`;
      const lbl = document.createElement('span');
      lbl.className = 'tl-bar-label';
      lbl.style.top = `${top}px`;
      lbl.style.height = `${TL_BAR_H}px`;
      if (w >= 160) {
        lbl.classList.add('inside');
        lbl.style.left = `${x1 + 8}px`;
        lbl.style.color = p.text;
        lbl.style.maxWidth = `${w - 12}px`;
      } else {
        lbl.style.left = `${x1 + w + 6}px`;
      }
      lbl.textContent = text;
      track.appendChild(lbl);
    });

    row.append(label, track);
    inner.appendChild(row);
  }

  scroll.appendChild(inner);
  host.appendChild(scroll);
  requestAnimationFrame(tlGoToday);
}

function tlGoToday() {
  const sc = $('timelineScroll');
  if (!sc || !tlGeom) return;
  const x = TL_LABEL_W + tlGeom.dateToX(new Date());
  sc.scrollLeft = Math.max(0, x - sc.clientWidth * 0.35);
}
function tlScrollBy(px) {
  const sc = $('timelineScroll');
  if (sc) sc.scrollLeft += px;
}

/* ---- Timeline edit modal ---- */
function openTimelineModal(target) {
  tlEditTarget = target;
  const label = target.projet || target.label || target.name || '';
  $('tlModalLabel').textContent = label;
  $('tlModalError').classList.add('hidden');
  const entry = Config.getTimelineEntry(target.id);
  let phases = entry?.phases || {};
  // Convenience: when first adding, prefill Conception start with the chiffrage date.
  if (!entry && target.date) {
    const iso = toDateInputValue(target.date);
    if (iso) phases = { conception: { start: iso } };
  }
  renderTlPhaseRows(phases);
  $('btnTlRemove').style.display = entry ? '' : 'none';
  openModal('timelineModal');
}

function renderTlPhaseRows(phases) {
  const c = $('tlPhaseRows');
  c.innerHTML = '';
  for (const p of TIMELINE_PHASES) {
    const v = phases[p.key] || {};
    const row = document.createElement('div');
    row.className = 'tl-phase-row';
    row.dataset.key = p.key;
    // Inputs are NOT inside <label> elements so the global "label input { width:100% }"
    // rule doesn't interfere with the flex layout.
    row.innerHTML = `
      <span class="tl-phase-swatch" style="background:${p.bg}"></span>
      <span class="tl-phase-name">${escHtml(p.label)}</span>
      <div class="tl-phase-dates">
        <span class="tl-date-lbl">Début</span>
        <input type="date" class="tl-start tl-date-input" value="${escHtml(v.start || '')}" />
        <span class="tl-date-arrow">→</span>
        <span class="tl-date-lbl">Fin</span>
        <input type="date" class="tl-end tl-date-input" value="${escHtml(v.end || '')}" />
      </div>
    `;
    c.appendChild(row);
  }
  // Auto-fill: when an end date is set, suggest it as the start of the next phase.
  const rows = c.querySelectorAll('.tl-phase-row');
  rows.forEach((row, idx) => {
    row.querySelector('.tl-end').addEventListener('change', (e) => {
      // Native date inputs can fire `change` mid-edit while the year segment is
      // still partial (e.g. "0002" before "2026" is finished typing). Only
      // propagate a complete, sane date so the next field isn't seeded garbage.
      const v = e.target.value;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || Number(v.slice(0, 4)) < 1900) return;
      if (idx + 1 < rows.length) {
        const nextStart = rows[idx + 1].querySelector('.tl-start');
        if (!nextStart.value) nextStart.value = v;
      }
    });
  });
  c.querySelectorAll('.tl-date-input').forEach((input) => {
    // Paste normalisation: accept dd/mm/yyyy, mm/dd/yyyy or yyyy-mm-dd pasted
    // from any source (including another date field in this modal).
    input.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData('text').trim();
      const iso = toDateInputValue(text);
      if (iso) {
        input.value = iso;
        input.dispatchEvent(new Event('change')); // triggers auto-fill if needed
      }
    });
    // Native date inputs don't support text selection, so Ctrl/Cmd+A bubbles up
    // and selects the whole page, and Ctrl/Cmd+C copies nothing. Intercept both
    // so the field's date can be copied to (and pasted into) another field.
    input.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault(); // don't select the entire page
      } else if (k === 'c' && input.value) {
        e.preventDefault();
        // Copy the ISO value so pasting into another field round-trips losslessly
        // (the paste handler matches YYYY-MM-DD exactly, avoiding dd/mm ambiguity).
        navigator.clipboard?.writeText(input.value);
      }
    });
  });
}

function saveTimelineEntry() {
  if (!tlEditTarget) return;
  const rows = $('tlPhaseRows').querySelectorAll('.tl-phase-row');
  const phases = {};
  let err = '';
  rows.forEach((r) => {
    const key = r.dataset.key;
    const start = r.querySelector('.tl-start').value;
    const end = r.querySelector('.tl-end').value;
    if (start) {
      const o = { start };
      if (end) {
        if (end < start) err = 'La date de fin doit être postérieure à la date de début.';
        o.end = end;
      }
      phases[key] = o;
    } else if (end) {
      err = 'Renseignez une date de début pour chaque phase ayant une date de fin.';
    }
  });
  const errEl = $('tlModalError');
  if (err) { errEl.textContent = err; errEl.classList.remove('hidden'); return; }
  if (!Object.keys(phases).length) {
    errEl.textContent = 'Renseignez au moins une phase (date de début).';
    errEl.classList.remove('hidden');
    return;
  }
  const label = tlEditTarget.projet || tlEditTarget.label || tlEditTarget.name || '';
  Config.setTimelineEntry(tlEditTarget.id, { label, client: tlEditTarget.client || '', phases });
  closeModal('timelineModal');
  toast('Timeline mise à jour.', 'success');
  renderTable();
  if (currentView === 'timeline') renderTimeline();
  saveConfigToDrive();
}

function removeFromTimeline() {
  if (!tlEditTarget) return;
  Config.removeTimelineEntry(tlEditTarget.id);
  closeModal('timelineModal');
  toast('Retiré de la timeline.', 'success');
  renderTable();
  if (currentView === 'timeline') renderTimeline();
  saveConfigToDrive();
}

/* ---- Timeline PDF export ---- */
// Reuse escHtml for SVG text nodes — same escaping requirements.
const escSvg = escHtml;

function exportTimelinePDF() {
  const entries = timelineEntries();
  if (!entries.length) { toast('Aucun projet à exporter.', 'error'); return; }

  // Recompute geometry independently so export works without rendering first.
  const dates = [];
  for (const e of entries) {
    for (const p of TIMELINE_PHASES) {
      const s = tlParse(e.phases?.[p.key]?.start);
      const en = tlParse(e.phases?.[p.key]?.end);
      if (s) dates.push(s);
      if (en) dates.push(en);
    }
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  dates.push(today);
  const minD = new Date(Math.min(...dates.map((d) => d.getTime())));
  const maxD = new Date(Math.max(...dates.map((d) => d.getTime())));
  const spanStart = quarterIndex(startOfQuarter(minD));
  const spanEnd   = quarterIndex(startOfQuarter(maxD)) + 1;
  const numQ = spanEnd - spanStart + 1;

  // SVG coordinate system — fixed width, heights computed from content.
  const W           = 800;
  const LABEL_W     = 220;
  const QW          = (W - LABEL_W) / numQ; // quarter width in SVG units
  const LANE_H      = 14; // height per phase lane
  const BAR_H       = 10;
  const ROW_PAD     = 8;
  const ROW_H       = TIMELINE_PHASES.length * LANE_H + ROW_PAD * 2;
  const HDR_H       = 54; // year row + quarter row
  const TITLE_H     = 48; // dark title bar on page 1
  const LEGEND_H    = 40;
  const ROWS_P1     = 5;  // max rows on page 1 (has title overhead)
  const ROWS_PN     = 6;  // max rows on other pages

  const trackX = (d) => {
    const qs = startOfQuarter(d);
    const qe = new Date(qs.getFullYear(), qs.getMonth() + 3, 1);
    return (quarterIndex(d) - spanStart + (d.getTime() - qs.getTime()) / (qe.getTime() - qs.getTime())) * QW;
  };

  // --- Build quarter header SVG fragment (placed at y = y0) ---
  function mkHeader(y0) {
    const out = [];
    out.push(`<rect x="0" y="${y0}" width="${W}" height="${HDR_H}" fill="#f8fafc"/>`);
    out.push(`<line x1="0" y1="${y0}" x2="${W}" y2="${y0}" stroke="#cbd5e1"/>`);
    out.push(`<line x1="0" y1="${y0+HDR_H}" x2="${W}" y2="${y0+HDR_H}" stroke="#cbd5e1"/>`);
    out.push(`<line x1="${LABEL_W}" y1="${y0}" x2="${LABEL_W}" y2="${y0+HDR_H}" stroke="#94a3b8"/>`);
    out.push(`<text x="${LABEL_W/2}" y="${y0+HDR_H/2+4}" text-anchor="middle" font-size="11" font-weight="600" fill="#64748b">Projet</text>`);
    // Year groups
    const yg = {};
    for (let i = 0; i < numQ; i++) {
      const yr = Math.floor((spanStart + i) / 4);
      if (!yg[yr]) yg[yr] = { s: i, e: i }; else yg[yr].e = i;
    }
    for (const [yr, g] of Object.entries(yg)) {
      const x1 = LABEL_W + g.s * QW;
      const x2 = LABEL_W + (g.e + 1) * QW;
      out.push(`<text x="${(x1+x2)/2}" y="${y0+15}" text-anchor="middle" font-size="11" font-weight="700" fill="#1e293b">${escSvg(yr)}</text>`);
      if (g.s > 0) out.push(`<line x1="${x1}" y1="${y0}" x2="${x1}" y2="${y0+22}" stroke="#94a3b8"/>`);
    }
    out.push(`<line x1="${LABEL_W}" y1="${y0+22}" x2="${W}" y2="${y0+22}" stroke="#e2e8f0"/>`);
    for (let i = 0; i < numQ; i++) {
      const x = LABEL_W + i * QW;
      const q = ((spanStart + i) % 4) + 1;
      out.push(`<line x1="${x}" y1="${y0+22}" x2="${x}" y2="${y0+HDR_H}" stroke="#e2e8f0"/>`);
      out.push(`<text x="${x+QW/2}" y="${y0+HDR_H-9}" text-anchor="middle" font-size="11" fill="#475569">T${q}</text>`);
    }
    return out.join('');
  }

  // --- Today line (vertical dashed blue) ---
  function mkTodayLine(y0, h) {
    const tx = trackX(today);
    if (tx < 0 || tx > W - LABEL_W) return '';
    const x = LABEL_W + tx;
    return `<line x1="${x}" y1="${y0}" x2="${x}" y2="${y0+h}" stroke="#3b82f6" stroke-width="1.5" stroke-dasharray="4,3"/>`;
  }

  // --- One project row ---
  function mkRow(e, y0, odd) {
    const out = [];
    out.push(`<rect x="0" y="${y0}" width="${W}" height="${ROW_H}" fill="${odd ? '#f8fafc' : '#ffffff'}"/>`);
    out.push(`<line x1="${LABEL_W}" y1="${y0}" x2="${LABEL_W}" y2="${y0+ROW_H}" stroke="#e2e8f0"/>`);
    out.push(`<line x1="0" y1="${y0+ROW_H}" x2="${W}" y2="${y0+ROW_H}" stroke="#e2e8f0"/>`);
    // Quarter vertical gridlines
    for (let i = 0; i <= numQ; i++) {
      out.push(`<line x1="${LABEL_W+i*QW}" y1="${y0}" x2="${LABEL_W+i*QW}" y2="${y0+ROW_H}" stroke="#e2e8f0"/>`);
    }
    // Project label — up to 2 wrapped lines, vertically centred in the row.
    const wrapLabel = (text, max) => {
      if (!text || text.length <= max) return [text || ''];
      const idx = text.lastIndexOf(' ', max);
      const l1  = idx > 0 ? text.slice(0, idx) : text.slice(0, max);
      const rest = idx > 0 ? text.slice(idx + 1) : text.slice(max);
      return [l1, rest.length > max ? `${rest.slice(0, max - 1)}…` : rest];
    };
    const nameLines = wrapLabel(e.label || '', 32);
    const LH = 12; // line-height in SVG units
    const totalContentH = nameLines.length * LH + (e.client ? LH : 0);
    const topBase = y0 + (ROW_H - totalContentH) / 2 + 10;
    for (let ni = 0; ni < nameLines.length; ni++) {
      out.push(`<text x="8" y="${topBase + ni * LH}" font-size="10" font-weight="600" fill="#1e293b">${escSvg(nameLines[ni])}</text>`);
    }
    if (e.client) out.push(`<text x="8" y="${topBase + nameLines.length * LH + 2}" font-size="9" fill="#64748b">${escSvg(e.client)}</text>`);
    // Phase bars
    TIMELINE_PHASES.forEach((p, li) => {
      const ph = e.phases?.[p.key];
      const s = tlParse(ph?.start);
      if (!s) return;
      const en = tlParse(ph?.end);
      const tx1 = trackX(s);
      const tx2 = en ? trackX(new Date(en.getTime() + DAY_MS)) : tx1;
      const bw  = Math.max(6, tx2 - tx1);
      const bx  = LABEL_W + tx1;
      const by  = y0 + ROW_PAD + li * LANE_H + (LANE_H - BAR_H) / 2;
      out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" rx="3" fill="${p.bg}"/>`);
      const txt = `${p.label} · ${phaseDateLabel(s, en)}`;
      if (bw >= 80) {
        out.push(`<text x="${bx+5}" y="${by+BAR_H*0.73}" font-size="7.5" fill="${p.text}" font-weight="500">${escSvg(txt)}</text>`);
      } else if (LABEL_W + tx1 + bw + 4 < W - 10) {
        out.push(`<text x="${bx+bw+4}" y="${by+BAR_H*0.73}" font-size="7.5" fill="#475569">${escSvg(txt)}</text>`);
      }
    });
    return out.join('');
  }

  // --- Legend ---
  function mkLegend(y0) {
    const out = [];
    out.push(`<line x1="0" y1="${y0+4}" x2="${W}" y2="${y0+4}" stroke="#e2e8f0"/>`);
    let lx = 20;
    for (const p of TIMELINE_PHASES) {
      out.push(`<rect x="${lx}" y="${y0+14}" width="12" height="10" rx="2" fill="${p.bg}"/>`);
      out.push(`<text x="${lx+16}" y="${y0+23}" font-size="9" fill="#475569">${escSvg(p.label)}</text>`);
      lx += 94;
    }
    return out.join('');
  }

  // --- Chunk entries into pages ---
  const pages = [];
  let remaining = [...entries];
  let isFirst = true;
  while (remaining.length) {
    const n = isFirst ? ROWS_P1 : ROWS_PN;
    pages.push({ rows: remaining.splice(0, n), isFirst });
    isFirst = false;
  }
  const pageCount = pages.length;

  // --- Generate SVG per page ---
  const clientLabel = timelineClient ? ` — ${timelineClient}` : '';
  const svgs = pages.map(({ rows, isFirst: first }, pi) => {
    const isLast = pi === pageCount - 1;
    const titleH = first ? TITLE_H : 0;
    const legH   = isLast ? LEGEND_H : 0;
    const totalH = titleH + HDR_H + rows.length * ROW_H + legH;
    const hdrY   = titleH;
    const rowsY  = titleH + HDR_H;
    const out = [];
    out.push(`<rect width="${W}" height="${totalH}" fill="white"/>`);
    // Title bar (page 1 only)
    if (first) {
      out.push(`<rect x="0" y="0" width="${W}" height="${TITLE_H}" fill="#1e293b"/>`);
      out.push(`<text x="${W/2}" y="${TITLE_H*0.64}" text-anchor="middle" font-size="17" font-weight="700" fill="#f8fafc">Timeline${escSvg(clientLabel)}</text>`);
    }
    // Quarter header
    out.push(mkHeader(hdrY));
    // Today line spanning header + rows
    out.push(mkTodayLine(hdrY, HDR_H + rows.length * ROW_H));
    // Rows
    rows.forEach((e, i) => out.push(mkRow(e, rowsY + i * ROW_H, (pi * ROWS_PN + i) % 2 === 1)));
    // Legend
    if (isLast) out.push(mkLegend(rowsY + rows.length * ROW_H));
    // Outer border + page number
    out.push(`<rect x="0.5" y="${hdrY+0.5}" width="${W-1}" height="${totalH-hdrY-1}" fill="none" stroke="#cbd5e1"/>`);
    if (pageCount > 1) out.push(`<text x="${W/2}" y="${totalH-6}" text-anchor="middle" font-size="8" fill="#94a3b8">${pi+1} / ${pageCount}</text>`);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${totalH}" style="width:100%;display:block;font-family:Arial,Helvetica,sans-serif">${out.join('')}</svg>`;
  });

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<title> </title><style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#e2e8f0;font-family:Arial,Helvetica,sans-serif}
.page{background:white;margin:12px auto;max-width:297mm;box-shadow:0 2px 8px rgba(0,0,0,.18)}
.page svg{display:block;width:100%}
@media print{
  body{background:white}
  .page{margin:0;box-shadow:none;page-break-after:always}
  .page:last-child{page-break-after:auto}
  @page{size:A4 landscape;margin:0}
}
</style></head><body>
${svgs.map((s) => `<div class="page">${s}</div>`).join('')}
<script>setTimeout(()=>window.print(),400);</script>
</body></html>`;

  const win = window.open('', '_blank', 'width=980,height=680');
  if (!win) { toast('Autorisez les popups pour exporter en PDF.', 'error'); return; }
  win.document.write(html);
  win.document.close();
}

/* ---- Timeline JSON export/import (sharing with colleagues) ---- */
function exportTimelineJSON() {
  const tl = Config.getTimeline();
  const count = Object.keys(tl).length;
  if (!count) { toast('Aucune donnée de timeline à exporter.', 'error'); return; }
  const json = JSON.stringify({ timeline: tl, exportedAt: new Date().toISOString() }, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'ChiffrageMax-Timeline.json';
  a.click();
  toast(`${count} projet(s) exporté(s) en JSON.`, 'success');
}

function importTimelineJSON(file) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    try {
      const data = JSON.parse(ev.target.result);
      const incoming = data.timeline && typeof data.timeline === 'object' && !Array.isArray(data.timeline)
        ? data.timeline : (typeof data === 'object' && !Array.isArray(data) ? data : null);
      if (!incoming) throw new Error('Format invalide (clé "timeline" introuvable).');
      const count = Object.keys(incoming).length;
      if (!count) { toast('Le fichier ne contient aucune entrée.', 'error'); return; }
      Config.saveTimeline({ ...Config.getTimeline(), ...incoming });
      saveConfigToDrive();
      toast(`${count} projet(s) importé(s) et fusionné(s).`, 'success');
      if (currentView === 'timeline') renderTimeline();
      renderTable();
    } catch (ex) {
      toast(`Import échoué : ${ex.message}`, 'error');
    }
  };
  reader.readAsText(file);
}

/* ---- Sort ---- */
function updateSortHeaders() {
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const field = th.dataset.sort;
    const label = th.dataset.label;
    const active = field === sortField;
    th.textContent = active ? `${label} ${sortAsc ? '↑' : '↓'}` : label;
    th.classList.toggle('th-sort-active', active);
  });
}

function parseDate(str) {
  if (!str) return 0;
  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, a, b, y] = m;
    if (Number(a) > 12) return new Date(Number(y), Number(b) - 1, Number(a)).getTime();
    return new Date(Number(y), Number(a) - 1, Number(b)).getTime();
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

function visibleChiffrages() {
  let list = showArchived ? archivedChiffrages : chiffrages;

  if (selectedClient) {
    const key = selectedClient.trim().toLowerCase();
    list = list.filter((c) => (c.client || '').trim().toLowerCase() === key);
  }

  // Status filters don't apply to the archived view — "Archivés" is its own scope.
  if (!showArchived && filterStatuses.size > 0) {
    list = list.filter((c) => filterStatuses.has(c.status || ''));
  }

  return [...list].sort((a, b) => {
    let va, vb;
    if (sortField === 'montant') {
      va = typeof a.montant === 'number' ? a.montant : Number(a.montant) || 0;
      vb = typeof b.montant === 'number' ? b.montant : Number(b.montant) || 0;
    } else if (sortField === 'date') {
      va = parseDate(a.date);
      vb = parseDate(b.date);
    } else {
      va = String(a[sortField] || '').toLowerCase();
      vb = String(b[sortField] || '').toLowerCase();
    }
    if (va < vb) return sortAsc ? -1 : 1;
    if (va > vb) return sortAsc ? 1 : -1;
    return 0;
  });
}

/* ---- Table rendering ---- */
function renderTable() {
  updateSortHeaders();
  const body = $('chiffrageBody');
  body.innerHTML = '';
  const visible = visibleChiffrages();

  if (!visible.length) {
    let msg;
    if (showArchived && archivedLoading) {
      msg = 'Chargement des chiffrages archivés…';
    } else if (showArchived && selectedClient) {
      msg = `Aucun chiffrage archivé pour « ${escHtml(selectedClient)} ».`;
    } else if (showArchived) {
      msg = 'Aucun chiffrage archivé.';
    } else if (dashboardLoading) {
      msg = 'Chargement en cours…';
    } else if (selectedClient) {
      msg = `Aucun chiffrage trouvé pour « ${escHtml(selectedClient)} ».`;
    } else {
      msg = 'Aucun chiffrage trouvé. Cliquez sur « Nouveau chiffrage ».';
    }
    body.innerHTML = `<tr><td colspan="10" class="empty">${msg}</td></tr>`;
    return;
  }

  for (const ch of visible) {
    const tr = document.createElement('tr');

    tr.appendChild(cell(ch.name));

    const tdDevis = cell(ch.numDevis);
    makeEditableCell(tdDevis, ch, 'numDevis', 'text');
    tr.appendChild(tdDevis);

    const tdClient = cell(ch.client);
    makeEditableCell(tdClient, ch, 'client', 'client');
    tr.appendChild(tdClient);

    const tdProjet = cell(ch.projet);
    makeEditableCell(tdProjet, ch, 'projet', 'text');
    tr.appendChild(tdProjet);

    const tdTicket = cell(ch.ticket);
    makeEditableCell(tdTicket, ch, 'ticket', 'text');
    tr.appendChild(tdTicket);

    const tdDate = cell(displayDate(ch.date));
    makeEditableCell(tdDate, ch, 'date', 'date');
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

    // File link — only render for safe http(s) URLs
    const tdFile = document.createElement('td');
    if (ch.url && /^https?:\/\//i.test(ch.url)) {
      const a = document.createElement('a');
      a.href = ch.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Ouvrir';
      tdFile.appendChild(a);
    } else {
      tdFile.textContent = '—';
    }
    tr.appendChild(tdFile);

    // Amount — click to re-fetch the live total from the sheet
    const tdMontant = cell(formatMontant(ch.montant));
    tdMontant.className = 'amount montant-cell';
    tdMontant.title = 'Cliquer pour actualiser le montant';
    tdMontant.addEventListener('click', () => refreshMontant(ch, tdMontant));
    tr.appendChild(tdMontant);

    // Archive + Delete
    const tdDel = document.createElement('td');
    tdDel.className = 'actions-cell';
    const inTimeline = Boolean(Config.getTimelineEntry(ch.id));
    const btnTl = document.createElement('button');
    btnTl.className = `btn btn-sm${inTimeline ? ' in-timeline' : ''}`;
    btnTl.textContent = '🗓';
    btnTl.title = inTimeline ? 'Modifier le planning timeline' : 'Ajouter à la timeline';
    btnTl.addEventListener('click', () => openTimelineModal(ch));
    tdDel.appendChild(btnTl);
    if (showArchived) {
      const btnUnarch = document.createElement('button');
      btnUnarch.className = 'btn btn-sm';
      btnUnarch.textContent = '📤';
      btnUnarch.title = 'Désarchiver (remettre dans le tableau de bord)';
      btnUnarch.addEventListener('click', () => onUnarchiveChiffrage(ch, btnUnarch));
      tdDel.appendChild(btnUnarch);
    } else {
      const btnArch = document.createElement('button');
      btnArch.className = 'btn btn-sm';
      btnArch.textContent = '🗃';
      btnArch.title = 'Archiver (masquer du tableau de bord)';
      btnArch.addEventListener('click', () => onArchiveChiffrage(ch, btnArch));
      tdDel.appendChild(btnArch);
    }
    const btnDel = document.createElement('button');
    btnDel.className = 'btn btn-sm btn-delete';
    btnDel.textContent = '🗑';
    btnDel.title = 'Supprimer définitivement ce chiffrage (Google Sheet)';
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
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toLocaleString('fr-FR', { maximumFractionDigits: 2 }) + ' €';
}

// Re-fetch the live total for a single row on demand.
async function refreshMontant(ch, td) {
  const prev = td.textContent;
  td.textContent = '…';
  try {
    ch.montant = await readChiffrageMontant(ch.id, ch.sheetName);
    td.textContent = formatMontant(ch.montant);
  } catch (e) {
    td.textContent = prev;
    toast(e.message, 'error');
  }
}

/* ---- Dashboard persistence (stale-while-revalidate) ---- */
const DASHBOARD_STORE_KEY = 'chiffragemax.dashboard';

function loadStoredDashboard() {
  try {
    const raw = localStorage.getItem(DASHBOARD_STORE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return Array.isArray(d) ? d : null;
  } catch { return null; }
}

function storeDashboard(data) {
  try { localStorage.setItem(DASHBOARD_STORE_KEY, JSON.stringify(data)); }
  catch { try { localStorage.removeItem(DASHBOARD_STORE_KEY); } catch {} }
}

function clearStoredDashboard() {
  try { localStorage.removeItem(DASHBOARD_STORE_KEY); } catch {}
}

// Re-fetch totals for the currently visible chiffrages (on tab refocus).
let refreshingMontants = false;
let lastMontantRefresh = 0;
async function refreshVisibleMontants() {
  if (refreshingMontants || dashboardLoading || !Auth.isSignedIn()) return;
  const now = Date.now();
  if (now - lastMontantRefresh < 8000) return; // throttle rapid tab switches
  const visible = visibleChiffrages();
  if (!visible.length) return;
  lastMontantRefresh = now;
  refreshingMontants = true;
  try {
    let changed = false;
    let idx = 0;
    const worker = async () => {
      while (idx < visible.length) {
        const ch = visible[idx++];
        try {
          const m = await readChiffrageMontant(ch.id, ch.sheetName);
          if (m !== ch.montant) { ch.montant = m; changed = true; }
        } catch { /* skip individual failures */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, visible.length) }, worker));
    if (changed) renderTable();
  } finally {
    refreshingMontants = false;
  }
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

// Rebuild the CHI-DD/MM/YY- Projet filename from any stored date format.
function buildChiffrageFileName(projet, dateStr) {
  let dateId = '';
  if (dateStr) {
    const iso = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      dateId = `${iso[3]}/${iso[2]}/${String(iso[1]).slice(-2)}`;
    } else {
      const parts = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const d = parts
        ? (() => {
            const [, a, b, y] = parts.map(Number);
            if (a > 12) return new Date(y, b - 1, a); // DD/MM/YYYY
            if (b > 12) return new Date(y, a - 1, b); // M/D/YYYY
            return new Date(y, b - 1, a);              // assume DD/MM/YYYY
          })()
        : new Date(dateStr);
      if (!isNaN(d.getTime())) {
        const pad = (n) => String(n).padStart(2, '0');
        dateId = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)}`;
      }
    }
  }
  return dateId
    ? `CHI-${dateId}- ${cleanProjectName(projet || '')}`
    : `CHI- ${cleanProjectName(projet || '')}`;
}

// Parse any stored date string into {yearStr, monthStr} for folder resolution.
function parseDateForFolder(str) {
  if (!str) return null;
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return { yearStr: iso[1], monthStr: `${iso[1]}-${iso[2]}` };
  const parts = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (parts) {
    const [, a, b, y] = parts.map(Number);
    const month = a > 12 ? b : (b > 12 ? a : b); // DD/MM or M/D heuristic
    const yearStr = String(y);
    return { yearStr, monthStr: `${yearStr}-${String(month).padStart(2, '0')}` };
  }
  const d = new Date(str);
  if (!isNaN(d.getTime())) {
    const yearStr = String(d.getFullYear());
    return { yearStr, monthStr: `${yearStr}-${String(d.getMonth() + 1).padStart(2, '0')}` };
  }
  return null;
}

async function saveField(ch, field, value) {
  const cellAddr = FIELD_CELL[field];
  if (!cellAddr) throw new Error(`Champ inconnu : ${field}`);
  await SheetsAPI.updateValues(ch.id, `${ch.sheetName}!${cellAddr}`, [[value]]);
  if (field === 'client') {
    const baseFolderId = Config.getClientFolder(value);
    if (baseFolderId) {
      const ym = parseDateForFolder(ch.date);
      const destFolderId = ym
        ? await resolveMonthFolder(ym.yearStr, ym.monthStr, baseFolderId)
        : baseFolderId;
      await DriveAPI.moveFile(ch.id, destFolderId);
    }
  }
  if (field === 'projet' || field === 'date') {
    const projet  = field === 'projet' ? value : ch.projet;
    const dateStr = field === 'date'   ? value : ch.date;
    const newName = buildChiffrageFileName(projet, dateStr);
    await DriveAPI.renameFile(ch.id, newName);
    ch.name = newName;
  }
}

function toDateInputValue(str) {
  if (!str) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const parts = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (parts) {
    const [, a, b, y] = parts;
    const na = Number(a), nb = Number(b);
    if (na > 12) return `${y}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
    if (nb > 12) return `${y}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
}

function formatDateDisplay(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

// Normalize any stored date string to DD/MM/YYYY for display.
// Handles ISO (YYYY-MM-DD) from the Sheets API as well as already-normalized values.
function displayDate(str) {
  if (!str) return '';
  return formatDateDisplay(str);
}

function makeEditableCell(td, ch, field, type = 'text') {
  td.classList.add('editable-cell');
  td.addEventListener('click', () => {
    if (td.classList.contains('editing')) return;
    const prev = String(ch[field] ?? '');

    let inputEl;

    if (type === 'client') {
      inputEl = document.createElement('select');
      inputEl.className = 'inline-edit-input';
      const clients = Config.getClients();
      if (prev && !clients.some((c) => c.name === prev)) {
        const opt = document.createElement('option');
        opt.value = prev; opt.textContent = prev; opt.selected = true;
        inputEl.appendChild(opt);
      }
      for (const c of clients) {
        const opt = document.createElement('option');
        opt.value = c.name; opt.textContent = c.name;
        if (c.name === prev) opt.selected = true;
        inputEl.appendChild(opt);
      }
    } else if (type === 'date') {
      inputEl = document.createElement('input');
      inputEl.type = 'date';
      inputEl.value = toDateInputValue(prev);
      inputEl.className = 'inline-edit-input';
    } else {
      inputEl = document.createElement('input');
      inputEl.type = 'text';
      inputEl.value = prev;
      inputEl.className = 'inline-edit-input';
    }

    td.textContent = '';
    td.classList.add('editing');
    td.appendChild(inputEl);
    inputEl.focus();
    if (inputEl.select && type !== 'date') inputEl.select();

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
      const rawVal = inputEl.value;
      const newVal = typeof rawVal === 'string' ? rawVal.trim() : rawVal;
      td.classList.remove('editing');
      if (newVal === prev) { td.textContent = prev; return; }
      td.textContent = '…';
      try {
        const nameBefore = ch.name;
        await saveField(ch, field, newVal);
        const display = type === 'date' ? formatDateDisplay(newVal) : newVal;
        ch[field] = display;
        td.textContent = display;
        // If saveField renamed the Drive file, refresh the filename cell in the same row
        if (ch.name !== nameBefore) {
          const nameTd = td.closest('tr')?.querySelector('td:first-child');
          if (nameTd) nameTd.textContent = ch.name;
        }
        toast('Modifié.', 'success');
        if (field === 'client') renderTable();
      } catch (e) {
        td.textContent = prev;
        toast(e.message, 'error');
      }
    };

    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') cancel();
    });

    if (type === 'client') {
      inputEl.addEventListener('change', confirm);
      inputEl.addEventListener('blur', cancel);
    } else {
      inputEl.addEventListener('blur', confirm);
    }
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

/* ---- Archive chiffrage ---- */
async function onArchiveChiffrage(ch, btn) {
  busy(btn, true);
  try {
    const newName = ch.name.includes('[ARCH]') ? ch.name : `${ch.name} [ARCH]`;
    await DriveAPI.renameFile(ch.id, newName);
    chiffrages = chiffrages.filter((c) => c.id !== ch.id);
    storeDashboard(chiffrages);
    // The archived set is now stale — force a rescan next time it's opened.
    archivedLoaded = false;
    renderTable();
    toast('Chiffrage archivé.', 'success');
  } catch (e) {
    toast(e.message, 'error');
    busy(btn, false);
  }
}

/* ---- Unarchive chiffrage ---- */
async function onUnarchiveChiffrage(ch, btn) {
  busy(btn, true);
  try {
    const newName = ch.name.replace(/\s*\[ARCH\]/g, '').trim();
    await DriveAPI.renameFile(ch.id, newName);
    ch.name = newName;
    archivedChiffrages = archivedChiffrages.filter((c) => c.id !== ch.id);
    // Surface it in the normal dashboard immediately.
    if (!chiffrages.some((c) => c.id === ch.id)) chiffrages.push(ch);
    storeDashboard(chiffrages);
    renderTable();
    toast('Chiffrage désarchivé.', 'success');
  } catch (e) {
    toast(e.message, 'error');
    busy(btn, false);
  }
}

/* ---- Delete chiffrage ---- */
async function onDeleteChiffrage(ch, btn) {
  const label = ch.projet ? `« ${ch.projet} »` : ch.name;
  if (!window.confirm(`Supprimer définitivement le chiffrage ${label} ?\n\nCette action supprime le Google Sheet — elle est irréversible.`)) return;
  busy(btn, true);
  try {
    await deleteChiffrage(ch.id);
  } catch (e) {
    if (e.message.includes('404')) {
      // Drive returns 404 either because the file is truly gone OR because
      // Drive can't reach this file at all (external Shared Drive collaborator,
      // Workspace domain API restrictions, etc.). Probe with the Sheets API
      // — which uses a different auth path — to tell them apart.
      try {
        await SheetsAPI.get(ch.id, { fields: 'spreadsheetId' });
        // Sheets can still read it → file exists, but Drive API cannot access it.
        // Offer to at least remove the dashboard row and open the file for manual deletion.
        busy(btn, false);
        const driveUrl = ch.url || `https://drive.google.com/file/d/${ch.id}`;
        const proceed = window.confirm(
          `L'API Drive ne peut pas supprimer ce fichier (erreur 404).\n\n`
          + `Causes possibles :\n`
          + `• Le fichier est dans un Drive d'équipe dont vous n'êtes pas membre\n`
          + `• Votre domaine Google Workspace restreint l'API Drive pour les apps tierces\n\n`
          + `Supprimez-le manuellement en cliquant sur "Ouvrir" (colonne Fichier), `
          + `puis faites clic droit → Déplacer vers la corbeille.\n\n`
          + `Voulez-vous le retirer du tableau de bord maintenant ?`,
        );
        if (!proceed) return;
        // Remove only from the dashboard — the Drive file is untouched.
      } catch {
        // Sheets read also failed → file is truly gone → remove the stale row.
      }
    } else {
      toast(e.message, 'error');
      busy(btn, false);
      return;
    }
  }
  chiffrages = chiffrages.filter((c) => c.id !== ch.id);
  storeDashboard(chiffrages);
  renderTable();
  toast('Chiffrage supprimé.', 'success');
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
    const created = await nouveauChiffrage({ numDevis, client, projet, ticket, date, targetFolderId, phases: getPhases(), roles });
    closeModal('newModal');
    toast('Chiffrage créé avec succès.', 'success');
    selectedClient = client;
    if (![...$('clientSelector').options].some((o) => o.value === client)) {
      refreshClientSelector();
    }
    $('clientSelector').value = client;
    // Read only the new file and append it — avoids re-scanning every folder.
    try {
      const ch = await readChiffrageFile({ id: created.id, name: created.idChiffrage, webViewLink: created.url });
      if (!chiffrages.some((c) => c.id === ch.id)) chiffrages.push(ch);
      storeDashboard(chiffrages);
      renderTable();
    } catch {
      await loadDashboard();
    }
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

/* ---- Google Picker ---- */
// Open the Drive Picker so the user grants the app access to a specific folder
// (or the template sheet) under the narrow `drive.file` scope. Returns the
// selected {id, name, mimeType} or null on cancel/error.
async function runPicker(kind) {
  if (!Auth.isSignedIn()) {
    toast('Connectez-vous d\'abord pour choisir un dossier.', 'error');
    return null;
  }
  if (!Config.get('developerKey')) {
    toast('Renseignez la « Clé API navigateur » dans ⚙️ Paramètres avancés.', 'error');
    return null;
  }
  try {
    const token = await Auth.getToken();
    const opts = {
      token,
      developerKey: Config.get('developerKey'),
      appId: Config.get('projectNumber'),
    };
    if (kind === 'template') return await Picker.pickSpreadsheet(opts);
    if (kind === 'file') return await Picker.pickFile(opts);
    return await Picker.pickFolder(opts);
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

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
      <input class="input-sm input-sm--grow client-edit-folder" type="text" value="${escHtml(c.folderId)}" placeholder="Dossier Drive (bouton 📂)" />
      <button class="btn btn-sm" data-pick title="Choisir le dossier via Google Drive">📂</button>
      <button class="btn btn-sm btn-primary" data-save>✓</button>
      <button class="btn btn-sm btn-ghost" data-cancel>✕</button>
    `;
    row.querySelector('[data-pick]').addEventListener('click', async () => {
      const doc = await runPicker('folder');
      if (doc) { row.querySelector('.client-edit-folder').value = doc.id; toast(`Dossier sélectionné : ${doc.name}`, 'success'); }
    });
    row.querySelector('[data-save]').addEventListener('click', async () => {
      const newName = row.querySelector('.client-edit-name').value.trim();
      const newFolderRaw = row.querySelector('.client-edit-folder').value.trim();
      if (!newName || !newFolderRaw) { toast('Nom et dossier requis.', 'error'); return; }
      const newFolder = extractFolderId(newFolderRaw) || newFolderRaw;
      Config.updateClient(c.name, newName, newFolder);
      refreshClientDatalist();
      refreshClientSelector();
      renderClientList();
      toast(`Client « ${newName} » mis à jour.`, 'success');
      await saveConfigToDrive();
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
    row.querySelector('[data-delete]').addEventListener('click', async () => {
      Config.deleteClient(c.name);
      renderClientList();
      refreshClientDatalist();
      refreshClientSelector();
      await saveConfigToDrive();
    });
  }
}

function openSettings() {
  const c = Config.load();
  $('cfgClientId').value = c.clientId;
  $('cfgTemplateId').value = c.templateId;
  $('cfgRootFolderId').value = c.rootFolderId;
  $('cfgDeveloperKey').value = c.developerKey || '';
  $('cfgProjectNumber').value = c.projectNumber || '';
  $('cfgSharedConfigId').value = c.sharedConfigId || '';
  $('cfgOwnConfigId').value = DriveConfig.getFileId() || '';
  $('addClientName').value = '';
  $('addClientFolder').value = '';
  // Show first-run guide when template or clients are not yet configured.
  const isNewUser = !c.templateId || !Config.getClients().length;
  $('setupGuide').classList.toggle('hidden', !isNewUser);
  renderClientList();
  openModal('settingsModal');
}

async function saveSettings() {
  const rawTemplate  = $('cfgTemplateId').value.trim();
  const rawRoot      = $('cfgRootFolderId').value.trim();
  const prevSharedId = Config.get('sharedConfigId') || '';
  const rawSharedId  = $('cfgSharedConfigId').value.trim();
  const newSharedId  = extractSpreadsheetId(rawSharedId) || rawSharedId;
  Config.save({
    clientId:       $('cfgClientId').value.trim(),
    templateId:     extractSpreadsheetId(rawTemplate) || rawTemplate,
    rootFolderId:   extractFolderId(rawRoot) || rawRoot,
    developerKey:   $('cfgDeveloperKey').value.trim(),
    projectNumber:  $('cfgProjectNumber').value.trim(),
    sharedConfigId: newSharedId,
  });
  closeModal('settingsModal');
  refreshClientDatalist();
  refreshClientSelector();
  if (newSharedId !== prevSharedId) {
    DriveConfig.setSharedConfigId(newSharedId || null);
    if (newSharedId) {
      // New shared config set: read the team config instead of overwriting it.
      toast('Synchronisation depuis la config partagée…', '');
      await syncFromDrive();
      refreshClientSelector();
      refreshClientDatalist();
      return;
    }
  }
  toast('Configuration enregistrée.', 'success');
  await saveConfigToDrive();
}

async function addClient() {
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
  await saveConfigToDrive();
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

async function saveRoles() {
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
  await saveConfigToDrive();
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
  $('btnCopyConfigId').addEventListener('click', () => {
    const id = $('cfgOwnConfigId').value;
    if (id) {
      navigator.clipboard.writeText(id)
        .then(() => toast('ID copié dans le presse-papier.', 'success'))
        .catch(() => toast('Copie impossible : autorisez l\'accès au presse-papier.', 'error'));
    }
  });
  $('btnAddClient').addEventListener('click', addClient);

  // Google Picker buttons — let the user grant per-folder/-file access (drive.file).
  $('btnPickTemplate').addEventListener('click', async () => {
    const doc = await runPicker('template');
    if (doc) { $('cfgTemplateId').value = doc.id; toast(`Modèle sélectionné : ${doc.name}`, 'success'); }
  });
  $('btnPickRoot').addEventListener('click', async () => {
    const doc = await runPicker('folder');
    if (doc) { $('cfgRootFolderId').value = doc.id; toast(`Dossier sélectionné : ${doc.name}`, 'success'); }
  });
  $('btnPickClientFolder').addEventListener('click', async () => {
    const doc = await runPicker('folder');
    if (doc) {
      $('addClientFolder').value = doc.id;
      if (!$('addClientName').value.trim()) $('addClientName').value = doc.name;
      toast(`Dossier sélectionné : ${doc.name}`, 'success');
    }
  });
  $('btnPickShared').addEventListener('click', async () => {
    const doc = await runPicker('file');
    if (doc) { $('cfgSharedConfigId').value = doc.id; toast(`Fichier sélectionné : ${doc.name}`, 'success'); }
  });

  $('clientSelector').addEventListener('change', (e) => {
    selectedClient = e.target.value;
    renderTable();
  });

  // Navigation between dashboard and stats views.
  $('navDashboard').addEventListener('click', () => showView('dashboard'));
  $('navStats').addEventListener('click', () => showView('stats'));
  $('navTimeline').addEventListener('click', () => showView('timeline'));
  $('statsClientSelector').addEventListener('change', (e) => {
    statsClient = e.target.value;
    renderStats();
  });
  $('timelineClientSelector').addEventListener('change', (e) => {
    timelineClient = e.target.value;
    renderTimeline();
  });
  $('tlPrev').addEventListener('click', () => tlScrollBy(-QUARTER_W));
  $('tlNext').addEventListener('click', () => tlScrollBy(QUARTER_W));
  $('tlToday').addEventListener('click', tlGoToday);
  $('btnTlSave').addEventListener('click', saveTimelineEntry);
  $('btnTlRemove').addEventListener('click', removeFromTimeline);
  $('btnTlClose').addEventListener('click', () => closeModal('timelineModal'));
  $('btnExportPDF').addEventListener('click', exportTimelinePDF);
  $('btnExportTL').addEventListener('click', exportTimelineJSON);
  $('btnImportTL').addEventListener('click', () => $('importTLFile').click());
  $('importTLFile').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) { importTimelineJSON(f); e.target.value = ''; }
  });

  document.querySelector('#chiffrageTable thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const field = th.dataset.sort;
    if (sortField === field) sortAsc = !sortAsc;
    else { sortField = field; sortAsc = true; }
    renderTable();
  });

  $('btnRefresh').addEventListener('click', loadDashboard);

  // Re-read live amounts when returning to the dashboard tab.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshVisibleMontants();
  });

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
    // Show a prereq hint when the app isn't configured yet.
    const missingTemplate = !Config.get('templateId');
    const missingFolder = !Config.getClients().some((c) => c.folderId) && !Config.get('rootFolderId');
    $('newPrereqBanner').classList.toggle('hidden', !missingTemplate && !missingFolder);
    openModal('newModal');
  });
  $('openSettingsFromNew').addEventListener('click', () => { closeModal('newModal'); openSettings(); });
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
  updateSortHeaders();
  renderFilters();
  showApp(Auth.isSignedIn());
  if (Auth.isSignedIn()) {
    (async () => {
      await syncFromDrive();
      refreshClientSelector();
      refreshClientDatalist();
      loadDashboard();
    })();
  }
}

init();
