// ═══════════════════════════════════════════════════════════════
// SHARED.JS - Logique commune aux vues Affectation et Congés
// ═══════════════════════════════════════════════════════════════

const PLAN_PROXY = "https://planning-proxy.receptionroulier.workers.dev";
const NAV_PROXY = "https://shgt-proxy.receptionroulier.workers.dev";
const HOLIDAYS_BASE = "https://calendrier.api.gouv.fr/jours-feries/metropole";
const SCHOOL_HOLIDAYS_API = 'https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records';

// ── SECTIONS & COULEURS ──
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

const TBD_WORKER = {
  id: '_tbd_', firstName: 'À', lastName: 'DÉFINIR', matricule: '—',
  color: '#94a3b8', isChief: false, isTbd: true,
};

const WORKER_COLORS = [
  { key: 'rouge',  hex: '#ff4d6d' },
  { key: 'violet', hex: '#a78bfa' },
  { key: 'vert',   hex: '#00c896' },
  { key: 'bleu',   hex: '#3b8fff' },
  { key: 'jaune',  hex: '#ffd060' },
];

// ── STATE GLOBAL ──
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

// Cache vacances scolaires
const _schoolHolidaysCache = new Map();

// ── UTILITAIRES DATE ──
function getMonday(d) {
  const r = new Date(d);
  const day = r.getDay();
  r.setDate(r.getDate() + (day === 0 ? -6 : 1 - day));
  r.setHours(0,0,0,0); return r;
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function fmtFR(d) { return d.toLocaleDateString('fr-FR', { day:'2-digit', month:'short' }); }
function getWeekNum(d) {
  const t = new Date(d); t.setHours(0,0,0,0);
  t.setDate(t.getDate() + 3 - (t.getDay()+6)%7);
  const j4 = new Date(t.getFullYear(),0,4);
  return 1 + Math.round(((t-j4)/86400000 - 3 + (j4.getDay()+6)%7)/7);
}
function weekKey() { return fmtISO(state.weekStart); }
function gkey(localKey) { return `${weekKey()}__${localKey}`; }

// ── HELPERS ──
function getWorker(id) { if (id === '_tbd_') return TBD_WORKER; return state.staff.find(w => w.id === id); }
function getWorkerColorClass(workerId) {
  const c = state.config.workerColors?.[workerId];
  return c ? `has-wcolor wcolor-${c}` : '';
}
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

// ── TOAST & MODAL ──
function toast(msg, type='ok') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.style.background = type === 'error' ? 'var(--red)' : 'var(--accent)';
  t.style.color = '#fff';
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}
function showModal(content) {
  const overlay = document.getElementById('modal-overlay');
  const modal = document.getElementById('modal-content');
  if (overlay && modal) {
    modal.innerHTML = content;
    overlay.classList.add('show');
  }
}
function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.remove('show');
}
window.closeModal = closeModal;

// ── STATE PERSISTENCE ──
function loadState() {
  try {
    const s = localStorage.getItem('planningRoulier_v21');
    if (s) {
      const saved = JSON.parse(s);
      state.planning = saved.planning || {};
      state.planningModified = saved.planningModified || {};
      state.config = {
        ...state.config,
        ...saved.config,
        workerColors: { ...(saved.config?.workerColors || {}) },
        schoolHolidayZones: { A: false, B: true, C: false, ...(saved.config?.schoolHolidayZones || {}) },
        absOrder: saved.config?.absOrder || [],
        absPrint: saved.config?.absPrint || [],
      };
      if (saved.view) state.view = saved.view;
    }
    const cw = localStorage.getItem('planningRoulier_colWidths');
    if (cw) state.colWidths = JSON.parse(cw);
    else state.colWidths = Array(7).fill(null);
  } catch(e) { console.error('[loadState]', e); state.colWidths = Array(7).fill(null); }
}
function saveState() {
  try {
    localStorage.setItem('planningRoulier_v21', JSON.stringify({
      planning: state.planning, planningModified: state.planningModified, config: state.config, view: state.view,
    }));
  } catch(e) {}
  savePlanningRemote();
}

// ── API NAVIRES ──
async function fetchNavires(dateFrom, dateTo) {
    try {
        const response = await fetch(NAV_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dateFrom, dateTo })
        });
        const data = await response.json();
        return Array.isArray(data) ? data : [];
    } catch(e) {
        console.error('[API] Error navires:', e);
        return [];
    }
}

// ── API PERSONNEL ──
async function fetchPersonnel(dateFrom, dateTo) {
    try {
        const response = await fetch(PLAN_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'workers', dateFrom, dateTo })
        });
        const data = await response.json();
        return data;
    } catch(e) {
        console.error('[API] Error personnel:', e);
        return { totalWorkers: 0, workerCalendars: [] };
    }
}

// ── PARSE PERSONNEL ──
function parsePersonnelData(personnelData, dateFrom, dateTo) {
    const staffMap = new Map();
    const absencesMap = {};
    const workerAssignmentMap = {};

    if (!personnelData || !personnelData.workerCalendars) {
        return { staff: [], absences: {}, workerAssignmentMap: {} };
    }

    personnelData.workerCalendars.forEach(wc => {
        const workerId = String(wc.workerId);
        if (!staffMap.has(workerId)) {
            const rawFirst = wc.firstName || '';
            const capitalFirst = rawFirst.charAt(0).toUpperCase() + rawFirst.slice(1).toLowerCase();
            staffMap.set(workerId, {
                id: workerId,
                firstName: capitalFirst,
                lastName: (wc.lastName || '').toUpperCase(),
                matricule: wc.dockerMatricule || '',
                isChief: wc.isChief || false
            });
        }
        if (wc.days) {
            wc.days.forEach(day => {
                if (!day.date) return;
                if (day.isAbsence && day.code) {
                    if (!absencesMap[workerId]) absencesMap[workerId] = {};
                    absencesMap[workerId][day.date] = day.code;
                }
                if (day.projectAssignmentWorkerId) {
                    workerAssignmentMap[String(day.projectAssignmentWorkerId)] = workerId;
                }
            });
        }
    });

    return { staff: Array.from(staffMap.values()), absences: absencesMap, workerAssignmentMap: workerAssignmentMap };
}

// ── FETCH JOURS FÉRIÉS ──
async function fetchHolidays() {
    try {
        const currentYear = new Date().getFullYear();
        const yearsToFetch = [currentYear - 2, currentYear - 1, currentYear, currentYear + 1, currentYear + 2];
        const holidays = {};
        const results = await Promise.all(
            yearsToFetch.map(year =>
                fetch(`${HOLIDAYS_BASE}/${year}.json`)
                    .then(r => r.ok ? r.json() : [])
                    .catch(() => [])
            )
        );
        results.forEach((yearData, idx) => {
            const year = yearsToFetch[idx];
            if (yearData && typeof yearData === 'object' && !Array.isArray(yearData)) {
                Object.entries(yearData).forEach(([date, nom]) => { holidays[date] = nom; });
            } else if (Array.isArray(yearData)) {
                yearData.forEach(h => { if (h.date) holidays[h.date] = h.nom; });
            }
        });
        state.holidays = holidays;
    } catch(e) {
        console.error('[HOLIDAYS] Error:', e);
        state.holidays = {};
    }
}

// ── FETCH VACANCES SCOLAIRES ──
function _rebuildSchoolHolidays() {
  const holidays = {};
  const parseLocalDate = (str) => {
    const [y, mo, da] = str.substring(0, 10).split('-').map(Number);
    return new Date(y, mo - 1, da);
  };
  for (const records of _schoolHolidaysCache.values()) {
    records.forEach(({ start_date, end_date, description }) => {
      if (!start_date || !end_date) return;
      const start = parseLocalDate(start_date);
      const end   = parseLocalDate(end_date);
      const desc  = description || 'Vacances scolaires';
      for (let d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        const iso = fmtISO(new Date(d));
        if (!holidays[iso]) holidays[iso] = [];
        if (!holidays[iso].includes(desc)) holidays[iso].push(desc);
      }
    });
  }
  state.schoolHolidays = holidays;
}

async function fetchSchoolHolidays(targetMonth) {
  try {
    const zones = Object.entries(state.config.schoolHolidayZones || {})
      .filter(([, enabled]) => enabled)
      .map(([z]) => z);
    if (zones.length === 0) { state.schoolHolidays = {}; return; }

    const month = targetMonth || state.absMonth;
    const y = month.getFullYear();
    const m = month.getMonth();

    const scholYear = (d) => {
      const yr = d.getFullYear(), mo = d.getMonth();
      return mo >= 8 ? `${yr}-${yr + 1}` : `${yr - 1}-${yr}`;
    };

    const monthsToCheck = [
      new Date(y, m - 1, 1),
      new Date(y, m, 1),
      new Date(y, m + 1, 1),
    ];
    const anneesNeeded = [...new Set(monthsToCheck.map(scholYear))];

    const requestsToMake = [];
    zones.forEach(zone => {
      anneesNeeded.forEach(annee => {
        const cacheKey = `${zone}_${annee}`;
        if (!_schoolHolidaysCache.has(cacheKey)) {
          const fetchAllPages = async () => {
            const allRecords = [];
            let offset = 0;
            const limit = 100;
            while (true) {
              const url = `${SCHOOL_HOLIDAYS_API}?refine=zones%3A%22Zone%20${zone}%22&refine=annee_scolaire%3A%22${annee}%22&limit=${limit}&offset=${offset}&timezone=Europe%2FParis`;
              let data = null;
              try {
                const r = await fetch(url);
                if (r.ok) data = await r.json();
              } catch(e) { /* ignore */ }
              if (!data) break;
              const records = data.results || [];
              const filtered = records.filter(rec => {
                const pop = (rec.population || '').trim().toLowerCase();
                return pop === '' || pop === 'élèves' || pop === 'tous' || !pop.includes('enseignant');
              });
              allRecords.push(...filtered);
              if (records.length < limit) break;
              offset += limit;
            }
            return allRecords;
          };
          requestsToMake.push(fetchAllPages().then(records => ({ cacheKey, records })));
        }
      });
    });

    if (requestsToMake.length === 0) {
      _rebuildSchoolHolidays();
      return;
    }

    const results = await Promise.all(requestsToMake);
    results.forEach(({ cacheKey, records }) => {
      _schoolHolidaysCache.set(cacheKey, records);
    });

    _rebuildSchoolHolidays();
  } catch(e) {
    console.error('[SCHOOL_HOLIDAYS] Error:', e);
    if (!state.schoolHolidays || Object.keys(state.schoolHolidays).length === 0) {
      state.schoolHolidays = {};
    }
  }
}

function resetSchoolHolidaysCache() {
  _schoolHolidaysCache.clear();
  state.schoolHolidays = {};
}

// ── SYNC DISTANTE ──
let _saveTimer = null;
let _remoteSupported = null;

function savePlanningRemote() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(async () => {
    if (_remoteSupported === false) { showSyncStatus('offline'); return; }
    try {
      const payload = { type: 'savePlanning', planning: state.planning, planningModified: state.planningModified, config: state.config };
      const r = await fetch(PLAN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (data.ok) {
        _remoteSupported = true;
        showSyncStatus('saved');
      } else {
        _remoteSupported = false;
        showSyncStatus('offline');
      }
    } catch(e) {
      showSyncStatus('offline');
    }
  }, 800);
}

async function loadPlanningRemote() {
  if (_remoteSupported === false) { showSyncStatus('offline'); return {}; }
  try {
    const r = await fetch(PLAN_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'loadPlanning' }) });
    const data = await r.json();
    if (data.ok && data.planning) {
      _remoteSupported = true;
      const prefix = weekKey() + '__';
      Object.keys(data.planning).forEach(k => {
        if (k.startsWith(prefix)) {
          if (!(k in state.planning)) state.planning[k] = data.planning[k];
        }
      });
      if (data.planningModified) {
        Object.keys(data.planningModified).forEach(k => {
          if (k.startsWith(prefix)) {
            if (!(k in state.planningModified)) state.planningModified[k] = data.planningModified[k];
          }
        });
      }
      if (data.config) state.config = { ...state.config, ...data.config };
      showSyncStatus('loaded');
      return data;
    } else {
      _remoteSupported = false;
      showSyncStatus('offline');
      return {};
    }
  } catch(e) {
    showSyncStatus('offline');
    return {};
  }
}

function showSyncStatus(status) {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const map = {
    saved: { icon: '☁️', text: 'Sauvegardé', color: 'var(--accent)' },
    loaded: { icon: '☁️', text: 'Synchronisé', color: 'var(--accent)' },
    offline: { icon: '💾', text: 'Local uniquement', color: 'var(--text3)' },
    error: { icon: '⚠️', text: 'Erreur sync', color: 'var(--warn)' },
    saving: { icon: '⏳', text: 'Sauvegarde…', color: 'var(--text2)' },
  };
  const s = map[status] || map.offline;
  el.innerHTML = `<span style="color:${s.color};font-size:0.65rem;font-weight:700;">${s.icon} ${s.text}</span>`;
}

// ── BUILD SLOTS FROM NAVIRES ──
function buildSlotsFromNavires(naviresData) {
    for(let i=0; i<7; i++) {
        state.slots[i] = {};
        SECTIONS_ORDER.forEach(secId => { state.slots[i][secId] = []; });
    }
    naviresData.forEach(dayData => {
        if (!dayData || !dayData.postes) return;
        const dateObj = new Date(dayData.date);
        const dayIdx = Math.floor((dateObj - state.weekStart) / (1000 * 60 * 60 * 24));
        if (dayIdx < 0 || dayIdx > 6) return;
        dayData.postes.forEach(p => {
            if (!p.poste || !p.poste.code) return;
            const posteCode = p.poste.code;
            if (!p.projectAssignments || p.projectAssignments.length === 0) return;
            const parcAssignments = p.projectAssignments.filter(pa => pa.sectorId === 25);
            if (parcAssignments.length === 0) return;
            parcAssignments.forEach(pa => {
                if (!pa.projectAssignmentWorkers) return;
                const projectName = pa.project?.name || '';
                pa.projectAssignmentWorkers.forEach(w => {
                    const jobCode = w.job?.code || 'UNK';
                    const secId = findSectionForWorker(jobCode, posteCode, projectName);
                    const slotId = `slot_${pa.id}_${w.id}`;
                    state.slots[dayIdx][secId].push({
                        id: slotId,
                        label: jobCode,
                        jobCode: jobCode,
                        posteCode: posteCode,
                        projectName: projectName,
                        assignmentId: pa.id,
                        workerAssignmentId: String(w.id)
                    });
                });
            });
        });
    });
}

// ── MERGE PLANNING WITH API ──
function _multisetEqual(a, b) {
    if (a.length !== b.length) return false;
    const sa = [...a].sort(), sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
}

function applyAPIMergeRules() {
    state.slotApiMap = {};
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = addDays(today, 1);

    for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const daySlots = state.slots[dayIdx] || {};
        const dayDate = addDays(state.weekStart, dayIdx);
        const isBeyondTomorrow = dayDate > tomorrow;

        SECTIONS_ORDER.forEach(secId => {
            const slots = daySlots[secId] || [];
            if (slots.length === 0) return;

            const groupKv  = [];
            const groupApi = [];
            let groupAllResolved = true;

            slots.forEach(slot => {
                const key = gkey(`${dayIdx}_${secId}_${slot.id}`);
                const rawApiId = slot.workerAssignmentId ? String(slot.workerAssignmentId) : null;
                const apiWorkerId = rawApiId ? (state.workerAssignmentMap[rawApiId] || null) : null;
                const kvWorkerId = state.planning[key];
                if (apiWorkerId) {
                    groupKv.push(kvWorkerId || '');
                    groupApi.push(apiWorkerId);
                } else {
                    groupAllResolved = false;
                }
            });

            const isPurePermutation = !isBeyondTomorrow && groupAllResolved
                && slots.length === groupApi.length*_
