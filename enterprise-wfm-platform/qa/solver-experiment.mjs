// Does the optimiser tune a 355-person week, and what changes that? Builds the same group three ways on a test stack and prints, for each, the solver status and whether the report says
// "starting roster only". Takes a few minutes (each build runs its full time limit).
//   QA_API=http://localhost:4012 QA_ADMIN_PASSWORD=... node solver-experiment.mjs
const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const run = Date.now().toString(36);
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const PEOPLE = Number(process.env.QA_PEOPLE) || 355;
const g = (await call(token, 'POST', '/config/groups', { name: `EXP ${run}` })).json;
for (let i = 1; i <= PEOPLE; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `EX${run}-${String(i).padStart(3, '0')}`, firstName: `E${i}`, lastName: `X${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '05:00', endTime: '21:00', headcount: Math.round(PEOPLE * 0.22) });
const many = [], few = [];
for (let h = 0; h < 24; h += 1) {
  const t = (await call(token, 'POST', '/scheduling/templates', { name: `EXP${run} ${h}h`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 2, breakMinutes: 15, flexMinutes: 60, earliestStart: `${String(h).padStart(2, '0')}:00`, latestStart: `${String(h).padStart(2, '0')}:00`, durationHours: 8.5, mealMinutes: 30 })).json;
  many.push(t.id); if ([6, 14].includes(h)) few.push(t.id);
}
const today = new Date().toISOString().slice(0, 10);
const pw = (await call(token, 'GET', `/scheduling/pay-week?groupId=${g.id}`)).json?.start ?? 0;
const dow = (d) => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;
let from = new Date(today + 'T00:00:00Z'); while (dow(from.toISOString().slice(0, 10)) !== pw) from.setUTCDate(from.getUTCDate() + 1);
from = from.toISOString().slice(0, 10);
async function build(label, templateIds, timeLimitSec) {
  const t0 = Date.now();
  const r = await call(token, 'POST', '/scheduling/versions', { groupId: g.id, from, weeks: 1, timeLimitSec, coverageSource: 'MANUAL', templateIds, useHistory: false });
  const v = r.json; const ex = v?.settings?.report?.exceptions ?? [];
  const row = { label, http: r.status, templates: templateIds.length, limit: timeLimitSec, seconds: Math.round((Date.now() - t0) / 1000), status: v?.stats?.solver?.status, startingRosterOnly: ex.some((e) => e.code === 'STARTING_ROSTER'), covered: v?.stats?.coverage?.percent, paid: v?.stats?.hours?.paid, needed: v?.stats?.hours?.required, shifts: v?.stats?.shifts, candidates: v?.stats?.solver?.candidates, codes: ex.map((e) => e.code).join(',') };
  console.log(JSON.stringify(row));
  if (process.env.QA_VERBOSE) for (const e of ex) console.log("  -", e.level, e.code, String(e.message).slice(0, 260));
  return row;
}
if (process.env.QA_COUNTS) {
  // how many shift templates can this crew carry? one build per count, evenly spread start hours
  for (const n of process.env.QA_COUNTS.split(',').map(Number)) await build(`${n} templates, 60 s`, many.filter((_, i) => i % Math.max(1, Math.floor(24 / n)) === 0).slice(0, n), 60);
} else {
await build('24 templates, 60 s', many, 60);
if (!process.env.QA_ONE) { await build('24 templates, 120 s', many, 120);
  await build('2 templates, 60 s', few, 60); }
}
