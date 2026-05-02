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
  absences: {},        // absences API (source RH)
  manualConges: {},    // congés posés manuellement { workerId: { dateISO: code } }
  mergedAbsences: {},  // fusion API + manuels (API prime)
  holidays: {},
  schoolHolidays: {},
  config: {
    emailWeek: 'chefmanutention.tmt@shgt.fr',
    emailCcWeek: 'smaillard@smr-france.com',
    emailBccWeek: '',
    pdfPathDaily: '',
    pdfPathWeekly: '',
    pdfPathConges: '',
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
  t.style.background = type === 'error' ? 'var(--red)' : type === 'info' ? 'var(--surface2)' : 'var(--accent)';
  t.style.color = type === 'info' ? 'var(--text2)' : '#fff';
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
        console.log('[fetchPersonnel] Appel API:', dateFrom, '→', dateTo);
        const response = await fetch(PLAN_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'workers', dateFrom, dateTo })
        });
        const data = await response.json();
        console.log('[fetchPersonnel] Réponse API:', data);
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
        console.log('[parsePersonnelData] Aucune donnée personnel');
        return { staff: [], absences: {}, workerAssignmentMap: {} };
    }

    console.log('[parsePersonnelData] Workers reçus:', personnelData.workerCalendars.length);

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
            console.log('[parsePersonnelData] Worker', workerId, 'days:', wc.days.length);
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
                && slots.length === groupApi.length
                && groupKv.every(id => id !== '')
                && _multisetEqual(groupKv, groupApi);

            slots.forEach(slot => {
                const key = gkey(`${dayIdx}_${secId}_${slot.id}`);
                const rawApiId = slot.workerAssignmentId ? String(slot.workerAssignmentId) : null;
                const apiWorkerId = rawApiId ? (state.workerAssignmentMap[rawApiId] || null) : null;
                const apiHasId = rawApiId && rawApiId !== 'undefined' && rawApiId !== '0';
                const kvWorkerId = state.planning[key];

                if (isPurePermutation) {
                    state.slotApiMap[key] = apiWorkerId;
                    delete state.planningModified[key];
                    return;
                }

                if (!isBeyondTomorrow && apiWorkerId) {
                    state.slotApiMap[key] = apiWorkerId;
                    if (kvWorkerId && kvWorkerId !== apiWorkerId) {
                        state.planningModified[key] = kvWorkerId;
                        state.planning[key] = apiWorkerId;
                    } else {
                        if (!(key in state.planningModified)) delete state.planningModified[key];
                        state.planning[key] = apiWorkerId;
                    }
                } else if (!isBeyondTomorrow && apiHasId) {
                    state.slotApiMap[key] = rawApiId;
                    if (kvWorkerId && kvWorkerId !== rawApiId) {
                        state.planningModified[key] = kvWorkerId;
                        state.planning[key] = rawApiId;
                    } else {
                        if (!(key in state.planningModified)) delete state.planningModified[key];
                        state.planning[key] = rawApiId;
                    }
                } else {
                    if (kvWorkerId) {
                        state.planningModified[key] = kvWorkerId;
                    } else {
                        delete state.planningModified[key];
                        if (key in state.planning) delete state.planning[key];
                    }
                }
            });

            slots.forEach(slot => {
                const key = gkey(`${dayIdx}_${secId}_${slot.id}`);
                if (state.planningModified[key] !== undefined && state.planningModified[key] === state.planning[key]) {
                    delete state.planningModified[key];
                }
            });
        });
    }
}

// ── LOAD ALL DATA (WEEKLY) ──
async function loadAllData() {
    const dateStart = fmtISO(state.weekStart);
    const dateEnd = fmtISO(addDays(state.weekStart, 6));

    const naviresData = await fetchNavires(dateStart, dateEnd);
    buildSlotsFromNavires(naviresData);

    const [kvResult, personnelData] = await Promise.all([
        loadPlanningRemote(),
        fetchPersonnel(dateStart, dateEnd)
    ]);

    const parsed = parsePersonnelData(personnelData, dateStart, dateEnd);
    state.staff = parsed.staff;
    state.absences = parsed.absences;
    state.workerAssignmentMap = parsed.workerAssignmentMap;

    applyAPIMergeRules();
    savePlanningRemote();
}

// ── LOAD ABSENCES FOR MONTH (CORRIGÉ) ──
async function loadAbsencesForMonth(monthDate) {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();

    const startOfMonth = new Date(year, month, 1);
    const endOfMonth = new Date(year, month + 1, 0);

    const dateStart = fmtISO(startOfMonth);
    const dateEnd = fmtISO(endOfMonth);

    console.log('[loadAbsencesForMonth] Période:', dateStart, '→', dateEnd, '| Jours:', endOfMonth.getDate());

    const personnelData = await fetchPersonnel(dateStart, dateEnd);

    console.log('[loadAbsencesForMonth] Données API:', personnelData);

    const parsed = parsePersonnelData(personnelData, dateStart, dateEnd);

    state.staff = parsed.staff;
    state.absences = parsed.absences;
    state.workerAssignmentMap = parsed.workerAssignmentMap;

    // Fusion API + manuels : API prime
    mergeAbsences();

    console.log('[loadAbsencesForMonth] Personnel:', state.staff.length, '| Absences chargées:', Object.keys(state.absences).length);
}

// ── MERGE ABSENCES API + MANUELLES ──
function mergeAbsences() {
    const merged = {};
    // Copie d'abord les manuels
    Object.entries(state.manualConges || {}).forEach(([wid, days]) => {
        if (!merged[wid]) merged[wid] = {};
        Object.entries(days).forEach(([date, code]) => {
            merged[wid][date] = code;
        });
    });
    // API prime sur tout
    Object.entries(state.absences || {}).forEach(([wid, days]) => {
        if (!merged[wid]) merged[wid] = {};
        Object.entries(days).forEach(([date, code]) => {
            merged[wid][date] = code; // écrase le manuel
        });
    });
    state.mergedAbsences = merged;
}
window.mergeAbsences = mergeAbsences;

// ── SAVE CONGES MANUELS (KV Cloudflare) ──
async function saveCongesRemote() {
    try {
        const r = await fetch(PLAN_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'saveConges', conges: state.manualConges })
        });
        const data = await r.json();
        if (data.ok) showSyncStatus('saved');
    } catch(e) { showSyncStatus('offline'); }
}

// ── LOAD CONGES MANUELS (KV Cloudflare) ──
async function loadCongesRemote() {
    try {
        const r = await fetch(PLAN_PROXY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'loadConges' })
        });
        const data = await r.json();
        if (data.ok && data.conges) {
            state.manualConges = data.conges;
        }
    } catch(e) { console.error('[loadCongesRemote]', e); }
}
window.saveCongesRemote = saveCongesRemote;
window.loadCongesRemote = loadCongesRemote;

// ── CONFIG SIDEBAR ──
let _cfgActiveModule = null;

function showConfigModal(module) {
  const overlay = document.getElementById('cfg-overlay');
  const sidebar = document.getElementById('cfg-sidebar');
  if (overlay) overlay.classList.add('open');
  if (sidebar) sidebar.classList.add('open');
  if (module && module !== 'mail') openCfgModule(module);
  // Titre cliquable pour fermer
  const title = document.getElementById('cfg-sidebar-title');
  if (title && !title._closeHandlerSet) {
    title.style.cursor = 'pointer';
    title.addEventListener('click', closeCfgSidebar);
    title._closeHandlerSet = true;
  }
}

function closeCfgSidebar() {
  const sidebar = document.getElementById('cfg-sidebar');
  const overlay = document.getElementById('cfg-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('open');
  closeCfgSubpanel();
}

function closeCfgSubpanel() {
  const subpanel = document.getElementById('cfg-subpanel');
  if (subpanel) subpanel.classList.remove('open');
  document.querySelectorAll('.cfg-module-btn').forEach(b => b.classList.remove('active'));
  _cfgActiveModule = null;
}

function openCfgModule(module) {
  _cfgActiveModule = module;
  document.querySelectorAll('.cfg-module-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.module === module);
  });

  const titles = { mail: 'Emails', personnel: 'Groupes', absences: 'Membres', vacances: 'Vacances scolaires', congetypes: 'Types de congés' };
  const titleEl = document.getElementById('cfg-subpanel-title');
  if (titleEl) titleEl.textContent = titles[module] || module;

  const body = document.getElementById('cfg-subpanel-body');
  const footer = document.getElementById('cfg-subpanel-footer');
  if (!body || !footer) return;

  if (module === 'mail') {
    body.innerHTML = `
      <div class="modal-label">Email destinataires</div>
      <input class="modal-input" id="cfg-email-week" value="${state.config.emailWeek || ''}" style="width:100%;margin-bottom:12px;">
      <div class="modal-label">Copie (CC)</div>
      <input class="modal-input" id="cfg-cc-week" value="${state.config.emailCcWeek || ''}" style="width:100%;margin-bottom:12px;">
      <div class="modal-label">Copie cachée (CCI)</div>
      <input class="modal-input" id="cfg-bcc-week" value="${state.config.emailBccWeek || ''}" style="width:100%;margin-bottom:20px;">
      <div style="font-size:0.65rem;font-weight:700;color:var(--text3);text-transform:uppercase;letter-spacing:.06em;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:14px;">&#128193; Chemins PDF par défaut</div>
      <div style="font-size:0.65rem;color:var(--text3);margin-bottom:12px;line-height:1.5;">Si le chemin est accessible, le PDF y sera enregistré automatiquement. Sinon, téléchargement classique.</div>
      <div class="modal-label">PDF Journalier</div>
      <input class="modal-input" id="cfg-path-daily" value="${state.config.pdfPathDaily || ''}" placeholder="Ex: C:\\Users\\…\\Planning\\Journalier" style="width:100%;margin-bottom:12px;font-family:'DM Mono',monospace;font-size:0.7rem;">
      <div class="modal-label">PDF Hebdomadaire</div>
      <input class="modal-input" id="cfg-path-weekly" value="${state.config.pdfPathWeekly || ''}" placeholder="Ex: C:\\Users\\…\\Planning\\Hebdo" style="width:100%;margin-bottom:12px;font-family:'DM Mono',monospace;font-size:0.7rem;">
      <div class="modal-label">PDF Congés</div>
      <input class="modal-input" id="cfg-path-conges" value="${state.config.pdfPathConges || ''}" placeholder="Ex: C:\\Users\\…\\Planning\\Congés" style="width:100%;font-family:'DM Mono',monospace;font-size:0.7rem;">
    `;
    footer.innerHTML = `<button class="modal-btn modal-btn-ok" onclick="saveConfig()">Enregistrer</button>`;
  }
  else if (module === 'personnel') {
    const staffRows = state.staff.map(w => {
      const current = state.config.workerColors?.[w.id] || '';
      const swatches = WORKER_COLORS.map(c =>
        `<div class="cfg-swatch${current === c.key ? ' selected' : ''}" style="background:${c.hex}" title="${c.key}" onclick="setWorkerColor('${w.id}','${c.key}',this)"></div>`
      ).join('');
      return `
        <div class="cfg-staff-row">
          <div class="cfg-staff-name">${w.lastName} ${w.firstName}</div>
          <div class="cfg-colors">${swatches}
            <div class="cfg-swatch-reset" title="Effacer" onclick="setWorkerColor('${w.id}','',this)">✕</div>
          </div>
        </div>`;
    }).join('');
    body.innerHTML = `<div class="cfg-staff-list">${staffRows || '<div style="color:var(--text3);font-size:0.75rem;padding:10px 0">Aucun personnel chargé</div>'}</div>`;
    footer.innerHTML = '';
  }
  else if (module === 'absences') {
    body.innerHTML = `
      <div style="font-size:0.7rem;color:var(--text3);margin-bottom:10px;">Glissez les membres pour définir l'ordre d'affichage. Activez l'impression PDF pour chaque membre.</div>
      <div id="cfg-abs-list" style="display:flex;flex-direction:column;gap:4px;">${buildAbsConfigRows()}</div>
    `;
    footer.innerHTML = `<button class="modal-btn modal-btn-ok" onclick="saveAbsConfig()">Enregistrer</button>`;
    setTimeout(initAbsDragDrop, 100);
  }
  else if (module === 'vacances') {
    const zoneNames = {
      A: 'Zone A — Besançon, Bordeaux, Clermont-Ferrand, Dijon, Grenoble, Limoges, Lyon, Poitiers',
      B: 'Zone B — Aix-Marseille, Amiens, Caen, Lille, Nancy-Metz, Nantes, Nice, Normandie, Orléans-Tours, Reims, Rennes, Rouen, Strasbourg',
      C: 'Zone C — Créteil, Montpellier, Paris, Toulouse, Versailles'
    };
    const zonesHtml = ['A','B','C'].map(zone => {
      const checked = state.config.schoolHolidayZones?.[zone] ? 'checked' : '';
      return `
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;padding:10px 12px;border-radius:8px;background:var(--surface);border:1px solid var(--border2);margin-bottom:8px;">
          <input type="checkbox" id="cfg-zone-${zone}" ${checked} style="accent-color:var(--red);width:15px;height:15px;margin-top:1px;flex-shrink:0;">
          <div>
            <div style="font-size:0.78rem;font-weight:700;color:var(--text);margin-bottom:3px;">Zone ${zone}</div>
            <div style="font-size:0.62rem;color:var(--text3);line-height:1.4;">${zoneNames[zone]}</div>
          </div>
        </label>`;
    }).join('');
    body.innerHTML = `
      <div style="font-size:0.7rem;color:var(--text3);margin-bottom:14px;">Sélectionnez les zones scolaires à afficher.</div>
      ${zonesHtml}
      <div style="padding:8px 10px;border-radius:6px;background:rgba(255,77,109,0.08);border:1px solid rgba(255,77,109,0.2);">
        <div style="font-size:0.65rem;color:var(--red);font-weight:700;">🏖 Normandie → Zone B (cochée par défaut)</div>
      </div>
    `;
    footer.innerHTML = `<button class="modal-btn modal-btn-ok" onclick="saveVacancesConfig()">Enregistrer</button>`;
  }
  else if (module === 'congetypes') {
    renderCongeTypesPanel(body, footer);
  }

  const subpanel = document.getElementById('cfg-subpanel');
  if (subpanel) subpanel.classList.add('open');
}

function buildAbsConfigRows() {
  const order = state.config.absOrder || [];
  const printSet = new Set(state.config.absPrint !== undefined ? state.config.absPrint : state.staff.map(w => w.id));

  const sorted = [...order].map(id => state.staff.find(w => w.id === id)).filter(Boolean);
  const newMembers = state.staff
    .filter(w => !order.includes(w.id))
    .sort((a, b) => `${a.lastName} ${a.firstName}`.localeCompare(`${b.lastName} ${b.firstName}`, 'fr'));

  const allSorted = [...sorted, ...newMembers];

  return allSorted.map(w => {
    const colorKey = state.config.workerColors?.[w.id];
    const colorMap = { rouge:'#ff4d6d', violet:'#a78bfa', vert:'#00c896', bleu:'#3b8fff', jaune:'#ffd060' };
    const borderColor = colorKey ? colorMap[colorKey] : 'var(--border2)';
    const isNew = !order.includes(w.id);
    const checked = (!isNew && printSet.has(w.id)) ? 'checked' : '';
    return `
      <div class="cfg-abs-row" data-id="${w.id}" draggable="true" style="display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;background:var(--surface2);border:1px solid ${borderColor};cursor:grab;user-select:none;">
        <span style="color:var(--text3);font-size:0.8rem;cursor:grab;">⠿</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.73rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${w.lastName} ${w.firstName}</div>
          <div style="font-size:0.6rem;color:var(--text3);font-family:'DM Mono',monospace;">${w.matricule || '—'}</div>
        </div>
        <label style="display:flex;align-items:center;gap:5px;font-size:0.68rem;color:var(--text2);white-space:nowrap;cursor:pointer;">
          <input type="checkbox" ${checked} data-print="${w.id}" style="accent-color:var(--accent);width:13px;height:13px;"> PDF
        </label>
      </div>`;
  }).join('');
}

function initAbsDragDrop() {
  const list = document.getElementById('cfg-abs-list');
  if (!list) return;
  let dragging = null;
  list.querySelectorAll('.cfg-abs-row').forEach(row => {
    row.addEventListener('dragstart', e => { dragging = row; setTimeout(() => row.style.opacity = '0.4', 0); });
    row.addEventListener('dragend', () => { dragging = null; row.style.opacity = '1'; });
    row.addEventListener('dragover', e => { e.preventDefault(); if (dragging && dragging !== row) { const r = row.getBoundingClientRect(); const mid = r.top + r.height / 2; list.insertBefore(dragging, e.clientY < mid ? row : row.nextSibling); } });
  });
}

window.saveAbsConfig = function() {
  const list = document.getElementById('cfg-abs-list');
  if (!list) return;
  const allRows = [...list.querySelectorAll('.cfg-abs-row')];
  const printIds = new Set(allRows.filter(r => r.querySelector('[data-print]').checked).map(r => r.dataset.id));

  const withPrint = allRows.filter(r => printIds.has(r.dataset.id)).map(r => r.dataset.id);
  const withoutPrint = allRows.filter(r => !printIds.has(r.dataset.id)).map(r => r.dataset.id)
    .sort((a, b) => {
      const wa = state.staff.find(w => w.id === a);
      const wb = state.staff.find(w => w.id === b);
      const na = wa ? `${wa.lastName} ${wa.firstName}` : a;
      const nb = wb ? `${wb.lastName} ${wb.firstName}` : b;
      return na.localeCompare(nb, 'fr');
    });

  state.config.absOrder = [...withPrint, ...withoutPrint];
  state.config.absPrint = [...printIds];
  saveState();
  closeCfgSubpanel();
  toast('Configuration absences sauvegardée');
};

window.setWorkerColor = function(workerId, colorKey, el) {
  if (!state.config.workerColors) state.config.workerColors = {};
  if (colorKey) {
    state.config.workerColors[workerId] = colorKey;
  } else {
    delete state.config.workerColors[workerId];
  }
  saveState();
  const row = el.closest('.cfg-staff-row');
  if (row) {
    row.querySelectorAll('.cfg-swatch').forEach(s => s.classList.remove('selected'));
    if (colorKey) el.classList.add('selected');
  }
  toast('Couleur sauvegardée');
};

window.saveVacancesConfig = async function() {
  if (!state.config.schoolHolidayZones) state.config.schoolHolidayZones = {};
  ['A','B','C'].forEach(zone => {
    const cb = document.getElementById(`cfg-zone-${zone}`);
    if (cb) state.config.schoolHolidayZones[zone] = cb.checked;
  });
  saveState();
  closeCfgSubpanel();
  toast('Chargement des vacances scolaires…');
  resetSchoolHolidaysCache();
  await fetchSchoolHolidays(state.absMonth);
  toast('Vacances scolaires mises à jour ✓');
};

window.saveConfig = function() {
  const emailWeek = document.getElementById('cfg-email-week');
  const emailCcWeek = document.getElementById('cfg-cc-week');
  const emailBccWeek = document.getElementById('cfg-bcc-week');
  const pathDaily = document.getElementById('cfg-path-daily');
  const pathWeekly = document.getElementById('cfg-path-weekly');
  const pathConges = document.getElementById('cfg-path-conges');
  if (emailWeek) state.config.emailWeek = emailWeek.value.trim();
  if (emailCcWeek) state.config.emailCcWeek = emailCcWeek.value.trim();
  if (emailBccWeek) state.config.emailBccWeek = emailBccWeek.value.trim();
  if (pathDaily) state.config.pdfPathDaily = pathDaily.value.trim();
  if (pathWeekly) state.config.pdfPathWeekly = pathWeekly.value.trim();
  if (pathConges) state.config.pdfPathConges = pathConges.value.trim();
  saveState(); closeCfgSubpanel(); toast('Configuration sauvegardée');
};

// ── PDF GENERATION ──
// Tente de sauvegarder le blob dans un chemin configuré via showSaveFilePicker (File System Access API).
// Si le chemin n'est pas accessible (API non dispo ou refus), fallback sur doc.save() classique.
async function _savePDFWithFallback(doc, fileName, configuredPath) {
    const blob = doc.output('blob');
    if (configuredPath && typeof window.showSaveFilePicker === 'function') {
        try {
            const handle = await window.showSaveFilePicker({
                suggestedName: fileName,
                startIn: 'downloads', // hint seulement, non bloquant
                types: [{ description: 'PDF', accept: { 'application/pdf': ['.pdf'] } }],
            });
            const writable = await handle.createWritable();
            await writable.write(blob);
            await writable.close();
            toast('PDF enregistré ✓');
            return;
        } catch(e) {
            // Utilisateur a annulé ou chemin inaccessible → fallback
            if (e.name !== 'AbortError') console.warn('[PDF] showSaveFilePicker échec, fallback:', e);
        }
    }
    // Fallback classique
    doc.save(fileName);
}

// ── PDF GRAPHIQUE — HELPERS COMMUNS ──
function _pdfParseColor(str) {
  if (!str) return [120, 130, 145];
  const h = str.replace('#', '');
  if (h.length === 6) return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  const m = str.match(/\d+/g);
  if (m && m.length >= 3) return [+m[0], +m[1], +m[2]];
  return [120, 130, 145];
}

const _PDF_COLOR_MAP_RGB = { rouge:[255,77,109], violet:[167,139,250], vert:[0,200,150], bleu:[59,143,255], jaune:[255,208,96] };
const _MONTHS_LONG = ['Janvier','Février','Mars','Avril','Mai','Juin','Juillet','Août','Septembre','Octobre','Novembre','Décembre'];

// Dessine l'effectif d'un jour sur le doc jsPDF à partir de la position y donnée.
// Retourne le nouveau y après le rendu.
function _pdfRenderDay(doc, dayIdx, W, margin, startY) {
  const BLUE = [47, 117, 181];
  const GREY_CARD = [210, 215, 222];
  const H = 297;
  const sectionsMap = getSectionsMap();
  const daySlots = state.slots[dayIdx] || {};

  const cardW = W - 2 * margin;
  const memberH = 12;   // plus de hauteur pour loger poste + nom
  const secTitleH = 8;
  const hoursH = 5;
  const innerPad = 3;
  const memberPad = 2;

  let y = startY;

  SECTIONS_ORDER.forEach(secId => {
    const sec = sectionsMap[secId];
    const slots = daySlots[secId] || [];
    if (slots.length === 0) return;

    const secRGB = _pdfParseColor(sec.color);

    // ── Titre chantier (arrondi) ──
    if (y + secTitleH > H - 15) { doc.addPage(); y = 20; }
    doc.setFillColor(...secRGB);
    doc.roundedRect(margin, y, cardW, secTitleH, 2, 2, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(255, 255, 255);
    doc.text(sec.name.toUpperCase(), margin + 5, y + 5.5);
    y += secTitleH;

    // ── Horaire si présent ──
    if (sec.hours) {
      if (y + hoursH > H - 15) { doc.addPage(); y = 20; }
      doc.setFillColor(240, 243, 248);
      doc.rect(margin, y, cardW, hoursH, 'F');
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(80, 90, 110);
      doc.text(sec.hours, margin + 5, y + 3.5);
      y += hoursH;
    }

    y += 2;

    const membersInSec = slots.map(slot => {
      const key = gkey(dayIdx + '_' + secId + '_' + slot.id);
      const workerId = state.planningModified[key] !== undefined ? state.planningModified[key] : state.planning[key];
      const w = getWorker(workerId);
      return { slot, workerId, w };
    });

    // Conteneur gris englobant
    const membersHeight = membersInSec.length * (memberH + memberPad);
    const totalCMH = innerPad + membersHeight + innerPad;

    if (y + totalCMH > H - 15) { doc.addPage(); y = 20; }

    doc.setFillColor(245, 247, 250);
    doc.roundedRect(margin, y, cardW, totalCMH, 2, 2, 'F');
    doc.setDrawColor(...GREY_CARD);
    doc.setLineWidth(0.3);
    doc.roundedRect(margin, y, cardW, totalCMH, 2, 2, 'S');

    let cy = y + innerPad;

    // ── Cartes membres ──
    membersInSec.forEach(({ slot, workerId, w }) => {
      if (cy + memberH > H - 15) { doc.addPage(); cy = 20; }

      const workerColorKey = state.config?.workerColors?.[workerId];
      const memberRGB = workerColorKey ? _PDF_COLOR_MAP_RGB[workerColorKey] : [180, 185, 195];
      const displayName = w ? (w.lastName + ' ' + w.firstName) : (workerId ? 'Hors groupe' : '—');
      const displayMatric = w ? (w.matricule || '—') : '—';
      const postLabel = slot.label || '';

      const mLeft = margin + innerPad;
      const mW = cardW - 2 * innerPad;

      // Fond blanc arrondi
      doc.setFillColor(255, 255, 255);
      doc.roundedRect(mLeft, cy, mW, memberH, 1.5, 1.5, 'F');
      // Bordure couleur à gauche seulement (liseré)
      doc.setFillColor(...memberRGB);
      doc.roundedRect(mLeft, cy, 2.5, memberH, 1, 1, 'F');
      // Contour général discret
      doc.setDrawColor(...GREY_CARD);
      doc.setLineWidth(0.3);
      doc.roundedRect(mLeft, cy, mW, memberH, 1.5, 1.5, 'S');

      const textLeft = mLeft + 5;

      // Poste (CM, FCQ…) — en haut à gauche, gras, plus gros
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(100, 110, 130);
      doc.text(postLabel, textLeft, cy + 4.5);

      // NOM Prénom — décalé en dessous
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(25, 30, 45);
      doc.text(displayName, textLeft + 2, cy + memberH - 2.5);

      // Matricule à droite, centré verticalement
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(140, 150, 165);
      const matW = doc.getTextWidth(displayMatric);
      doc.text(displayMatric, mLeft + mW - matW - 3, cy + memberH / 2 + 1);

      cy += memberH + memberPad;
    });

    y = cy + 3;
  });

  return y;
}

// ── PDF JOURNALIER ──
async function generateDayPDF(dayIdx) {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return; }

  const BLUE = [47, 117, 181];
  const d = addDays(state.weekStart, dayIdx);
  // "lundi 27 avril 2026" en minuscules pour l'objet/corps, capitalisé pour le PDF
  const dateLabelLong = d.toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
  // "Lundi 27 Avril 2026" — capitalisé pour affichage PDF
  const dateLabelPDF = dateLabelLong.replace(/\b\w/g, c => c.toUpperCase());
  const today = new Date().toLocaleDateString('fr-FR');
  const titre = 'Effectif Équipe Parc Réception Roulier';

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, margin = 14;

  // Header TRANSMANUTENTION
  doc.setFont('helvetica', 'bolditalic');
  doc.setFontSize(20);
  doc.setTextColor(...BLUE);
  doc.text('TRANSMANUTENTION', margin, 15);
  doc.setDrawColor(...BLUE);
  doc.setLineWidth(0.5);
  doc.line(margin, 20, W - margin, 20);

  // Titre + date sur la même ligne
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(30, 35, 50);
  doc.text(titre, margin, 29);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.setTextColor(80, 90, 110);
  const titreW = doc.getTextWidth(titre);
  doc.text('  —  ' + dateLabelPDF, margin + titreW, 29);

  _pdfRenderDay(doc, dayIdx, W, margin, 37);

  // Pied de page
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(170, 170, 180);
  doc.text('Document généré le ' + today + ' par Gestion Parc Réception Roulier', margin, 289);

  // Nom de fichier : Effectif_Parc_Roulier_du_Lundi-27-avril-2026
  const dayCapit = d.toLocaleDateString('fr-FR', {weekday:'long'}).replace(/\b\w/, c => c.toUpperCase());
  const dayNum = d.getDate();
  const monthName = d.toLocaleDateString('fr-FR', {month:'long'});
  const yearNum = d.getFullYear();
  const fileName = `Effectif_Parc_Roulier_du_${dayCapit}-${dayNum}-${monthName}-${yearNum}.pdf`;

  await _savePDFWithFallback(doc, fileName, state.config.pdfPathDaily || '');
  return { dateLabelLong, fileName };
}

// ── PDF HEBDOMADAIRE ──
async function generateWeeklyPDF() {
  const { jsPDF } = window.jspdf;
  if (!jsPDF) { toast('Erreur: librairie PDF non chargée', 'error'); return; }

  const BLUE = [47, 117, 181];
  const wn = getWeekNum(state.weekStart);
  const today = new Date().toLocaleDateString('fr-FR');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const W = 210, H = 297, margin = 14;

  let firstPage = true;

  for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
    // Vérifier si ce jour a des slots
    const daySlots = state.slots[dayIdx] || {};
    const hasSlots = SECTIONS_ORDER.some(secId => (daySlots[secId] || []).length > 0);
    if (!hasSlots) continue;

    if (!firstPage) doc.addPage();
    firstPage = false;

    const d = addDays(state.weekStart, dayIdx);
    const dayName = DAYS[dayIdx];
    const dateLabel = dayName + ' ' + d.getDate() + ' ' + _MONTHS_LONG[d.getMonth()] + ' ' + d.getFullYear();

    // Header de page
    doc.setFont('helvetica', 'bolditalic');
    doc.setFontSize(20);
    doc.setTextColor(...BLUE);
    doc.text('TRANSMANUTENTION', margin, 15);
    doc.setDrawColor(...BLUE);
    doc.setLineWidth(0.5);
    doc.line(margin, 20, W - margin, 20);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(30, 35, 50);
    doc.text('Effectif Équipe Parc Réception Roulier', margin, 27);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(80, 90, 110);
    doc.text(dateLabel + '  —  Semaine ' + wn, margin, 33);

    _pdfRenderDay(doc, dayIdx, W, margin, 40);

    // Pied de page
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(170, 170, 180);
    doc.text('Document généré le ' + today + ' par Gestion Parc Réception Roulier', margin, 289);
  }

  if (firstPage) {
    // Aucun jour avec données
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(11);
    doc.setTextColor(120, 130, 145);
    doc.text('Aucune affectation pour la semaine ' + wn, margin, 50);
  }

  await _savePDFWithFallback(doc, `Planning_Réception_Semaine${wn}.pdf`, state.config.pdfPathWeekly || '');
}

async function sendDailyMail(dayIdx) {
    toast('⏳ Génération du PDF en cours…', 'info');
    let pdfResult;
    try {
        pdfResult = await generateDayPDF(dayIdx);
    } catch(e) {
        toast('Erreur génération PDF', 'error');
        return;
    }

    const dateLabelLong = pdfResult?.dateLabelLong || addDays(state.weekStart, dayIdx).toLocaleDateString('fr-FR', {weekday:'long', day:'numeric', month:'long', year:'numeric'});
    const subject = `Effectif Parc Réception Roulier pour le ${dateLabelLong}`;
    const body = `Bonjour,\nCi-joint Effectif Parc Réception Roulier pour le ${dateLabelLong}.`;

    const bcc = state.config.emailBccWeek ? `&bcc=${encodeURIComponent(state.config.emailBccWeek)}` : '';
    const mailtoUrl = `mailto:${encodeURIComponent(state.config.emailWeek)}?cc=${encodeURIComponent(state.config.emailCcWeek || '')}${bcc}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    const a = document.createElement('a');
    a.href = mailtoUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);

    toast(`📧 "${subject}" — ouverture du client mail…`);
}

async function sendWeeklyMail() {
    const wn = getWeekNum(state.weekStart);
    const subject = 'Planning Hebdo Semaine ' + wn;

    toast('⏳ Génération du PDF en cours…', 'info');
    try {
        await generateWeeklyPDF();
    } catch(e) {
        toast('Erreur génération PDF', 'error');
        return;
    }

    const body = `Bonjour,\n\nCi-joint l'effectif Parc Roulier pour la Semaine ${wn}.`;
    const bcc = state.config.emailBccWeek ? `&bcc=${encodeURIComponent(state.config.emailBccWeek)}` : '';
    const mailtoUrl = `mailto:${encodeURIComponent(state.config.emailWeek)}?cc=${encodeURIComponent(state.config.emailCcWeek || '')}${bcc}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    // Ouverture via un lien <a> pour maximiser la compatibilité avec Outlook sur Windows
    const a = document.createElement('a');
    a.href = mailtoUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => document.body.removeChild(a), 500);

    toast(`📧 "${subject}" — ouverture du client mail…`);
}

// ── TYPES DE CONGÉS ──
const CONGE_TYPES_BASE = [
  { code: 'CP',   label: 'CP — Congé Payé' },
  { code: 'CPAT', label: 'CPAT — Congé Payé Anticipé' },
  { code: 'RR',   label: 'RR — Repos Récupération' },
  { code: 'RTT',  label: 'RTT — Réduction Temps Travail' },
  { code: 'CSS',  label: 'CSS — Congé Sans Solde' },
  { code: 'AT',   label: 'AT — Accident Travail' },
  { code: 'MAL',  label: 'MAL — Maladie' },
  { code: 'MP',   label: 'MP — Maladie Professionnelle' },
  { code: 'FE',   label: 'FE — Jour Férié' },
  { code: 'R',    label: 'R — Repos' },
  { code: 'RP',   label: 'RP — Repos Programmé' },
  { code: 'EXC',  label: 'EXC — Congé Exceptionnel' },
  { code: 'PAT',  label: 'PAT — Paternité' },
  { code: 'MAT',  label: 'MAT — Maternité' },
  { code: 'AUT',  label: 'AUT — Autres Absences' },
  { code: 'FORM', label: 'FORM — Formation' },
  { code: 'EVE',  label: 'EVE — Évènement Familial' },
];

let _dynamicCodes = new Set(CONGE_TYPES_BASE.map(t => t.code));

function getCongeTypes() {
  const customLabels = state.config.congeLabels || {};
  const types = CONGE_TYPES_BASE.map(t => ({
    ...t,
    label: customLabels[t.code] ? t.code + ' — ' + customLabels[t.code] : t.label
  }));
  Object.values(state.absences || {}).forEach(days => {
    Object.values(days).forEach(code => {
      if (code && !_dynamicCodes.has(code)) {
        _dynamicCodes.add(code);
        const customLabel = customLabels[code];
        types.push({ code, label: customLabel ? code + ' — ' + customLabel : code + ' — (API)', isApi: true });
      }
    });
  });
  return types;
}

function renderCongeTypesPanel(body, footer) {
  const customLabels = state.config.congeLabels || {};
  const allTypes = getCongeTypes();
  const rows = allTypes.map(t => {
    const customLabel = customLabels[t.code] || '';
    const defaultLabel = CONGE_TYPES_BASE.find(b => b.code === t.code)?.label?.replace(/^.+? — /, '') || '';
    const apiBadge = t.isApi ? '<span class="cfg-ctype-api-badge">API</span>' : '';
    const inputVal = customLabel || defaultLabel;
    const inputStyle = customLabel ? '' : 'color:var(--text3);font-style:italic;';
    return `<div class="cfg-ctype-row">
      <span class="cfg-ctype-code">${t.code}</span>
      ${apiBadge}
      <input class="cfg-ctype-input" data-code="${t.code}" data-default="${defaultLabel}" placeholder="${defaultLabel || t.code}" value="${inputVal}" style="${inputStyle}" oninput="this.style.color='';this.style.fontStyle='';">
    </div>`;
  }).join('');
  body.innerHTML = `
    <div style="font-size:0.65rem;color:var(--text3);margin-bottom:10px;line-height:1.5;">
      Personnalisez les libellés affichés dans la liste déroulante.<br>
      Les codes marqués <span style="color:var(--warn);font-weight:700;">API</span> ont été découverts automatiquement.
    </div>
    <div style="display:flex;flex-direction:column;">${rows}</div>
  `;
  footer.innerHTML = `<button class="modal-btn modal-btn-ok" onclick="saveCongeTypesConfig()">Enregistrer</button>`;
}

window.saveCongeTypesConfig = function() {
  if (!state.config.congeLabels) state.config.congeLabels = {};
  document.querySelectorAll('.cfg-ctype-input[data-code]').forEach(input => {
    const code = input.dataset.code;
    const val = input.value.trim();
    const def = input.dataset.default || '';
    if (val && val !== def) {
      state.config.congeLabels[code] = val;
    } else {
      delete state.config.congeLabels[code];
    }
  });
  saveState();
  closeCfgSubpanel();
  toast('Libellés des congés sauvegardés ✓');
};

// Injection CSS pour le panneau types congés (partagé entre les deux pages)
(function injectCongeTypesCSS() {
  const style = document.createElement('style');
  style.textContent = `
    .cfg-ctype-row { display:flex; align-items:center; gap:6px; padding:4px 0; border-bottom:1px solid var(--border); }
    .cfg-ctype-code { font-size:0.68rem; font-weight:700; color:var(--accent); font-family:'DM Mono',monospace; min-width:48px; }
    .cfg-ctype-api-badge { font-size:0.55rem; font-weight:700; background:rgba(255,107,53,0.25); color:var(--warn); border-radius:3px; padding:1px 4px; flex-shrink:0; }
    .cfg-ctype-input { flex:1; background:var(--surface); border:1px solid var(--border2); border-radius:5px; color:var(--text); padding:3px 7px; font-size:0.68rem; font-family:inherit; outline:none; }
    .cfg-ctype-input:focus { border-color:var(--accent); }
  `;
  document.head.appendChild(style);
})();

// Export pour les fichiers HTML
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
window.generateDayPDF = generateDayPDF;
window.generateWeeklyPDF = generateWeeklyPDF;
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
window.CONGE_TYPES_BASE = CONGE_TYPES_BASE;
window.getCongeTypes = getCongeTypes;
window.renderCongeTypesPanel = renderCongeTypesPanel;
