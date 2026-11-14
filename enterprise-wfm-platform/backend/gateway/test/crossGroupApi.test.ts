/**
 * One person in several WFM groups (a real build against the engine): a published schedule in one group uses up that person's days and hours for the others,
 * a draft built beside another draft warns, and publishing a clash is refused.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36).slice(-5);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const mondayInWeeks = (weeks: number) => { const d = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())); d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + weeks * 7); return iso(d); };
const START = mondayInWeeks(3);              // a Monday well ahead of the past-day lock
const dayOf = (n: number) => iso(new Date(Date.parse(START) + n * 86400000));

const ctx: Record<string, any> = {};
let admin = '';
const g: Record<string, string> = {};
let ramesh = '';
let tpls: string[] = [];
const build = (k: string, extra: Record<string, unknown> = {}) => call(admin, 'POST', '/scheduling/versions', { groupId: g[k], from: START, weeks: 1, timeLimitSec: 20, templateIds: tpls, coverageSource: 'MANUAL', deterministic: true, ...extra });
const days = async (versionId: string) => ((await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json as any[]).filter((s) => s.employeeId === ramesh).map((s) => s.day).sort();

describe('one person in several WFM groups', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    for (const k of ['A', 'B']) {
      const r = await call(admin, 'POST', '/config/groups', { name: `Share ${k} ${RUN}` });
      assert.equal(r.status, 201, r.text); g[k] = r.json.id;
      for (let dow = 0; dow < 7; dow++) assert.equal((await call(admin, 'POST', `/config/groups/${g[k]}/coverage-windows`, { dayOfWeek: dow, startTime: k === 'A' ? '06:00' : '08:00', endTime: k === 'A' ? '14:00' : '16:00', headcount: 1 })).status, 201);
    }
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,wfm_group,employment_type,weekly_hours,days_per_week\nX${RUN},Ramesh,Share${RUN},Share A ${RUN},FULL_TIME,40,5`, dryRun: false });
    assert.equal(imp.status, 200, imp.text);
    const list = (await call(admin, 'GET', '/workforce/employees?q=Ramesh&status=ACTIVE')).json;
    const emp = (Array.isArray(list) ? list : list.items).find((e: any) => e.employeeNumber === `X${RUN}`);
    ramesh = emp.id;
    const up = await call(admin, 'PUT', `/workforce/employees/${ramesh}`, { eligibleGroupIds: [g.A, g.B], version: emp.version, reason: 'shared between groups' });
    assert.equal(up.status, 200, up.text);
    tpls = ((await call(admin, 'GET', '/scheduling/templates')).json as any[]).filter((t) => t.status === 'ACTIVE').map((t) => t.id);
    assert.ok(tpls.length > 0, 'the company needs at least one active shift template');
  });

  it('warns, naming the person and the other schedule, when a draft is built beside another draft', async () => {
    const a = await build('A'); assert.equal(a.status, 201, a.text);
    ctx.a = a.json;
    const ready = (await call(admin, 'GET', `/scheduling/readiness?groupId=${g.B}&from=${START}&weeks=1&coverageSource=MANUAL`)).json;
    assert.equal(ready.shared.drafts.length, 1); assert.match(ready.shared.drafts[0].examples[0].name, /Ramesh/);
    // built with "use shared people anyway": by default the home group's draft would already keep him away from A's days
    const b = await build('B', { guests: 'ALWAYS' }); assert.equal(b.status, 201, b.text);
    ctx.b1 = b.json;
    const rep = (await call(admin, 'GET', `/scheduling/versions/${b.json.id}/report`)).json;
    const w = rep.exceptions.find((e: any) => e.code === 'OVERLAPPING_DRAFT');
    assert.ok(w, JSON.stringify(rep.exceptions.map((e: any) => e.code)));
    assert.match(w.message, /Ramesh/); assert.match(w.message, new RegExp(`Share A ${RUN}`)); assert.equal(w.level, 'WARNING');
  });

  it('refuses to publish the draft that was built beside a schedule that is published first', async () => {
    // A keeps only Mon-Wed for him, then is published
    const mine = ((await call(admin, 'GET', `/scheduling/versions/${ctx.a.id}/shifts`)).json as any[]).filter((s) => s.employeeId === ramesh);
    for (const s of mine.filter((x) => x.day > dayOf(2))) assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.a.id}/shifts/${s.id}?reason=keep%20three%20days`)).status, 200);
    assert.deepEqual(await days(ctx.a.id), [dayOf(0), dayOf(1), dayOf(2)]);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${ctx.a.id}/publish`, {})).status, 200);
    const late = await call(admin, 'POST', `/scheduling/versions/${ctx.b1.id}/publish`, {});
    assert.equal(late.status, 409, late.text); assert.match(late.json.error.message, /already scheduled for Share A/);
  });

  it('counts the days and hours worked for the other group: 3 there leaves 2 here, never 5', async () => {
    const b = await build('B'); assert.equal(b.status, 201, b.text);
    const got = await days(b.json.id);
    assert.equal(got.length, 2, JSON.stringify(got));
    assert.ok(got.every((d) => d > dayOf(2)), `none on the days worked for A: ${got}`);
    const rep = (await call(admin, 'GET', `/scheduling/versions/${b.json.id}/report`)).json;
    assert.ok(rep.exceptions.some((e: any) => e.code === 'SHARED_PEOPLE' && /Share A/.test(e.message)));
    const pub = await call(admin, 'POST', `/scheduling/versions/${b.json.id}/publish`, {});
    assert.equal(pub.status, 200, pub.text);
    const all = ((await call(admin, 'GET', `/scheduling/employees/${ramesh}/shifts?from=${START}&to=${dayOf(6)}`)).json as any[]).filter((s) => s.versionStatus === 'PUBLISHED');
    assert.equal(new Set(all.map((s) => s.day)).size, 5, 'five days across both groups, the contract');
    for (const d of new Set(all.map((s) => s.day))) assert.equal(all.filter((s) => s.day === d).length, 1, `one shift on ${d}`);
  });
});

describe('home group: a guest gets only the time the home group leaves free', () => {
  const h: Record<string, string> = {};
  let guest = '';
  const buildH = (k: string, extra: Record<string, unknown> = {}) => call(admin, 'POST', '/scheduling/versions', { groupId: h[k], from: START, weeks: 1, timeLimitSec: 20, templateIds: tpls, coverageSource: 'MANUAL', deterministic: true, ...extra });
  const daysH = async (versionId: string) => ((await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json as any[]).filter((s) => s.employeeId === guest).map((s) => s.day).sort();

  before(async () => {
    for (const k of ['HOME', 'AWAY']) {
      const r = await call(admin, 'POST', '/config/groups', { name: `Home ${k} ${RUN}` });
      assert.equal(r.status, 201, r.text); h[k] = r.json.id;
      for (let dow = 0; dow < 7; dow++) assert.equal((await call(admin, 'POST', `/config/groups/${h[k]}/coverage-windows`, { dayOfWeek: dow, startTime: '08:00', endTime: '16:00', headcount: 1 })).status, 201);
    }
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: `employee_number,first_name,last_name,wfm_group,employment_type,weekly_hours,days_per_week
H${RUN},Hari,Home${RUN},Home HOME ${RUN},FULL_TIME,40,5`, dryRun: false })).status, 200);
    const list = (await call(admin, 'GET', '/workforce/employees?q=Hari&status=ACTIVE')).json;
    const emp = (Array.isArray(list) ? list : list.items).find((e: any) => e.employeeNumber === `H${RUN}`);
    guest = emp.id;
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${guest}`, { eligibleGroupIds: [h.HOME, h.AWAY], version: emp.version, reason: 'works for two groups' })).status, 200);
  });

  it('holds a guest back while his home group has no schedule for the dates, and says so', async () => {
    const away = await buildH('AWAY');
    assert.equal(away.status, 400, away.text);
    assert.match(away.json.error.message, /held back until their home group has a schedule/);
    const ready = (await call(admin, 'GET', `/scheduling/readiness?groupId=${h.AWAY}&from=${START}&weeks=1&coverageSource=MANUAL`)).json;
    assert.deepEqual(ready.guests.map((g: any) => [g.name, g.people, g.scheduled]), [[`Home HOME ${RUN}`, 1, false]]);
  });

  it('"use them anyway" restores the old behaviour', async () => {
    const away = await buildH('AWAY', { guests: 'ALWAYS' });
    assert.equal(away.status, 201, away.text);
    assert.ok((await daysH(away.json.id)).length >= 1);
  });

  it('respects what the home group has drafted: he gets only the days it leaves free, never the same day twice', async () => {
    const home = await buildH('HOME'); assert.equal(home.status, 201, home.text);
    const homeDays = await daysH(home.json.id);
    assert.ok(homeDays.length >= 1);
    // the home group keeps him on 3 of those days; the draft is enough, nothing is published
    const keep = homeDays.slice(0, 3);
    const mine = ((await call(admin, 'GET', `/scheduling/versions/${home.json.id}/shifts`)).json as any[]).filter((s) => s.employeeId === guest);
    for (const s of mine.filter((x) => !keep.includes(x.day))) assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${home.json.id}/shifts/${s.id}?reason=keep%20three%20days`)).status, 200);
    const away = await buildH('AWAY'); assert.equal(away.status, 201, away.text);
    const got = await daysH(away.json.id);
    assert.equal(got.length, 2, `his home draft has him on 3 days, so the other group gets the 2 left of 5: ${got}`);
    assert.ok(got.every((d) => !keep.includes(d)), `none of the days the home group has him: ${got} vs ${keep}`);
    const info = ((await call(admin, 'GET', `/scheduling/versions/${away.json.id}/report`)).json.exceptions as any[]).find((e) => e.code === 'GUESTS');
    assert.ok(info && info.level === 'INFO', JSON.stringify(info));
  });
});
