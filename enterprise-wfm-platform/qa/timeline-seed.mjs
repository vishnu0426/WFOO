// Builds the group the Schedule Timeline check looks at, on a test stack: 130 people named First1..First130, a one-week schedule for them with some rule violations and a published version.
//   QA_API=http://localhost:4012 QA_ADMIN_PASSWORD=... node timeline-seed.mjs   (prints the group, the version and the days as JSON)
const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const run = process.env.QA_RUN || Date.now().toString(36);
export const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };

export async function seed({ people = Number(process.env.QA_PEOPLE) || 130, status = 'PUBLISHED', timezone = '', tag = '' } = {}) {
  const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
  const today = new Date().toISOString().slice(0, 10);
  const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `TLQ ${run}${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 2, breakMinutes: 15, flexMinutes: 60, earliestStart: '07:00', latestStart: '13:00', durationHours: 8, mealMinutes: 30 })).json;
  const g = (await call(token, 'POST', '/config/groups', { name: `TLQ ${run}${tag}`, ...(timezone ? { timezone } : {}) })).json;
  const emps = [];
  for (let i = 1; i <= people; i++) emps.push((await call(token, 'POST', '/workforce/employees', { employeeNumber: `TL${run}${tag}-${String(i).padStart(3, '0')}`, firstName: `First${i}`, lastName: `Tl${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).json);
  for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '07:00', endTime: '21:00', headcount: Math.round(people * 0.45) });
  let v = null;
  for (let t = 0; t < 3; t++) {
    const vr = await call(token, 'POST', '/scheduling/versions', { groupId: g.id, from: today, weeks: 1, timeLimitSec: 30, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false });
    v = vr.json; if (vr.status !== 201) console.log('create version', vr.status, vr.text.slice(0, 300)); if (vr.status === 201 && v.stats?.shifts > people) break;
  }
  // published first, while it breaks no rule; the rules are tightened afterwards, as happens in real life, so the published schedule now breaks some
  if (status === 'PUBLISHED') { const p = await call(token, 'POST', `/scheduling/versions/${v.id}/publish`, { acknowledgeReason: 'QA seed' }); if (p.status !== 200) console.log('publish', p.status, p.text.slice(0, 200)); }
  // rule violations: a few people may only work one day in a row, which the schedule breaks
  const shifts = (await call(token, 'GET', `/scheduling/versions/${v.id}/shifts`)).json;
  const worked = [...new Set(shifts.map((s) => s.employeeId))].slice(0, 4);
  for (const id of worked) await call(token, 'PUT', `/workforce/employees/${id}`, { maxConsecutiveDays: 1, reason: 'QA: a rule the schedule breaks' });
  const full = (await call(token, 'GET', `/scheduling/versions/${v.id}`)).json;
  return { token, group: g, version: full, today, shifts: shifts.length, violations: (full.violations ?? []).length, people: emps.length, template: tpl };
}
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) { const r = await seed(); const { token, ...rest } = r; console.log(JSON.stringify({ group: rest.group.name, version: rest.version.id, status: rest.version.status, shifts: rest.shifts, violations: rest.violations, people: rest.people })); }
