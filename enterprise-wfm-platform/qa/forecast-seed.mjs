// Seeds a realistic forecasting scenario on a test stack, for checking the Forecast Dashboard:
//   a busy group (6 queues, 120 days of history with a changing handle time, a published 18-week short-term forecast that covers today),
//   a flat group (one queue whose handle time is always 180 s, so the handle-time chart is a straight line, and a forecast that starts in the future).
// Used by forecast-dashboard-check.mjs; run by hand to leave the data behind:  QA_API=http://localhost:4012 QA_ADMIN_PASSWORD=... node forecast-seed.mjs
const iso = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

export function historyCsv(queue, days, ahtOf) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 5 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${ahtOf(s, rnd)}`);
    }
  }
  return rows.join('\n');
}

export async function seed(API, token, run, o = {}) {
  const { busyQueues = 4, busyHistory = 70, flatHistory = 56 } = o;
  const call = async (m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
  const out = {};
  const build = async (label, queues, ahtOf, fromDay, weeks, history) => {
    const g = (await call('POST', '/config/groups', { name: `${label} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
    const qs = [];
    for (const q of queues) qs.push((await call('POST', '/config/queues', { name: `${q.name} ${run}`, channel: q.channel, wfmGroupId: g.id, ahtDefault: 300 })).json);
    for (const q of qs) {
      const up = await call('POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, history, ahtOf) });
      if (up.status >= 300) throw new Error('import ' + up.text.slice(0, 200));
      const c = await call('POST', `/data/imports/${up.json.id}/commit`);
      if (c.status !== 200) throw new Error('commit ' + c.text.slice(0, 200));
    }
    const f = await call('POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks, fromDay });
    if (f.status !== 201) throw new Error('forecast ' + f.text.slice(0, 300));
    for (const step of ['submit', 'approve', 'publish']) { const r = await call('POST', `/forecast/versions/${f.json.id}/${step}`, {}); if (r.status !== 200) throw new Error(step + ' ' + r.text.slice(0, 200)); }
    return { group: g, queues: qs, version: f.json };
  };
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  // handle time that changes through the day and by queue
  out.busy = await build('FD Busy', [{ name: 'Sales', channel: 'VOICE' }, { name: 'Support', channel: 'VOICE' }, { name: 'Billing', channel: 'VOICE' }, { name: 'Chat A', channel: 'CHAT' }, { name: 'Chat B', channel: 'CHAT' }, { name: 'Retention', channel: 'VOICE' }].slice(0, busyQueues),
    (s, rnd) => 240 + Math.round(80 * Math.sin((s / 96) * Math.PI * 2)) + Math.round(rnd() * 20), iso(addDays(today, -3)), 18, busyHistory);
  // a forecast that starts in the future, for a handle time that never changes
  out.flat = await build('FD Flat', [{ name: 'Single', channel: 'VOICE' }], () => 180, iso(addDays(today, 40)), 4, flatHistory);
  return out;
}

if (process.argv[1] && process.argv[1].endsWith('forecast-seed.mjs')) {
  const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
  const login = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.QA_ADMIN_PASSWORD || '', tenant: 'ORG' }) });
  const token = (await login.json()).token;
  const t0 = Date.now();
  const s = await seed(API, token, Date.now().toString(36));
  console.log('seeded in', Math.round((Date.now() - t0) / 1000), 's', s.busy.group.name, s.busy.version.id, s.flat.group.name, s.flat.version.id);
}
