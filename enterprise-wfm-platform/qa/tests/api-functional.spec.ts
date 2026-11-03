/**
 * Module-by-module functional tests through the gateway API. Every record created is named QA-<run>-… and cleaned up where an API allows.
 * Results go to reports/data/functional.jsonl (one row per check) for the report.
 */
import { test, expect } from '@playwright/test';
import { adminToken, call, loginReady, record, testData, RUN } from './helpers';

const Q = (s: string) => `QA-${RUN}-${s}`;
const day = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const log = (module: string, check: string, ok: boolean, detail: unknown = '') => record('functional', { module, check, ok, detail });

let A: string;
let demoGroup: any;
test.beforeAll(async () => {
  A = await adminToken();
  demoGroup = ((await call(A, 'GET', '/config/groups')).body as any[]).find((g) => g.name === 'Demo Support');
});

test.describe('Configuration', () => {
  test('WFM group + queue: create, validate, update, read back', async () => {
    const g = await call(A, 'POST', '/config/groups', { name: Q('Group'), serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 85, timezone: 'Asia/Kolkata' });
    log('Configuration', 'create group', g.status === 201, g.status); expect(g.status).toBe(201);
    const dup = await call(A, 'POST', '/config/groups', { name: Q('Group') });
    log('Configuration', 'duplicate group name rejected', dup.status >= 400 && dup.status < 500, `${dup.status} ${dup.body?.error?.message}`); expect.soft(dup.status).toBe(409);
    const badTz = await call(A, 'POST', '/config/groups', { name: Q('BadTz'), timezone: 'Mars/Olympus' });
    log('Configuration', 'invalid timezone rejected', badTz.status === 400, `${badTz.status} ${badTz.body?.error?.message}`); expect.soft(badTz.status).toBe(400);
    const badSl = await call(A, 'POST', '/config/groups', { name: Q('BadSl'), serviceLevelGoal: 150 });
    log('Configuration', 'service level 150% rejected', badSl.status === 400, badSl.status); expect.soft(badSl.status).toBe(400);
    const q = await call(A, 'POST', '/config/queues', { name: Q('Voice'), channel: 'VOICE', wfmGroupId: g.body.id, ahtDefault: 300 });
    log('Configuration', 'create queue', q.status === 201, q.status); expect(q.status).toBe(201);
    const badHours = await call(A, 'POST', '/config/queues', { name: Q('Hours'), channel: 'VOICE', wfmGroupId: g.body.id, openSlot: 80, closeSlot: 20 });
    log('Configuration', 'queue open after close rejected', badHours.status === 400, `${badHours.status} ${badHours.body?.error?.message ?? ''}`); expect.soft(badHours.status, 'openSlot 80 > closeSlot 20').toBe(400);
    const up = await call(A, 'PUT', `/config/groups/${g.body.id}`, { name: Q('Group'), shrinkagePercent: 30, reason: 'QA update' });
    log('Configuration', 'update group', up.status === 200, up.status); expect.soft(up.status).toBe(200);
    const read = ((await call(A, 'GET', '/config/groups')).body as any[]).find((x) => x.id === g.body.id);
    log('Configuration', 'update persisted', Number(read?.shrinkagePercent) === 30, read?.shrinkagePercent); expect.soft(Number(read?.shrinkagePercent)).toBe(30);
    for (const p of ['/config/activities', '/config/scheduling-policy', '/intraday/state-map', '/compliance/packs', '/self-service/policy', '/config/sites']) {
      const r = await call(A, 'GET', p); log('Configuration', `GET ${p}`, r.status === 200, r.status); expect.soft(r.status, p).toBe(200);
    }
  });
});

test.describe('Workforce', () => {
  test('team, skill, employee CRUD and validation', async () => {
    const t = await call(A, 'POST', '/workforce/teams', { name: Q('Team') });
    log('Workforce', 'create team', t.status === 201, t.status); expect(t.status).toBe(201);
    const s = await call(A, 'POST', '/workforce/skills', { name: Q('Skill'), category: 'LANGUAGES' });
    log('Workforce', 'create skill', s.status === 201, s.status); expect.soft(s.status).toBe(201);
    const num = `QA${RUN}`;
    const e = await call(A, 'POST', '/workforce/employees', { employeeNumber: num, firstName: 'Qa', lastName: `Tester${RUN}`, email: `qa${RUN}@example.com`, teamId: t.body.id, employmentType: 'FULL_TIME', weeklyContractHours: 40, workDaysPerWeek: 5, hireDate: '2024-01-15' });
    log('Workforce', 'create employee', e.status === 201, `${e.status} ${e.body?.error?.message ?? ''}`); expect(e.status).toBe(201);
    const dup = await call(A, 'POST', '/workforce/employees', { employeeNumber: num, firstName: 'Dup', lastName: 'Dup' });
    log('Workforce', 'duplicate employee number rejected', dup.status === 409, `${dup.status} ${dup.body?.error?.message}`); expect.soft(dup.status).toBe(409);
    const email = await call(A, 'POST', '/workforce/employees', { employeeNumber: num + 'b', firstName: 'X', lastName: 'Y', email: 'not-an-email' });
    log('Workforce', 'invalid email rejected', email.status === 400, email.status); expect.soft(email.status).toBe(400);
    const hours = await call(A, 'POST', '/workforce/employees', { employeeNumber: num + 'c', firstName: 'X', lastName: 'Y', weeklyContractHours: 40, maxWeeklyHours: 20 });
    log('Workforce', 'max weekly hours below contract hours rejected', hours.status === 400, `${hours.status} ${hours.body?.error?.message ?? ''}`); expect.soft(hours.status, 'max 20h < contract 40h accepted').toBe(400);
    if (hours.body?.id) await call(A, 'DELETE', `/workforce/employees/${hours.body.id}`);
    const future = await call(A, 'POST', '/workforce/employees', { employeeNumber: num + 'd', firstName: 'X', lastName: 'Y', hireDate: '2099-01-01' });
    log('Workforce', 'hire date in 2099', future.status === 400, `${future.status}`);
    if (future.body?.id) await call(A, 'DELETE', `/workforce/employees/${future.body.id}`);
    const up = await call(A, 'PUT', `/workforce/employees/${e.body.id}`, { lastName: `Updated${RUN}` });
    log('Workforce', 'update employee', up.status === 200, up.status); expect.soft(up.status).toBe(200);
    const got = await call(A, 'GET', `/workforce/employees/${e.body.id}`);
    log('Workforce', 'update persisted', got.body?.lastName === `Updated${RUN}`, got.body?.lastName); expect.soft(got.body?.lastName).toBe(`Updated${RUN}`);
    // admin time off for the employee, approve, then reject without reason
    const to = await call(A, 'POST', '/workforce/time-off', { employeeId: e.body.id, type: 'VACATION', startDate: day(15), endDate: day(16), reason: 'QA' });
    log('Workforce', 'create time off (admin)', to.status === 201, `${to.status} ${to.body?.error?.message ?? ''}`); expect.soft(to.status).toBe(201);
    const toId = to.body?.id ?? to.body?.request?.id;
    if (toId) {
      const rej = await call(A, 'POST', `/workforce/time-off/${toId}/decide`, { status: 'REJECTED' });
      log('Workforce', 'reject without reason refused', rej.status === 400, rej.status); expect.soft(rej.status).toBe(400);
      const ap = await call(A, 'POST', `/workforce/time-off/${toId}/decide`, { status: 'APPROVED' });
      log('Workforce', 'approve time off', ap.status === 200, ap.status); expect.soft(ap.status).toBe(200);
    }
    const overlap = await call(A, 'POST', '/workforce/time-off', { employeeId: e.body.id, type: 'VACATION', startDate: day(16), endDate: day(17), approve: true });
    log('Workforce', 'overlapping time off rejected', overlap.status === 409 || overlap.status === 400, `${overlap.status} ${overlap.body?.error?.message ?? ''}`); expect.soft([400, 409], 'overlapping time-off accepted').toContain(overlap.status);
    // CSV import dry run with bad rows
    const csv = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week,hire_date', `QAI${RUN},Ok,Row,${Q('Team')},Demo Support,FULL_TIME,40,5,2024-01-01`, `,Missing,Number,,,FULL_TIME,40,5,2024-01-01`, `QAJ${RUN},Bad,Hours,,,FULL_TIME,abc,9,2024-13-45`].join('\n');
    const imp = await call(A, 'POST', '/workforce/employees/import', { csv, dryRun: true });
    log('Workforce', 'CSV import dry-run reports bad rows', imp.status === 200, JSON.stringify(imp.body).slice(0, 300)); expect.soft(imp.status).toBe(200);
    // cleanup
    const del = await call(A, 'DELETE', `/workforce/employees/${e.body.id}`);
    log('Workforce', 'delete employee', del.status < 300, del.status); expect.soft(del.status).toBeLessThan(300);
    await call(A, 'DELETE', `/workforce/teams/${t.body.id}`);
    if (s.body?.id) await call(A, 'DELETE', `/workforce/skills/${s.body.id}`);
    for (const p of ['/workforce/availability', '/workforce/time-off', `/attendance/summary?from=${day(-14)}&to=${day(0)}`, `/workforce/attrition?groupId=${demoGroup.id}`]) { const r = await call(A, 'GET', p); log('Workforce', `GET ${p}`, r.status === 200, r.status); expect.soft(r.status, p).toBe(200); }
  });
});

test.describe('Forecasting', () => {
  test('forecast versions, lifecycle guards and accuracy', async () => {
    const v = (await call(A, 'GET', '/forecast/versions')).body as any[];
    log('Forecasting', 'list versions', Array.isArray(v), v.length);
    const pub = v.find((x) => x.wfmGroupId === demoGroup.id && x.status === 'PUBLISHED');
    log('Forecasting', 'demo forecast published', !!pub, pub?.status); expect.soft(pub).toBeTruthy();
    if (pub) {
      const again = await call(A, 'POST', `/forecast/versions/${pub.id}/approve`, {});
      log('Forecasting', 'cannot re-approve a published version', again.status >= 400, `${again.status} ${again.body?.error?.message}`); expect.soft(again.status).toBeGreaterThanOrEqual(400);
      const del = await call(A, 'DELETE', `/forecast/versions/${pub.id}`);
      log('Forecasting', 'cannot delete published forecast', del.status >= 400, `${del.status} ${del.body?.error?.message}`); expect.soft(del.status).toBeGreaterThanOrEqual(400);
    }
    const t0 = Date.now();
    const f = await call(A, 'POST', '/forecast/versions', { groupId: demoGroup.id, kind: 'SHORT', weeks: 2 });
    const ms = Date.now() - t0;
    log('Forecasting', `create forecast (engine) in ${ms}ms`, f.status === 201 || f.status === 200, `${f.status} ${f.body?.error?.message ?? ''}`); expect.soft([200, 201]).toContain(f.status);
    if (f.body?.id) {
      const skip = await call(A, 'POST', `/forecast/versions/${f.body.id}/publish`, {});
      log('Forecasting', 'publish before approve blocked', skip.status >= 400, `${skip.status} ${skip.body?.error?.message}`); expect.soft(skip.status, 'draft published without approval').toBeGreaterThanOrEqual(400);
      const d = await call(A, 'DELETE', `/forecast/versions/${f.body.id}`);
      log('Forecasting', 'delete draft forecast', d.status < 300, d.status);
    }
    const bad = await call(A, 'POST', '/forecast/versions', { groupId: demoGroup.id, kind: 'SHORT', weeks: 0 });
    log('Forecasting', 'zero-week forecast rejected', bad.status === 400, bad.status); expect.soft(bad.status).toBe(400);
    for (const p of [`/forecast/versions/${pub?.id}/leaderboard`, `/forecast/accuracy?groupId=${demoGroup.id}`, `/forecast/versions/${pub?.id}/scenarios`, `/forecast/history-quality?groupId=${demoGroup.id}`]) { const r = await call(A, 'GET', p); log('Forecasting', `GET ${p}`, r.status === 200, `${r.status} ${r.body?.error?.message ?? ''}`); expect.soft(r.status, p).toBeLessThan(500); }
  });
});

test.describe('Scheduling', () => {
  test('published schedule integrity: no overlaps, rest rules, lengths, period', async () => {
    const vers = (await call(A, 'GET', '/scheduling/versions')).body as any[];
    const v = vers.find((x) => x.wfmGroupId === demoGroup.id && x.status === 'PUBLISHED');
    expect(v).toBeTruthy();
    const shifts = (await call(A, 'GET', `/scheduling/versions/${v.id}/shifts`)).body as any[];
    const byEmp: Record<string, any[]> = {};
    for (const s of shifts) (byEmp[s.employeeId] ??= []).push(s);
    const overlaps: string[] = [], shortRest: string[] = [], weird: string[] = [], overHours: string[] = [], consec: string[] = [];
    for (const [emp, list] of Object.entries(byEmp)) {
      list.sort((a, b) => (a.day + String(a.startSlot).padStart(3, '0')).localeCompare(b.day + String(b.startSlot).padStart(3, '0')));
      const abs = (s: any) => Date.parse(s.day + 'T00:00:00Z') / 900000 + s.startSlot;
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.lengthSlots < 8 || s.lengthSlots > 52) weird.push(`${emp} ${s.day} len=${s.lengthSlots}`);
        if (i) { const p = list[i - 1]; const gap = abs(s) - (abs(p) + p.lengthSlots); if (gap < 0) overlaps.push(`${emp} ${p.day}/${s.day}`); else if (gap < 11 * 4) shortRest.push(`${emp} ${p.day}->${s.day} rest=${gap / 4}h`); }
      }
      const weeks: Record<string, number> = {};
      for (const s of list) { const d = new Date(s.day + 'T00:00:00Z'); const wk = Math.floor((d.getTime() / 864e5 + 3) / 7); weeks[wk] = (weeks[wk] ?? 0) + s.lengthSlots / 4; }
      for (const [wk, h] of Object.entries(weeks)) if (h > 48) overHours.push(`${emp} week ${wk}: ${h}h`);
      let run = 1; for (let i = 1; i < list.length; i++) { const dd = (Date.parse(list[i].day) - Date.parse(list[i - 1].day)) / 864e5; run = dd === 1 ? run + 1 : dd === 0 ? run : 1; if (run > 6) { consec.push(`${emp} ${list[i].day} run=${run}`); break; } }
    }
    const days = [...new Set(shifts.map((s) => s.day))].sort();
    const detail = { version: v.name, shifts: shifts.length, people: Object.keys(byEmp).length, firstDay: days[0], lastDay: days.at(-1), overlaps: overlaps.length, shortRest: shortRest.slice(0, 5), shortRestCount: shortRest.length, weirdLength: weird.slice(0, 5), over48h: overHours.slice(0, 5), over6Consecutive: consec.slice(0, 5) };
    log('Scheduling', 'published schedule integrity', overlaps.length === 0 && weird.length === 0 && shortRest.length === 0, detail);
    expect.soft(overlaps, 'double-booked shifts').toEqual([]);
    expect.soft(shortRest, 'less than 11h rest between shifts').toEqual([]);
    expect.soft(weird, 'shift length out of 2h..13h').toEqual([]);
    expect.soft(overHours, 'more than 48h in a week').toEqual([]);
    expect.soft(consec, 'more than 6 consecutive days').toEqual([]);
  });

  test('templates CRUD + validation, publish guards, compare', async () => {
    const tpl = { name: Q('Tpl'), workDays: [0, 1, 2, 3, 4], earliestStart: '08:00', latestStart: '10:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 0 };
    const c = await call(A, 'POST', '/scheduling/templates', tpl);
    log('Scheduling', 'create shift template', c.status === 201, `${c.status} ${c.body?.error?.message ?? ''}`); expect.soft(c.status).toBe(201);
    const inv = await call(A, 'POST', '/scheduling/templates', { ...tpl, name: Q('TplBad'), earliestStart: '12:00', latestStart: '09:00' });
    log('Scheduling', 'latest start before earliest rejected', inv.status === 400, `${inv.status} ${inv.body?.error?.message ?? ''}`); expect.soft(inv.status).toBe(400);
    const long = await call(A, 'POST', '/scheduling/templates', { ...tpl, name: Q('TplLong'), durationHours: 30 });
    log('Scheduling', '30h shift rejected', long.status === 400, long.status); expect.soft(long.status).toBe(400);
    if (inv.body?.id) await call(A, 'DELETE', `/scheduling/templates/${inv.body.id}`);
    if (long.body?.id) await call(A, 'DELETE', `/scheduling/templates/${long.body.id}`);
    if (c.body?.id) { const d = await call(A, 'DELETE', `/scheduling/templates/${c.body.id}`); log('Scheduling', 'delete template', d.status < 300, d.status); }
    const vers = (await call(A, 'GET', '/scheduling/versions')).body as any[];
    const pub = vers.find((x) => x.wfmGroupId === demoGroup.id && x.status === 'PUBLISHED');
    const draft = vers.find((x) => x.status === 'DRAFT');
    const repub = await call(A, 'POST', `/scheduling/versions/${pub.id}/publish`, {});
    log('Scheduling', 're-publish published version is idempotent/blocked', repub.status !== 500, `${repub.status} ${repub.body?.error?.message ?? ''}`); expect.soft(repub.status).toBeLessThan(500);
    if (draft) { const cmp = await call(A, 'GET', `/scheduling/compare?a=${pub.id}&b=${draft.id}`); log('Scheduling', 'compare two versions', cmp.status < 500, cmp.status); expect.soft(cmp.status).toBeLessThan(500); }
    const past = await call(A, 'POST', '/scheduling/versions', { groupId: demoGroup.id, from: '2020-01-06', weeks: 1, timeLimitSec: 5 });
    log('Scheduling', 'generate schedule for 2020 rejected (past-day lock)', past.status >= 400, `${past.status} ${past.body?.error?.message ?? ''}`); expect.soft(past.status, 'schedule generated for a past week').toBeGreaterThanOrEqual(400);
    for (const p of ['/scheduling/templates', `/scheduling/versions/${pub.id}/plan`, '/scheduling/offers', '/scheduling/swaps', '/scheduling/rotations', `/scheduling/rollup/?from=${day(1)}&to=${day(14)}`]) { const r = await call(A, 'GET', p); log('Scheduling', `GET ${p.replace(pub.id, ':id')}`, r.status < 400, `${r.status} ${r.body?.error?.message ?? ''}`); expect.soft(r.status, p).toBeLessThan(500); }
  });
});

test.describe('Intraday', () => {
  test('agent state events, live ingest, adherence and coverage', async () => {
    const emp = ((await call(A, 'GET', '/workforce/employees?q=D001')).body as any[]).find((e) => e.employeeNumber === 'D001');
    const now = new Date().toISOString();
    const ev = await call(A, 'POST', '/intraday/events', { events: [{ employeeNumber: emp.employeeNumber, state: 'Available', reason: '', at: now }, { employeeNumber: 'NOPE-404', state: 'Available', at: now }] });
    log('Intraday', 'post agent state events (one unknown agent)', ev.status < 300, JSON.stringify(ev.body).slice(0, 200)); expect.soft(ev.status).toBeLessThan(300);
    const future = await call(A, 'POST', '/intraday/events', { events: [{ employeeNumber: emp.employeeNumber, state: 'Available', at: '2099-01-01T00:00:00Z' }] });
    log('Intraday', 'event dated 2099 rejected', future.status === 400 || JSON.stringify(future.body).match(/reject|skip|future/i) != null, JSON.stringify(future.body).slice(0, 200));
    const ing = await call(A, 'POST', '/data/ingest', { rows: [{ queue: 'Demo Voice', day: day(0), time: '09:15', volume: 42, ahtSec: 310 }, { queue: 'Demo Voice', day: day(0), time: '09:15', volume: -5, ahtSec: 310 }] });
    log('Intraday', 'live ingest (one negative volume row)', ing.status < 500, `${ing.status} ${JSON.stringify(ing.body).slice(0, 200)}`); expect.soft(ing.status).toBeLessThan(500);
    for (const p of [`/intraday/adherence?groupId=${demoGroup.id}`, `/intraday/coverage?groupId=${demoGroup.id}`, `/intraday/break-suggestions?groupId=${demoGroup.id}`]) { const r = await call(A, 'GET', p); log('Intraday', `GET ${p.split('?')[0]}`, r.status === 200, `${r.status} ${r.body?.error?.message ?? ''}`); expect.soft(r.status, p).toBeLessThan(500); }
  });
});

test.describe('Data management', () => {
  test('staged import: bad file rejected, good file staged and discarded', async () => {
    const tpl = await fetch(`${process.env.QA_API ?? 'http://localhost:4000'}/api/v1/data/import-template`, { headers: { Authorization: 'Bearer ' + A } });
    log('Data management', 'download import template', tpl.status === 200, tpl.headers.get('content-type')); expect.soft(tpl.status).toBe(200);
    const noDate = await call(A, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: Q('nodate.csv'), csv: 'queue,volume\nDemo Voice,10' });
    log('Data management', 'file without date column rejected', noDate.status === 400 || noDate.body?.status === 'FAILED', `${noDate.status} ${noDate.body?.error?.message ?? noDate.body?.status}`); expect.soft(noDate.status).toBeLessThan(500);
    const empty = await call(A, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: Q('empty.csv'), csv: '' });
    log('Data management', 'empty file rejected', empty.status === 400, empty.status); expect.soft(empty.status).toBe(400);
    const rows = ['queue,date,interval,volume,aht', `Demo Voice,${day(-100)},09:00,12,300`, `Demo Voice,${day(-100)},09:15,abc,300`, `Unknown Queue,${day(-100)},09:30,5,300`, `Demo Voice,${day(-100)},25:00,5,300`];
    const st = await call(A, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: Q('mixed.csv'), csv: rows.join('\n') });
    log('Data management', 'mixed file staged with row-level errors', st.status < 300, JSON.stringify(st.body).slice(0, 300)); expect.soft(st.status).toBeLessThan(300);
    if (st.body?.id) { const d = await call(A, 'DELETE', `/data/imports/${st.body.id}`); log('Data management', 'delete staged import', d.status < 400, `${d.status} ${d.body?.error?.message ?? ''}`); }
    for (const p of ['/data/imports', '/data/quality', '/data/ingest/status']) { const r = await call(A, 'GET', p); log('Data management', `GET ${p}`, r.status === 200, r.status); expect.soft(r.status, p).toBeLessThan(500); }
  });
});

test.describe('Audit & Administration', () => {
  test('actions are audited; disabled user cannot sign in', async () => {
    const name = `qa.disabled.${RUN}`;
    const u = await call(A, 'POST', '/users', { username: name, displayName: 'QA Disabled', role: 'ANALYST', password: 'Tmp-' + testData.rolePassword });
    log('Administration', 'create user', u.status === 201, u.status); expect(u.status).toBe(201);
    const tok = await loginReady(name, 'Tmp-' + testData.rolePassword, testData.rolePassword);
    const off = await call(A, 'PATCH', `/users/${u.body.id}`, { status: 'DISABLED' });
    log('Administration', 'disable user', off.status === 200, off.status);
    const again = await call(null, 'POST', '/auth/login', { username: name, password: testData.rolePassword, tenant: 'ORG' });
    log('Administration', 'disabled user cannot sign in', again.status === 401, again.status); expect.soft(again.status).toBe(401);
    const live = await call(tok, 'GET', '/workforce/employees');
    log('Administration', 'existing session of disabled user is cut off', live.status === 401 || live.status === 403, live.status); expect.soft([401, 403], 'disabled user keeps using an old token').toContain(live.status);
    const audit = await call(A, 'GET', `/audit?search=${encodeURIComponent(name)}`);
    const hit = JSON.stringify(audit.body).includes(name);
    log('Audit', 'user creation recorded in audit log', hit, audit.status); expect.soft(hit).toBe(true);
    const fail = await call(null, 'POST', '/auth/login', { username: 'admin', password: 'wrong-' + RUN, tenant: 'ORG' });
    const a2 = JSON.stringify((await call(A, 'GET', '/audit?search=LOGIN')).body);
    log('Audit', 'failed sign-in attempts are audited', /LOGIN_FAILED|FAILED_LOGIN|failed sign/i.test(a2), fail.status);
    const exp = await fetch(`${process.env.QA_API ?? 'http://localhost:4000'}/api/v1/audit/export.csv`, { headers: { Authorization: 'Bearer ' + A } });
    log('Audit', 'audit CSV export', exp.status === 200, exp.headers.get('content-type')); expect.soft(exp.status).toBe(200);
  });
});

test.describe('Self-service (API)', () => {
  test('agent home/schedule/notifications, auto-approved time off, giveaway & take, offers', async () => {
    const a1 = await loginReady('demo.agent1', 'Demo-Pass-123', testData.agentPassword);
    const a3 = await loginReady('demo.agent3', 'Demo-Pass-123', testData.agentPassword);
    for (const p of ['/me/home', '/me/schedule', '/me/notifications', '/me/profile', '/me/time-off', '/me/availability', '/me/offers', '/me/swaps', '/me/bids']) {
      const r = await call(a1, 'GET', p); log('Self-service', `GET ${p}`, r.status === 200, `${r.status} ${r.body?.error?.message ?? ''}`); expect.soft(r.status, p).toBe(200);
    }
    const to = await call(a1, 'POST', '/me/time-off', { type: 'PERSONAL', startDate: day(25), endDate: day(25), reason: Q('auto') });
    log('Self-service', 'time off auto-approved by policy', to.body?.request?.status === 'APPROVED', `${to.status} ${to.body?.request?.status ?? to.body?.error?.message}`);
    const dupe = await call(a1, 'POST', '/me/time-off', { type: 'PERSONAL', startDate: day(25), endDate: day(25), reason: Q('dupe') });
    log('Self-service', 'duplicate time-off for same day rejected', dupe.status >= 400, `${dupe.status} ${dupe.body?.error?.message ?? dupe.body?.request?.status}`); expect.soft(dupe.status, 'second request for the same day accepted').toBeGreaterThanOrEqual(400);
    if (dupe.body?.request?.id) await call(a1, 'POST', `/me/time-off/${dupe.body.request.id}/cancel`, {});
    if (to.body?.request?.id) { const c = await call(a1, 'POST', `/me/time-off/${to.body.request.id}/cancel`, {}); log('Self-service', 'cancel own approved future time off', c.status === 200, c.status); }
    // giveaway by agent1, take by agent3
    const sched = (await call(a1, 'GET', '/me/schedule')).body;
    const shifts: any[] = (sched.days ?? []).map((d: any) => d.shift).filter((s: any) => s && s.day > day(1));
    log('Self-service', 'agent sees own upcoming shifts', shifts.length > 0, shifts.length); expect.soft(shifts.length).toBeGreaterThan(0);
    if (shifts[0]) {
      const g = await call(a1, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: shifts[0].id, note: Q('giveaway') });
      log('Self-service', 'post shift giveaway', g.status === 201, `${g.status} ${g.body?.error?.message ?? ''}`); expect.soft(g.status).toBe(201);
      const twice = await call(a1, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: shifts[0].id, note: Q('twice') });
      log('Self-service', 'same shift cannot be offered twice', twice.status >= 400, `${twice.status} ${twice.body?.error?.message ?? ''}`); expect.soft(twice.status).toBeGreaterThanOrEqual(400);
      if (g.body?.id) {
        const self = await call(a1, 'POST', `/me/swaps/${g.body.id}/take`, {});
        log('Self-service', 'cannot take own giveaway', self.status >= 400, `${self.status} ${self.body?.error?.message ?? ''}`); expect.soft(self.status).toBeGreaterThanOrEqual(400);
        const take = await call(a3, 'POST', `/me/swaps/${g.body.id}/take`, {});
        log('Self-service', 'another agent takes the giveaway (rules permitting)', take.status < 500, `${take.status} ${take.body?.status ?? take.body?.error?.message ?? ''}`); expect.soft(take.status).toBeLessThan(500);
        const pending = await call(A, 'GET', '/scheduling/swaps');
        log('Self-service', 'manager sees swap queue', pending.status === 200, Array.isArray(pending.body) ? pending.body.length : pending.status);
        await call(a1, 'POST', `/me/swaps/${g.body.id}/cancel`, {});
      }
    }
    const offers = (await call(a1, 'GET', '/me/offers')).body;
    const o = (Array.isArray(offers) ? offers : offers.open ?? [])[0];
    if (o) log('Self-service', 'offer shows its group name to the agent', !!o.groupName, `groupName="${o.groupName}"`);
    if (o) {
      const acc = await call(a1, 'POST', `/me/offers/${o.id}/accept`, {});
      log('Self-service', `accept ${o.kind} offer`, acc.status < 500, `${acc.status} ${acc.body?.error?.message ?? acc.body?.status ?? ''}`); expect.soft(acc.status).toBeLessThan(500);
    } else log('Self-service', 'VTO/OT offer visible to agent', false, 'no offers listed for demo.agent1');
  });
});
