// --- File: worker.js ---
const AUTH_URL = 'https://external.docker.inno-web.fr/api/authentication/authenticate';
const PROJECT_URL = 'https://external.docker.inno-web.fr/api/shgtdocker/getweeklyprojectassignments';
const WORKER_URL = 'https://external.docker.inno-web.fr/api/shgtdocker/getworkerscalendarsforuser';
const TOKEN_KV_KEY = 'planning_jwt';

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: cors() });

    try {
      const body = await request.json();
      const token = await getToken(env);
      if (!token) return jsonResp({ error: 'Auth SHGT impossible' }, 502);

      if (body.date && !body.dateFrom) {
        const q = new URLSearchParams({
          pageNumber: 0, pageSize: 200, date: body.date, familyId: 0, workerGroupId: 0, searchValue: ''
        });
        const res = await fetch(`${WORKER_URL}?${q}`, {
          method: 'GET', headers: { 'Authorization': `Bearer ${token}` },
        });
        return jsonResp(await res.json());
      }

      if (body.type === 'workers' && body.dateFrom) {
        // Itération par semaine (lundi par lundi) → 5 appels max par mois au lieu de 31
        const start = new Date(body.dateFrom);
        // Reculer au lundi de la semaine contenant dateFrom
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = body.dateTo ? new Date(body.dateTo) : (() => { const e = new Date(body.dateFrom); e.setDate(e.getDate() + 6); return e; })();
        const dates = [];
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
            dates.push(fmtISO(new Date(d)));
        }

        const results = await Promise.all(dates.map(date => {
            const q = new URLSearchParams({
                pageNumber: 0, pageSize: 200, date: date, familyId: 0, workerGroupId: 0, searchValue: ''
            });
            return fetch(`${WORKER_URL}?${q}`, {
                method: 'GET', headers: { 'Authorization': `Bearer ${token}` },
            }).then(r => r.ok ? r.json() : { totalWorkers: 0, workerCalendars: [] }).catch(() => ({ totalWorkers: 0, workerCalendars: [] }));
        }));

        // Fusion par workerId
        const map = new Map();
        results.forEach(res => {
            if (res.workerCalendars) {
                res.workerCalendars.forEach(wc => {
                    const id = String(wc.workerId);
                    if (!map.has(id)) {
                        // Clone l'objet worker pour éviter les références partagées
                        map.set(id, { ...wc, days: [] });
                    }
                    const existing = map.get(id);
                    if (wc.days) {
                        // Concatène les jours (absences/affectations)
                        existing.days = [...existing.days, ...wc.days];
                    }
                });
            }
        });

        return jsonResp({
            totalWorkers: map.size,
            workerCalendars: Array.from(map.values())
        });
      }

      if (body.dateFrom && body.dateTo) {
        const mondays = getMondays(body.dateFrom, body.dateTo);
        const { dateFrom, dateTo, ...params } = body;
        const results = await Promise.all(mondays.map(date =>
          fetch(PROJECT_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({ date, ...params }),
          }).then(r => r.ok ? r.json() : []).catch(() => [])
        ));
        return jsonResp(results);
      }
      if (body.type === 'saveConges') {
        const existing = await env.SHGT_KV.get('conges_manuels', { type: 'json' }) || {};
        // Fusion profonde : on merge par workerId/date
        const merged = { ...existing };
        Object.entries(body.conges || {}).forEach(([wid, days]) => {
          merged[wid] = { ...(merged[wid] || {}), ...days };
        });
        await env.SHGT_KV.put('conges_manuels', JSON.stringify(merged));
        return jsonResp({ ok: true });
      }

      if (body.type === 'loadConges') {
        const raw = await env.SHGT_KV.get('conges_manuels', { type: 'json' });
        return jsonResp({ ok: true, conges: raw || {} });
      }

      if (body.type === 'savePlanning') {
        const existing = await env.SHGT_KV.get('planning_affectations', { type: 'json' }) || {};
        const existingPlanning = existing.planning || {};
        const existingModified = existing.planningModified || {};

        const mergedPlanning = { ...existingPlanning, ...(body.planning || {}) };
        const mergedModified = { ...existingModified, ...(body.planningModified || {}) };

        const payload = {
          planning: mergedPlanning,
          planningModified: mergedModified,
          config: body.config || existing.config || {},
          savedAt: Date.now()
        };
        await env.SHGT_KV.put('planning_affectations', JSON.stringify(payload));
        return jsonResp({ ok: true, savedAt: payload.savedAt });
      }

      if (body.type === 'loadPlanning') {
        const raw = await env.SHGT_KV.get('planning_affectations', { type: 'json' });
        if (raw && raw.planning) {
          return jsonResp({ ok: true, planning: raw.planning, planningModified: raw.planningModified || {}, config: raw.config || {}, savedAt: raw.savedAt });
        }
        return jsonResp({ ok: true, planning: {}, planningModified: {}, config: {} });
      }





      // saveGmailToken et sendMail → délégués au worker pdf-sendtomail
      return jsonResp({ error: 'Requête non reconnue' }, 400);
    } catch(e) { return jsonResp({ error: e.message }, 500); }
  }
};

function getMondays(dateFrom, dateTo) {
  const mondays = [];
  const cur = new Date(dateFrom);
  cur.setDate(cur.getDate() + (cur.getDay() === 0 ? -6 : 1 - cur.getDay()));
  const end = new Date(dateTo);
  while (cur <= end) {
    mondays.push(fmtISO(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return mondays;
}
function fmtISO(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
async function getToken(env) {
  try {
    const kv = await env.SHGT_KV.get(TOKEN_KV_KEY, { type: 'json' });
    if (kv?.token && kv?.expiry > Date.now()) return kv.token;
  } catch(e) {}
  return await fetchToken(env);
}
async function fetchToken(env) {
  try {
    const r = await fetch(AUTH_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: env.SHGT_EMAIL, password: env.SHGT_PASSWORD }),
    });
    const d = await r.json();
    const token = d.jwtToken;
    await env.SHGT_KV.put(TOKEN_KV_KEY, JSON.stringify({ token, expiry: Date.now() + 34*3600*1000 }), { expirationTtl: 3600 });
    return token;
  } catch(e) { return null; }
}
function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...cors() } });
}
function cors() { return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }; }
// --- End of worker.js ---
