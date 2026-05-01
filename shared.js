// ═══════════════════════════════════════════════════════════════
// SHARED.JS - Logique commune aux vues Affectation et Congés
// ═══════════════════════════════════════════════════════════════

const PLAN_PROXY = "https://planning-proxy.receptionroulier.workers.dev";
const NAV_PROXY = "https://shgt-proxy.receptionroulier.workers.dev";
const HOLIDAYS_BASE = "https://calendrier.api.gouv.fr/jours-feries/metropole";
const SCHOOL_HOLIDAYS_API = 'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records';

const SECTIONS_ORDER = ['cm', 'fcq', 'pn', 'matin', 'aprem', 'autre'];
const SECTIONS_MAP_BASE = {
  'cm':    { id: 'cm',    name: 'Chef de Manutention',    hours: '',                          color: '#ff4d6d' },
  'fcq':   { id: 'fcq',  name: 'Chef de quai',           hours: '8h30-12h00 / 14h00-17h30', color: '#a78bfa' },
  'pn':    { id: 'pn',   name: 'Montage / Prépa',        hours: '8h30-12h00 / 14h00-17h30', color: '#00c896' },
  'matin': { id: 'matin',name: 'Réception Matin',        hours: '7h00 / 14h00',              color: '#ffd060' },
  'aprem': { id: 'aprem',name: 'Réception Après-Midi',   hours: '13h00 / 20h00',             color: '#3b8fff' },
  'autre': { id: 'autre',name: 'Autres',                 hours: '',                          color: '#94a3b8' }
};

const WEEK_REF = new Date(2025, 3, 28);
const DAYS = ['Lundi','Mardi','Mercredi','Jeudi','Vendredi','Samedi','Dimanche'];

const TBD_WORKER = { id: '_tbd_', firstName: 'À', lastName: 'DÉFINIR', matricule: '—', color: '#94a3b8', isChief: false, isTbd: true };

const WORKER_COLORS = [
  { key: 'rouge',  hex: '#ff4d6d' },
  { key: 'violet', hex: '#a78bfa' },
  { key: 'vert',   hex: '#00c896' },
  { key: 'bleu',   hex: '#3b8fff' },
  { key: 'jaune',  hex: '#ffd060' }
];

let state = {
  weekStart: getMonday(new Date()),
  absMonth: new Date(),
  view: 'week',
  planning: {},
  planningModified: {},
  slots: {},
  absences: {},
  holidays: {},
  schoolHolidays: {},
  config: {
    emailWeek: 'chefmanutention.tmt@shgt.fr',
    emailCcWeek: 'smaillard@smr-france.com',
    workerColors: {},
    schoolHolidayZones: { A: false, B: true, C: false },
    absOrder: [],
    absPrint: [],
  },
  staff: [],
  workerAssignmentMap: {},
  dragWorker: null,
  slotApiMap: {},
  colWidths: Array(7).fill(null),
};

const _schoolHolidaysCache = new Map();
let _cfgActiveModule = null;
let _saveTimer = null;
let _remoteSupported = null;

function getMonday(d) { const r = new Date(d); const day = r.getDay(); r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day)); r.setHours(0,0,0,0); return r; }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtISO(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function fmtFR(d) { return d.toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }); }
function getWeekNum(d) { const t = new Date(d); t.setHours(0,0,0,0); t.setDate(t.getDate() + 3 - (t.getDay()+6)%7); const j4 = new Date(t.getFullYear(),0,4); return 1 + Math.round(((t-j4)/86400000 - 3 + (j4.getDay()+6)%7)/7); }
function weekKey() { return fmtISO(state.weekStart); }
function gkey(localKey) { return weekKey() + '__' + localKey; }
function getWorker(id) { if (id === '_tbd_') return TBD_WORKER; return state.staff.find(w => w.id === id); }
function getWorkerColorClass(workerId) { const c = state.config.workerColors?.[workerId]; return c ? 'has-wcolor wcolor-' + c : ''; }

function getSectionsMap() {
  const msPerWeek = 7 * 24 * 60 * 60 * 1000;
  const elapsed = Math.round((state.weekStart - WEEK_REF) / msPerWeek);
  const isOdd = elapsed % 2 === 0;
  return {
    ...SECTIONS_MAP_BASE,
    matin: { ...SECTIONS_MAP_BASE.matin, color: isOdd ? '#ffd060' : '#3b8fff' },
    aprem: { ...SECTIONS_MAP_BASE.aprem, color: isOdd ? '#3b8fff' : '#ffd060' },
  };
}

function findSectionForWorker(jobCode, posteCode, projectName) {
    const isParcProject = projectName && (projectName.includes('Parc SMR') || projectName.includes('Parc Manucar'));
    if (jobCode === 'CM' && posteCode === '0817') return 'cm';
    if (jobCode === 'FCQ' && posteCode === '0817') return 'fcq';
    if (jobCode === 'PN' && posteCode === '0817') return 'pn';
    if ((jobCode === 'CI' || jobCode === 'CO') && posteCode === '0714' && isParcProject) return 'matin';
    if ((jobCode === 'CI' || jobCode === 'CO') && posteCode === '1320' && isParcProject) return 'aprem';
    return 'autre';
}

function toast(msg, type) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.background = type === 'error' ? 'var(--red)' : 'var(--accent)';
  t.style.color = '#fff';
  t.classList.add('show');
  setTimeout(function() { t.classList.remove('show'); }, 2800);
}

function showModal(content) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal-content');
  if (overlay && modal) { modal.innerHTML = content; overlay.classList.add('show'); }
}

function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('show');
}
window.closeModal = closeModal;

function loadState() {
  try {
    const s = localStorage.getItem('planningRoulier_v21');
    if (s) {
      const saved = JSON.parse(s);
      state.planning = saved.planning || {};
      state.planningModified = saved.planningModified || {};
      state.config = { ...state.config, ...saved.config, workerColors: { ...(saved.config?.workerColors || {}) }, schoolHolidayZones: { A: false, B: true, C: false, ...(saved.config?.schoolHolidayZones || {}) }, absOrder: saved.config?.absOrder || [], absPrint: saved.config?.absPrint || [] };
      if (saved.view) state.view = saved.view;
    }
    const cw = localStorage.getItem('planningRoulier_colWidths');
    if (cw) state.colWidths = JSON.parse(cw);
    else state.colWidths = Array(7).fill(null);
  } catch(e) { console.error('[loadState]', e); state.colWidths = Array(7).fill(null); }
}

function saveState() {
  try { localStorage.setItem('planningRoulier_v21', JSON.stringify({ planning: state.planning, planningModified: state.planningModified, config: state.config, view: state.view })); } catch(e) {}
  savePlanningRemote();
}

async function fetchNavires(dateFrom, dateTo) {
    try {
        const response = await fetch(NAV_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dateFrom: dateFrom, dateTo: dateTo }) });
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch(e) { console.error('[API] Error navires:', e); return []; }
}

async function fetchPersonnel(dateFrom, dateTo) {
    try {
        const response = await fetch(PLAN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'workers', dateFrom: dateFrom, dateTo: dateTo }) });
        const data = await response.json();
        return data;
    } catch(e) { console.error('[API] Error personnel:', e); return { totalWorkers: 0, workerCalendars: [] }; }
}

function parsePersonnelData(personnelData, dateFrom, dateTo) {
    const staffMap = new Map();
    const absencesMap = {};
    const workerAssignmentMap = {};
    if (!personnelData || !personnelData.workerCalendars) { return { staff: [], absences: {}, workerAssignmentMap: {} }; }
    personnelData.workerCalendars.forEach(function(wc) {
        const workerId = String(wc.workerId);
        if (!staffMap.has(workerId)) {
            const rawFirst = wc.firstName || '';
            const capitalFirst = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase();
            staffMap.set(workerId, { id: workerId, firstName: capitalFirst, lastName: (wc.lastName || '').toUpperCase(), matricule: wc.dockerMatricule || '', isChief: wc.isChief || false });
        }
        if (wc.days) {
            wc.days.forEach(function(day) {
                if (!day.date) return;
                if (day.isAbsence && day.code) { if (!absencesMap[workerId]) absencesMap[workerId] = {}; absencesMap[workerId][day.date] = day.code; }
                if (day.projectAssignmentWorkerId) { workerAssignmentMap[String(day.projectAssignmentWorkerId)] = workerId; }
            });
        }
    });
    return { staff: Array.from(staffMap.values()), absences: absencesMap, workerAssignmentMap: workerAssignmentMap };
}
async function fetchHolidays() {
    try {
        const currentYear = new Date().getFullYear();
        const yearsToFetch = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1, currentYear + 2];
        const holidays = {};
        const results = await Promise.all(yearsToFetch.map(function(year) {
            return fetch(HOLIDAYS_BASE + '/' + year + '.json').then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
        }));
        results.forEach(function(yearData, idx) {
            const year = yearsToFetch[idx];
            if (yearData && typeof yearData === 'object' && !Array.isArray(yearData)) {
                Object.entries(yearData).forEach(function(entry) { holidays[entry[0]] = entry[1]; });
            } else if (Array.isArray(yearData)) {
                yearData.forEach(function(h) { if (h.date) holidays[h.date] = h.nom; });
            }
        });
        state.holidays = holidays;
    } catch(e) { console.error('[HOLIDAYS] Error:', e); state.holidays = {}; }
}

function _rebuildSchoolHolidays() {
  const holidays = {};
  const parseLocalDate = function(str) { const parts = str.substring(0, 10).split('-'); return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])); };
  _schoolHolidaysCache.forEach(function(records) {
    records.forEach(function(rec) {
      if (!rec.start_date || !rec.end_date) return;
      const start = parseLocalDate(rec.start_date);
      const end = parseLocalDate(rec.end_date);
      const desc = rec.description || 'Vacances scolaires';
      for (var d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const iso = fmtISO(new Date(d));
        if (!holidays[iso]) holidays[iso] = [];
        if (holidays[iso].indexOf(desc) === -1) holidays[iso].push(desc);
      }
    });
  });
  state.schoolHolidays = holidays;
}

async function fetchSchoolHolidays(targetMonth) {
  try {
    var zones = [];
    Object.entries(state.config.schoolHolidayZones || {}).forEach(function(entry) { if (entry[1]) zones.push(entry[0]); });
    if (zones.length === 0) { state.schoolHolidays = {}; return; }
    var month = targetMonth || state.absMonth;
    var y = month.getFullYear();
    var m = month.getMonth();
    var scholYear = function(d) { var yr = d.getFullYear(), mo = d.getMonth(); return mo >= 8 ? yr + '-' + (yr + 1) : (yr - 1) + '-' + yr; };
    var monthsToCheck = [ new Date(y, m - 1, 1), new Date(y, m, 1), new Date(y, m + 1, 1) ];
    var anneesNeeded = [];
    monthsToCheck.forEach(function(d) { var sy = scholYear(d); if (anneesNeeded.indexOf(sy) === -1) anneesNeeded.push(sy); });
    var requestsToMake = [];
    zones.forEach(function(zone) {
      anneesNeeded.forEach(function(annee) {
        var cacheKey = zone + '_' + annee;
        if (!_schoolHolidaysCache.has(cacheKey)) {
          var fetchAllPages = async function() {
            var allRecords = [];
            var offset = 0;
            var limit = 100;
            while (true) {
              var url = SCHOOL_HOLIDAYS_API + '?refine=zones%3A%22Zone%20' + zone + '%22&refine=annee_scolaire%3A%22' + annee + '%22&limit=' + limit + '&offset=' + offset + '&timezone=Europe%2FParis';
              var data = null;
              try { var r = await fetch(url); if (r.ok) data = await r.json(); } catch(e) { }
              if (!data) break;
              var records = data.results || [];
              var filtered = records.filter(function(rec) { var pop = (rec.population || '').trim().toLowerCase(); return pop === '' || pop === 'élèves' || pop === 'tous' || pop.indexOf('enseignant') === -1; });
              allRecords = allRecords.concat(filtered);
              if (records.length < limit) break;
              offset += limit;
            }
            return allRecords;
          };
          requestsToMake.push(fetchAllPages().then(function(records) { return { cacheKey: cacheKey, records: records }; }));
        }
      });
    });
    if (requestsToMake.length === 0) { _rebuildSchoolHolidays(); return; }
    var results = await Promise.all(requestsToMake);
    results.forEach(function(item) { _schoolHolidaysCache.set(item.cacheKey, item.records); });
    _rebuildSchoolHolidays();
  } catch(e) { console.error('[SCHOOL_HOLIDAYS] Error:', e); if (!state.schoolHolidays || Object.keys(state.schoolHolidays).length === 0) { state.schoolHolidays = {}; } }
}

function resetSchoolHolidaysCache() { _schoolHolidaysCache.clear(); state.schoolHolidays = {}; }

function savePlanningRemote() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async function() {
    if (_remoteSupported === false) { showSyncStatus('offline'); return; }
    try {
      var payload = { type: 'savePlanning', planning: state.planning, planningModified: state.planningModified, config: state.config };
      var r = await fetch(PLAN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var data = await r.json();
      if (data.ok) { _remoteSupported = true; showSyncStatus('saved'); } else { _remoteSupported = false; showSyncStatus('offline'); }
    } catch(e) { showSyncStatus('offline'); }
  }, 800);
}

async function loadPlanningRemote() {
  if (_remoteSupported === false) { showSyncStatus('offline'); return {}; }
  try {
    var r = await fetch(PLAN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'loadPlanning' }) });
    var data = await r.json();
    if (data.ok && data.planning) {
      _remoteSupported = true;
      var prefix = weekKey() + '__';
      Object.keys(data.planning).forEach(function(k) { if (k.startsWith(prefix) && !(k in state.planning)) state.planning[k] = data.planning[k]; });
      if (data.planningModified) { Object.keys(data.planningModified).forEach(function(k) { if (k.startsWith(prefix) && !(k in state.planningModified)) state.planningModified[k] = data.planningModified[k]; }); }
      if (data.config) state.config = Object.assign({}, state.config, data.config);
      showSyncStatus('loaded');
      return data;
    } else { _remoteSupported = false; showSyncStatus('offline'); return {}; }
  } catch(e) { showSyncStatus('offline'); return {}; }
}

function showSyncStatus(status) {
  var el = document.getElementById('sync-status');
  if (!el) return;
  var map = { saved: { icon: '☁️', text: 'Sauvegardé', color: 'var(--accent)' }, loaded: { icon: '☁️', text: 'Synchronisé', color: 'var(--accent)' }, offline: { icon: '💾', text: 'Local uniquement', color: 'var(--text3)' }, error: { icon: '⚠️', text: 'Erreur sync', color: 'var(--warn)' }, saving: { icon: '⏳', text: 'Sauvegarde…', color: 'var(--text2)' } };
  var s = map[status] || map.offline;
  el.innerHTML = '<span style="color:' + s.color + ';font-size:0.65rem;font-weight:700;">' + s.icon + ' ' + s.text + '</span>';
}

function buildSlotsFromNavires(naviresData) {
    var i, secId;
    for(i=0; i<7; i++) { state.slots[i] = {}; for(var j=0; j<SECTIONS_ORDER.length; j++) { state.slots[i][SECTIONS_ORDER[j]] = []; } }
    naviresData.forEach(function(dayData) {
        if (!dayData || !dayData.postes) return;
        var dateObj = new Date(dayData.date);
        var dayIdx = Math.floor((dateObj - state.weekStart) / (1000 * 60 * 60 * 24));
        if (dayIdx < 0 || dayIdx > 6) return;
        dayData.postes.forEach(function(p) {
            if (!p.poste || !p.poste.code) return;
            var posteCode = p.poste.code;
            if (!p.projectAssignments || p.projectAssignments.length === 0) return;
            var parcAssignments = p.projectAssignments.filter(function(pa) { return pa.sectorId === 25; });
            if (parcAssignments.length === 0) return;
            parcAssignments.forEach(function(pa) {
                if (!pa.projectAssignmentWorkers) return;
                var projectName = pa.project ? pa.project.name : '';
                pa.projectAssignmentWorkers.forEach(function(w) {
                    var jobCode = w.job ? w.job.code : 'UNK';
                    var secId = findSectionForWorker(jobCode, posteCode, projectName);
                    var slotId = 'slot_' + pa.id + '_' + w.id;
                    state.slots[dayIdx][secId].push({ id: slotId, label: jobCode, jobCode: jobCode, posteCode: posteCode, projectName: projectName, assignmentId: pa.id, workerAssignmentId: String(w.id) });
                });
            });
        });
    });
}

function _multisetEqual(a, b) { if (a.length !== b.length) return false; var sa = a.slice().sort(), sb = b.slice().sort(); for(var i=0; i<sa.length; i++) { if (sa[i] !== sb[i]) return false; } return true; }

function applyAPIMergeRules() {
    state.slotApiMap = {};
    var today = new Date(); today.setHours(0, 0, 0, 0);
    var tomorrow = addDays(today, 1);
    for (var dayIdx = 0; dayIdx < 7; dayIdx++) {
        var daySlots = state.slots[dayIdx] || {};
        var dayDate = addDays(state.weekStart, dayIdx);
        var isBeyondTomorrow = dayDate > tomorrow;
        SECTIONS_ORDER.forEach(function(secId) {
            var slots = daySlots[secId] || [];
            if (slots.length === 0) return;
            var groupKv = [], groupApi = [];
            var groupAllResolved = true;
            slots.forEach(function(slot) {
                var key = gkey(dayIdx + '_' + secId + '_' + slot.id);
                var rawApiId = slot.workerAssignmentId ? String(slot.workerAssignmentId) : null;
                var apiWorkerId = rawApiId ? (state.workerAssignmentMap[rawApiId] || null) : null;
                var kvWorkerId = state.planning[key];
                if (apiWorkerId) { groupKv.push(kvWorkerId || ''); groupApi.push(apiWorkerId); } else { groupAllResolved = false; }
            });
            var isPurePermutation = !isBeyondTomorrow && groupAllResolved && slots.length === groupApi.length && groupKv.every(function(id) { return id !== ''; }) && _multisetEqual(groupKv, groupApi);
            slots.forEach(function(slot) {
                var key = gkey(dayIdx + '_' + secId + '_' + slot.id);
                var rawApiId = slot.workerAssignmentId ? String(slot.workerAssignmentId) : null;
                var apiWorkerId = rawApiId ? (state.workerAssignmentMap[rawApiId] || null) : null;
                var apiHasId = rawApiId && rawApiId !== 'undefined' && rawApiId !== '0';
                var kvWorkerId = state.planning[key];
                if (isPurePermutation) { state.slotApiMap[key] = apiWorkerId; delete state.planningModified[key]; return; }
                if (!isBeyondTomorrow && apiWorkerId) {
                    state.slotApiMap[key] = apiWorkerId;
                    if (kvWorkerId && kvWorkerId !== apiWorkerId) { state.planningModified[key] = kvWorkerId; state.planning[key] = apiWorkerId; }
                    else { if (!(key in state.planningModified)) delete state.planningModified[key]; state.planning[key] = apiWorkerId; }
                } else if (!isBeyondTomorrow && apiHasId) {
                    state.slotApiMap[key] = rawApiId;
                    if (kvWorkerId && kvWorkerId !== rawApiId) { state.planningModified[key] = kvWorkerId; state.planning[key] = rawApiId; }
                    else { if (!(key in state.planningModified)) delete state.planningModified[key]; state.planning[key] = rawApiId; }
                } else {
                    if (kvWorkerId) { state.planningModified[key] = kvWorkerId; }
                    else { delete state.planningModified[key]; if (key in state.planning) delete state.planning[key]; }
                }
            });
            slots.forEach(function(slot) { var key = gkey(dayIdx + '_' + secId + '_' + slot.id); if (state.planningModified[key] !== undefined && state.planningModified[key] === state.planning[key]) { delete state.planningModified[key]; } });
        });
    }
}

async function loadAllData() {
    var dateStart = fmtISO(state.weekStart);
    var dateEnd = fmtISO(addDays(state.weekStart, 6));
    var naviresData = await fetchNavires(dateStart, dateEnd);
    buildSlotsFromNavires(naviresData);
    var results = await Promise.all([ loadPlanningRemote(), fetchPersonnel(dateStart, dateEnd) ]);
    var parsed = parsePersonnelData(results[1], dateStart, dateEnd);
    state.staff = parsed.staff;
    state.absences = parsed.absences;
    state.workerAssignmentMap = parsed.workerAssignmentMap;
    applyAPIMergeRules();
    savePlanningRemote();
}

async function loadAbsencesForMonth(monthDate) {
    var year = monthDate.getFullYear();
    var month = monthDate.getMonth();
    var startOfMonth = new Date(year, month, 1);
    var endOfMonth = new Date(year, month + 1, 0);
    var dateStart = fmtISO(startOfMonth);
    var dateEnd = fmtISO(endOfMonth);
    console.log('[loadAbsencesForMonth] Période:', dateStart, '→', dateEnd, '| Jours:', endOfMonth.getDate());
    var personnelData = await fetchPersonnel(dateStart, dateEnd);
    var parsed = parsePersonnelData(personnelData, dateStart, dateEnd);
    state.staff = parsed.staff;
    state.absences = parsed.absences;
    state.workerAssignmentMap = parsed.workerAssignmentMap;
}

function showConfigModal(module) {
  var overlay = document.getElementById('cfg-overlay');
  var sidebar = document.getElementById('cfg-sidebar');
  if (overlay) overlay.classList.add('open');
  if (sidebar) sidebar.classList.add('open');
  if (module && module !== 'mail') openCfgModule(module);
}

function closeCfgSidebar() {
  var sidebar = document.getElementById('cfg-sidebar');
  var overlay = document.getElementById('cfg-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  closeCfgSubpanel();
}

function closeCfgSubpanel() {
  var subpanel = document.getElementById('cfg-subpanel');
  if (subpanel) subpanel.classList.remove('open');
  var btns = document.querySelectorAll('.cfg-module-btn');
  btns.forEach(function(b) { b.classList.remove('active'); });
  _cfgActiveModule = null;
}

function openCfgModule(module) {
  _cfgActiveModule = module;
  var btns = document.querySelectorAll('.cfg-module-btn');
  btns.forEach(function(b) { b.classList.toggle('active', b.dataset.module === module); });
  var titles = { mail: 'Emails', personnel: 'Groupes', absences: 'Membres', vacances: 'Vacances scolaires' };
  var titleEl = document.getElementById('cfg-subpanel-title');
  if (titleEl) titleEl.textContent = titles[module] || module;
  var body = document.getElementById('cfg-subpanel-body');
  var footer = document.getElementById('cfg-subpanel-footer');
  if (!body || !footer) return;
  if (module === 'mail') {
    body.innerHTML = '<div class="modal-label">Email destinataires</div><input class="modal-input" id="cfg-email-week" value="' + state.config.emailWeek + '" style="width:100%;margin-bottom:12px;"><div class="modal-label">Copie (CC)</div><input class="modal-input" id="cfg-cc-week" value="' + state.config.emailCcWeek + '" style="width:100%;">';
    footer.innerHTML = '<button class="modal-btn modal-btn-ok" onclick="saveConfig()">Enregistrer</button>';
  } else if (module === 'personnel') {
    var staffRows = state.staff.map(function(w) { var current = state.config.workerColors?.[w.id] || ''; var swatches = WORKER_COLORS.map(function(c) { return '<div class="cfg-swatch' + (current === c.key ? ' selected' : '') + '" style="background:' + c.hex + '" title="' + c.key + '" onclick="setWorkerColor(\'' + w.id + '\',\'' + c.key + '\',this)"></div>'; }).join(''); return '<div class="cfg-staff-row"><div class="cfg-staff-name">' + w.lastName + ' ' + w.firstName + '</div><div class="cfg-colors">' + swatches + '<div class="cfg-swatch-reset" title="Effacer" onclick="setWorkerColor(\'' + w.id + '\',\'\',this)">✕</div></div></div>'; }).join('');
    body.innerHTML = '<div class="cfg-staff-list">' + (staffRows || '<div style="color:var(--text3);font-size:0.75rem;padding:10px 0">Aucun personnel chargé</div>') + '</div>';
    footer.innerHTML = '';
  } else if (module === 'absences') {
    body.innerHTML = '<div style="font-size:0.7rem;color:var(--text3);margin-bottom:10px;">Glissez les membres pour définir l\'ordre d\'affichage. Activez l\'impression PDF pour chaque membre.</div><div id="cfg-abs-list" style="display:flex;flex-direction:column;gap:4px;">' + buildAbsConfigRows() + '</div>';
    footer.innerHTML = '<button class="modal-btn modal-btn-ok" onclick="saveAbsConfig()">Enregistrer</button>';
    setTimeout(initAbsDragDrop, 100);
  } else if (module === 'vacances') {
    var zoneNames = { A: 'Zone A — Besançon, Bordeaux, Clermont-Ferrand, Dijon, Grenoble, Limoges, Lyon, Poitiers', B: 'Zone B — Aix-Marseille, Amiens, Caen, Lille, Nancy-Metz, Nantes, Nice, Normandie, Orléans-Tours, Reims, Rennes, Rouen, Strasbourg', C: 'Zone C — Créteil, Montpellier, Paris, Toulouse, Versailles' };
    var zonesHtml = ['A','B','C'].map(function(zone) { var checked = state.config.schoolHolidayZones?.[zone] ? 'checked' : ''; return '<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border-radius:8px;background:var(--surface);border:1px solid var(--border2);margin-bottom:8px;"><input type="checkbox" id="cfg-zone-' + zone + '" ' + checked + ' style="accent-color:var(--red);width:15px;height:15px;margin-top:1px;flex-shrink:0;"><div><div style="font-size:0.78rem;font-weight:700;color:var(--text);margin-bottom:3px;">Zone ' + zone + '</div><div style="font-size:0.62rem;color:var(--text3);line-height:1.4;">' + zoneNames[zone] + '</div></div></label>'; }).join('');
    body.innerHTML = '<div style="font-size:0.7rem;color:var(--text3);margin-bottom:14px;">Sélectionnez les zones scolaires à afficher.</div>' + zonesHtml + '<div style="padding:8px 10px;border-radius:6px;background:rgba(255,77,109,0.08);border:1px solid rgba(255,77,109,0.2);"><div style="font-size:0.65rem;color:var(--red);font-weight:700;">🏖 Normandie → Zone B (cochée par défaut)</div></div>';
    footer.innerHTML = '<button class="modal-btn modal-btn-ok" onclick="saveVacancesConfig()">Enregistrer</button>';
  }
  var subpanel = document.getElementById('cfg-subpanel');
  if (subpanel) subpanel.classList.add('open');
}

function buildAbsConfigRows() {
  var order = state.config.absOrder || [];
  var printSet = new Set(state.config.absPrint !== undefined ? state.config.absPrint : state.staff.map(function(w) { return w.id; }));
  var sorted = [];
  order.forEach(function(id) { var w = state.staff.find(function(x) { return x.id === id; }); if (w) sorted.push(w); });
  var newMembers = state.staff.filter(function(w) { return order.indexOf(w.id) === -1; }).sort(function(a, b) { return (a.lastName + ' ' + a.firstName).localeCompare(b.lastName + ' ' + b.firstName, 'fr'); });
  var allSorted = sorted.concat(newMembers);
  return allSorted.map(function(w) {
    var colorKey = state.config.workerColors?.[w.id];
    var colorMap = { rouge:'#ff4d6d', violet:'#a78bfa', vert:'#00c896', bleu:'#3b8fff', jaune:'#ffd060' };
    var borderColor = colorKey ? colorMap[colorKey] : 'var(--border2)';
    var isNew = order.indexOf(w.id) === -1;
    var checked = (!isNew && printSet.has(w.id)) ? 'checked' : '';
    return '<div class="cfg-abs-row" data-id="' + w.id + '" draggable="true" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;background:var(--surface2);border:1px solid ' + borderColor + ';cursor:grab;user-select:none;"><span style="color:var(--text3);font-size:0.8rem;cursor:grab;">⠿</span><div style="flex:1;min-width:0;"><div style="font-size:0.73rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + w.lastName + ' ' + w.firstName + '</div><div style="font-size:0.6rem;color:var(--text3);font-family:\'DM Mono\',monospace;">' + (w.matricule || '—') + '</div></div><label style="display:flex;align-items:center;gap:5px;font-size:0.68rem;color:var(--text2);white-space:nowrap;cursor:pointer;"><input type="checkbox" ' + checked + ' data-print="' + w.id + '" style="accent-color:var(--accent);width:13px;height:13px;"> PDF</label></div>';
  }).join('');
}

function initAbsDragDrop() {
  var list = document.getElementById('cfg-abs-list');
  if (!list) return;
  var dragging = null;
  list.querySelectorAll('.cfg-abs-row').forEach(function(row) {
    row.addEventListener('dragstart', function(e) { dragging = row; setTimeout(function() { row.style.opacity = '0.4'; }, 0); });
    row.addEventListener('dragend', function() { dragging = null; row.style.opacity = '1'; });
    row.addEventListener('dragover', function(e) { e.preventDefault(); if (dragging && dragging !== row) { var r = row.getBoundingClientRect(); var mid = r.top + r.height / 2; list.insertBefore(dragging, e.clientY < mid ? row : row.nextSibling); } });
  });
}

window.saveAbsConfig = function() {
  var list = document.getElementById('cfg-abs-list');
  if (!list) return;
  var allRows = Array.from(list.querySelectorAll('.cfg-abs-row'));
  var printIds = new Set(allRows.filter(function(r) { return r.querySelector('[data-print]').checked; }).map(function(r) { return r.dataset.id; }));
  var withPrint = allRows.filter(function(r) { return printIds.has(r.dataset.id); }).map(function(r) { return r.dataset.id; });
  var withoutPrint = allRows.filter(function(r) { return !printIds.has(r.dataset.id); }).map(function(r) { return r.dataset.id; }).sort(function(a, b) { var wa = state.staff.find(function(w) { return w.id === a; }); var wb = state.staff.find(function(w) { return w.id === b; }); var na = wa ? wa.lastName + ' ' + wa.firstName : a; var nb = wb ? wb.lastName + ' ' + wb.firstName : b; return na.localeCompare(nb, 'fr'); });
  state.config.absOrder = withPrint.concat(withoutPrint);
  state.config.absPrint = Array.from(printIds);
  saveState();
  closeCfgSubpanel();
  toast('Configuration absences sauvegardée');
};

window.setWorkerColor = function(workerId, colorKey, el) {
  if (!state.config.workerColors) state.config.workerColors = {};
  if (colorKey) { state.config.workerColors[workerId] = colorKey; } else { delete state.config.workerColors[workerId]; }
  saveState();
  var row = el.closest('.cfg-staff-row');
  if (row) { row.querySelectorAll('.cfg-swatch').forEach(function(s) { s.classList.remove('selected'); }); if (colorKey) el.classList.add('selected'); }
  toast('Couleur sauvegardée');
};

window.saveVacancesConfig = async function() {
  if (!state.config.schoolHolidayZones) state.config.schoolHolidayZones = {};
  ['A','B','C'].forEach(function(zone) { var cb = document.getElementById('cfg-zone-' + zone); if (cb) state.config.schoolHolidayZones[zone] = cb.checked; });
  saveState();
  closeCfgSubpanel();
  toast('Chargement des vacances scolaires…');
  resetSchoolHolidaysCache();
  await fetchSchoolHolidays(state.absMonth);
  toast('Vacances scolaires mises à jour ✓');
};

window.saveConfig = function() {
  var emailWeek = document.getElementById('cfg-email-week');
  var emailCcWeek = document.getElementById('cfg-cc-week');
  if (emailWeek) state.config.emailWeek = emailWeek.value;
  if (emailCcWeek) state.config.emailCcWeek = emailCcWeek.value;
  saveState();
  closeCfgSubpanel();
  toast('Configuration sauvegardée');
};

async function generatePDF(dayIdx) {
    var jsPDF = window.jspdf;
    if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return; }
    var doc = new jsPDF();
    var wn = getWeekNum(state.weekStart);
    var title = '', fileName = '', rows = [];
    var sectionsMap = getSectionsMap();
    if (dayIdx === null || dayIdx === undefined) {
        title = 'Effectif Parc Roulier - Semaine ' + wn;
        fileName = 'Planning_Reception_Semaine' + wn + '.pdf';
        for(var i=0; i<7; i++) {
            rows.push([DAYS[i] + ' ' + fmtFR(addDays(state.weekStart, i)), '']);
            SECTIONS_ORDER.forEach(function(secId) {
                var sec = sectionsMap[secId];
                var slots = state.slots[i] ? state.slots[i][secId] : [];
                slots.forEach(function(s) { var w = getWorker(state.planning[gkey(i + '_' + secId + '_' + s.id)]); rows.push(['  ' + sec.name + ' (' + s.label + ')', w ? w.lastName + ' ' + w.firstName : 'Non affecté']); });
            });
            rows.push([]);
        }
    } else {
        var d = addDays(state.weekStart, dayIdx);
        var dateStr = d.toLocaleDateString('fr-FR', {day:'2-digit', month:'long', year:'numeric'});
        title = 'Effectif Parc Roulier - ' + DAYS[dayIdx] + ' ' + dateStr;
        fileName = 'Planning_Reception_du_' + dateStr.replace(/ /g,'_') + '.pdf';
        SECTIONS_ORDER.forEach(function(secId) {
            var sec = sectionsMap[secId];
            var slots = state.slots[dayIdx] ? state.slots[dayIdx][secId] : [];
            rows.push([sec.name, '']);
            slots.forEach(function(s) { var w = getWorker(state.planning[gkey(dayIdx + '_' + secId + '_' + s.id)]); rows.push(['  ' + s.label, w ? w.lastName + ' ' + w.firstName : 'Non affecté']); });
        });
    }
    doc.text(title, 14, 15);
    doc.autoTable({ startY: 20, head: [['Poste / Section', 'Personnel']], body: rows, theme: 'grid' });
    doc.save(fileName);
}

async function sendDailyMail(dayIdx) {
    var d = addDays(state.weekStart, dayIdx);
    var dateStr = d.toLocaleDateString('fr-FR', {weekday:'long', day:'2-digit', month:'long', year:'numeric'});
    await generatePDF(dayIdx);
    var body = 'Bonjour,\n\nCi-joint l\'effectif Parc Roulier pour le ' + dateStr + '.';
    window.open('mailto:' + state.config.emailWeek + '?cc=' + state.config.emailCcWeek + '&subject=' + encodeURIComponent('Planning Réception du ' + fmtFR(d)) + '&body=' + encodeURIComponent(body));
}

async function sendWeeklyMail() {
    var wn = getWeekNum(state.weekStart);
    await generatePDF();
    var body = 'Bonjour,\n\nCi-joint l\'effectif Parc Roulier pour la Semaine ' + wn + '.';
    window.open('mailto:' + state.config.emailWeek + '?cc=' + state.config.emailCcWeek + '&subject=' + encodeURIComponent('Planning Hebdo Semaine ' + wn) + '&body=' + encodeURIComponent(body));
}

// ── EXPORTS ──
window.sharedState = state;
window.loadState = loadState;
window.saveState = saveState;
window.fetchHolidays = fetchHolidays;
window.fetchSchoolHolidays = fetchSchoolHolidays;
window.resetSchoolHolidaysCache = resetSchoolHolidaysCache;
window.loadAllData = loadAllData;
window.loadAbsencesForMonth = loadAbsencesForMonth;
window.getWorker = getWorker;
window.getWorkerColorClass = getWorkerColorClass;
window.fmtISO = fmtISO;
window.fmtFR = fmtFR;
window.addDays = addDays;
window.getMonday = getMonday;
window.getWeekNum = getWeekNum;
window.toast = toast;
window.showModal = showModal;
window.closeModal = closeModal;
window.showConfigModal = showConfigModal;
window.closeCfgSidebar = closeCfgSidebar;
window.openCfgModule = openCfgModule;
window.closeCfgSubpanel = closeCfgSubpanel;
window.buildAbsConfigRows = buildAbsConfigRows;
window.initAbsDragDrop = initAbsDragDrop;
window.setWorkerColor = setWorkerColor;
window.saveConfig = saveConfig;
window.saveVacancesConfig = saveVacancesConfig;
window.saveAbsConfig = saveAbsConfig;
window.generatePDF = generatePDF;
window.sendWeeklyMail = sendWeeklyMail;
window.sendDailyMail = sendDailyMail;
window.DAYS = DAYS;
window.SECTIONS_ORDER = SECTIONS_ORDER;
window.getSectionsMap = getSectionsMap;
window.gkey = gkey;
window.weekKey = weekKey;
window.TBD_WORKER = TBD_WORKER;
window.WORKER_COLORS = WORKER_COLORS;
window.showSyncStatus = showSyncStatus;
