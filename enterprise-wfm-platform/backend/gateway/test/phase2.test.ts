/**
 * Phase 2 end-to-end: workforce, shift templates, CP-SAT schedule generation, rule validation, manual edits, publish, compare.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 * Builds everything it needs (group, history, published forecast, people) under unique names.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

const ctx: Record<string, any> = {};
let admin = '';
const GROUP = `Ops ${RUN}`, QUEUE = `Ops Voice ${RUN}`, TEAM = `Alpha ${RUN}`;

describe('workforce and scheduling', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('prepares a group with history and a published forecast', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: GROUP, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: QUEUE, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(QUEUE, 70) });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 3 });
    assert.equal(f.status, 201, f.text); ctx.forecast = f.json;
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
  });

  it('manages teams, skills and shift templates', async () => {
    const t = await call(admin, 'POST', '/workforce/teams', { name: TEAM }); assert.equal(t.status, 201, t.text); ctx.team = t.json;
    const s = await call(admin, 'POST', '/workforce/skills', { name: `Billing ${RUN}`, category: 'PRODUCTS' }); assert.equal(s.status, 201, s.text); ctx.skill = s.json;
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: TEAM })).status, 409, 'duplicate team name');
    const tpls = [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '12:00', '14:00']];
    ctx.tpl = [];
    for (const [name, a, b] of tpls) {
      const r = await call(admin, 'POST', '/scheduling/templates', { name: `${name} ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
      assert.equal(r.status, 201, r.text); assert.equal(r.json.paidHours, 8); ctx.tpl.push(r.json);
    }
    assert.equal((await call(admin, 'POST', '/scheduling/templates', { name: 'bad', workDays: [1], earliestStart: '10:00', latestStart: '09:00', durationHours: 8 })).status, 400, 'latest before earliest');
  });

  it('imports employees: a dry run changes nothing, a bad row is skipped and reported', async () => {
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week,skills'];
    for (let i = 1; i <= 32; i++) lines.push(`E${RUN}-${i},Agent${i},Test${i},${TEAM},${GROUP},${i % 5 === 0 ? 'PART_TIME' : 'FULL_TIME'},${i % 5 === 0 ? 24 : 40},${i % 5 === 0 ? 4 : 5},Billing ${RUN}:${1 + (i % 5)}`);
    const csv = lines.join('\n');
    const dry = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: true });
    assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.diff.new, 32); assert.equal(dry.json.errorCount, 0);
    assert.equal((await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json.length, 0, 'dry run must not write');
    const bad = await call(admin, 'POST', '/workforce/employees/import', { csv: csv + `\nX${RUN},No,Team,Nowhere,${GROUP},FULL_TIME,40,5,`, dryRun: false });
    // a row with a problem is reported and left out; it does not hold back the good rows
    assert.equal(bad.status, 200, bad.text); assert.equal(bad.json.committed, true);
    assert.equal(bad.json.errorCount, 1); assert.match(bad.json.errors[0].message, /Unknown team/); assert.equal(bad.json.errors[0].line, 34);
    assert.equal(bad.json.diff.new, 32, 'only the good rows are counted');
    const ok = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: false });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.committed, true); assert.equal(ok.json.diff.new, 0, 'already imported by the first commit');
    const again = await call(admin, 'POST', '/workforce/employees/import', { csv, dryRun: true });
    assert.equal(again.json.diff.unchanged, 32, 're-import of the same file changes nothing');
    const list = await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`);
    assert.equal(list.json.length, 32); ctx.emps = list.json;
    assert.ok(list.json[0].skills.length === 1 && list.json[0].teamName === TEAM);
  });

  it('creates, edits and deletes one employee', async () => {
    const c = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `S${RUN}`, firstName: 'Solo', lastName: 'Person', teamId: ctx.team.id, primaryGroupId: ctx.group.id, weeklyContractHours: 30, maxWeeklyHours: 36 });
    assert.equal(c.status, 201, c.text); assert.deepEqual(c.json.eligibleGroupIds, [ctx.group.id], 'the primary group is always eligible');
    assert.equal((await call(admin, 'POST', '/workforce/employees', { employeeNumber: `S${RUN}`, firstName: 'Dup', lastName: 'Person' })).status, 409, 'employee numbers are unique');
    const u = await call(admin, 'PUT', `/workforce/employees/${c.json.id}`, { status: 'LEAVE', maxConsecutiveDays: 4 });
    assert.equal(u.status, 200, u.text); assert.equal(u.json.status, 'LEAVE'); assert.equal(u.json.version, 2);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${c.json.id}/skills`, { skills: [{ skillId: ctx.skill.id, proficiency: 4 }] })).json.skills[0].proficiency, 4);
    assert.equal((await call(admin, 'DELETE', `/workforce/employees/${c.json.id}`)).status, 200);
    assert.equal((await call(admin, 'GET', `/workforce/employees/${c.json.id}`)).status, 404);
  });

  it('validates employee rules and RBAC', async () => {
    const e = ctx.emps[0];
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${e.id}`, { weeklyContractHours: 50, maxWeeklyHours: 40 })).status, 400, 'contract above maximum');
    const an = await call(admin, 'POST', '/users', { username: `an${RUN}`, displayName: 'An', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    assert.ok([201, 409].includes(an.status));
    const tok = (await call(null, 'POST', '/auth/login', { username: `an${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
    assert.equal((await call(tok, 'GET', '/workforce/employees')).status, 200);
    assert.equal((await call(tok, 'POST', '/workforce/teams', { name: 'nope' })).status, 403);
    assert.equal((await call(tok, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: '2030-01-07' })).status, 403);
  });

  it('records availability and time off that the scheduler must respect', async () => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const toMonday = (7 - ((start.getDay() + 6) % 7)) % 7;
    ctx.from = iso(addDays(start, toMonday));
    ctx.monday = ctx.from; ctx.wednesday = iso(addDays(new Date(ctx.from + 'T00:00:00'), 2));
    // person 0 never works Mondays; person 1 has approved leave on the Wednesday; person 2 has only a pending request
    const w = await call(admin, 'PUT', `/workforce/employees/${ctx.emps[0].id}/availability`, { windows: [{ dayOfWeek: 0, startTime: '00:00', endTime: '24:00', kind: 'UNAVAILABLE' }] });
    assert.equal(w.status, 200, w.text);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${ctx.emps[0].id}/availability`, { windows: [{ dayOfWeek: 0, startTime: '10:00', endTime: '09:00', kind: 'UNAVAILABLE' }] })).status, 400);
    await call(admin, 'PUT', `/workforce/employees/${ctx.emps[0].id}/availability`, { windows: [{ dayOfWeek: 0, startTime: '00:00', endTime: '24:00', kind: 'UNAVAILABLE' }] });
    const to = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.emps[1].id, type: 'VACATION', startDate: ctx.wednesday, endDate: ctx.wednesday, approve: true });
    assert.equal(to.status, 201, to.text); assert.equal(to.json.status, 'APPROVED');
    const pend = await call(admin, 'POST', '/workforce/time-off', { employeeId: ctx.emps[2].id, startDate: ctx.wednesday, endDate: ctx.wednesday });
    assert.equal(pend.json.status, 'REQUESTED');
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${pend.json.id}/decide`, { status: 'REJECTED' })).status, 400, 'a rejection needs a reason');
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${pend.json.id}/decide`, { status: 'REJECTED', reason: 'Team is short that day' })).json.status, 'REJECTED');
  });

  it('refuses to generate without a published forecast, then builds a valid schedule', async () => {
    const g2 = await call(admin, 'POST', '/config/groups', { name: `Empty ${RUN}` });
    assert.equal((await call(admin, 'POST', '/scheduling/versions', { groupId: g2.json.id, from: ctx.from })).status, 400);

    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 45 });
    assert.equal(r.status, 201, r.text); ctx.v1 = r.json;
    assert.equal(r.json.status, 'DRAFT'); assert.equal(r.json.seq, 1);
    assert.ok(['OPTIMAL', 'FEASIBLE'].includes(r.json.stats.solver.status), r.json.stats.solver.status);
    assert.equal(r.json.stats.violations, 0, 'the solver may not break a hard rule');
    assert.ok(r.json.stats.coverage.percent >= 75, `coverage ${r.json.stats.coverage.percent}%`);
    assert.ok(r.json.stats.shifts > 20);

    const shifts = (await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/shifts`)).json;
    assert.equal(shifts.filter((s: any) => s.employeeId === ctx.emps[0].id && s.day === ctx.monday).length, 0, 'unavailable on Mondays');
    assert.equal(shifts.filter((s: any) => s.employeeId === ctx.emps[1].id && s.day === ctx.wednesday).length, 0, 'approved leave respected');
    assert.ok(shifts.every((s: any) => s.activities.some((a: any) => a.type === 'MEAL')), 'every shift has a meal placed');
    const perDay = new Map<string, Set<string>>();
    for (const s of shifts) { const k = s.employeeId; perDay.set(k, (perDay.get(k) ?? new Set()).add(s.day)); }
    assert.ok([...perDay.values()].every((d) => d.size <= 5), 'at most five days a week');

    const v = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/validate`);
    assert.equal(v.json.ok, true, v.text);
    const cov = (await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/coverage?day=${ctx.monday}&grain=60`)).json;
    assert.equal(cov.daily.length, 7); assert.equal(cov.slots.length, 24);
    assert.ok(cov.daily.every((d: any) => d.scheduledHours > 0));
  });

  it('flags a manual shift that breaks a rule and blocks publishing until fixed', async () => {
    const reasonless = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/shifts`, { employeeId: ctx.emps[1].id, day: ctx.wednesday, templateId: ctx.tpl[0].id, startTime: '07:00' });
    assert.equal(reasonless.status, 400, 'a reason is mandatory');
    const bad = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/shifts`, { employeeId: ctx.emps[1].id, day: ctx.wednesday, templateId: ctx.tpl[0].id, startTime: '07:00', reason: 'Cover a gap on Wednesday' });
    assert.equal(bad.status, 201, bad.text);
    assert.ok(bad.json.violations.some((x: any) => x.type === 'TIME_OFF'), JSON.stringify(bad.json.violations));
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/publish`);
    assert.equal(pub.status, 409); assert.match(pub.text, /RULE_VIOLATIONS/);
    assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.v1.id}/shifts/${bad.json.id}`)).status, 400, 'removal needs a reason too');
    assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.v1.id}/shifts/${bad.json.id}?reason=${encodeURIComponent('Leave takes priority')}`)).status, 200);
    assert.equal((await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/validate`)).json.ok, true);
  });

  it('publishes, allows reasoned edits, and lets a second version replace it', async () => {
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/publish`);
    assert.equal(pub.status, 200, pub.text); assert.equal(pub.json.status, 'PUBLISHED');
    // a published schedule can still be corrected, but only with a stated reason, and it has to be republished (which re-checks the rules)
    const edit = { employeeId: ctx.emps[3].id, day: ctx.monday, templateId: ctx.tpl[1].id, startTime: '09:00' };
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/shifts`, edit)).status, 400, 'an edit to a published schedule needs a reason');
    const late = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/shifts`, { ...edit, reason: 'late change' });
    assert.equal(late.status, 201, late.text);
    assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.v1.id}/shifts/${late.json.id}?reason=${encodeURIComponent('undo the late change')}`)).status, 200);
    assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.v1.id}`)).status, 409, 'cannot delete published');

    const v2 = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 45, weights: { understaffing: 90, overstaffing: 80, contractHours: 20, preferences: 0, fairness: 0 } });
    assert.equal(v2.status, 201, v2.text); assert.equal(v2.json.seq, 2); ctx.v2 = v2.json;
    const cmp = await call(admin, 'GET', `/scheduling/compare?a=${ctx.v1.id}&b=${ctx.v2.id}`);
    assert.equal(cmp.status, 200, cmp.text);
    assert.equal(cmp.json.a.daily.length, 7); assert.ok('coveragePercent' in cmp.json.delta && 'same' in cmp.json.shiftsChanged);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${ctx.v2.id}/publish`)).status, 200);
    const list = (await call(admin, 'GET', `/scheduling/versions?groupId=${ctx.group.id}`)).json;
    assert.deepEqual(list.map((v: any) => v.status), ['PUBLISHED', 'ARCHIVED'], 'the older published schedule is archived');
  });

  it('records the work in the audit ledger', async () => {
    const a = await call(admin, 'GET', '/audit?limit=200');
    assert.equal(a.status, 200, a.text);
    const rows: any[] = a.json.items ?? a.json.rows ?? a.json;
    const types = new Set(rows.map((r) => `${r.entityType}:${r.action}`));
    for (const need of ['EMPLOYEE:CREATE', 'EMPLOYEE:UPDATE', 'EMPLOYEE:DELETE', 'EMPLOYEE_IMPORT:IMPORT', 'SCHEDULE_VERSION:GENERATE', 'SCHEDULE_VERSION:PUBLISH', 'SHIFT_TEMPLATE:CREATE']) assert.ok(types.has(need), `missing ${need} in ${[...types].join(', ')}`);
  });
});
