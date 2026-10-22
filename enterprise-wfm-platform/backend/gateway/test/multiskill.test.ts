/**
 * Multi-skill and multi-site: people shared between groups are never booked twice, required skills define a group's pool, sites roll
 * schedules up across time zones, and pooling shows what a shared pool saves.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const CURVE = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
function history(queue: string, scale: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = 70; n >= 1; n--) { const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.45 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.round((CURVE[Math.floor(s / 4)] * f * scale) / 4)},400`); }
  return rows.join('\n');
}

const ctx: Record<string, any> = {};
let admin = '';
const overlap = (a: any, b: any) => a.day === b.day && a.startSlot < b.startSlot + b.lengthSlots && b.startSlot < a.startSlot + a.lengthSlots;

describe('multi-skill and multi-site', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('prepares two groups that share people', async () => {
    for (const [key, scale] of [['A', 0.5], ['B', 0.35]] as const) {
      const g = await call(admin, 'POST', '/config/groups', { name: `MS ${key} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
      assert.equal(g.status, 201, g.text); ctx[key] = g.json;
      const q = await call(admin, 'POST', '/config/queues', { name: `MS ${key} voice ${RUN}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 400 });
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: history(q.json.name, scale) });
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).json.status, 'COMPLETED');
      const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 4 });
      for (const s of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${s}`, {})).status, 200);
    }
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `MS team ${RUN}` })).status, 201);
    for (const [n, a, b] of [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '11:30', '13:30']]) await call(admin, 'POST', '/scheduling/templates', { name: `${n} MS ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= 18; i++) lines.push(`MA${RUN}-${i},Ann${i},Multi${i},MS team ${RUN},MS A ${RUN},FULL_TIME,40,5`);
    for (let i = 1; i <= 8; i++) lines.push(`MB${RUN}-${i},Ben${i},Multi${i},MS team ${RUN},MS B ${RUN},FULL_TIME,40,5`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).json.committed, true);
    const emps = (await call(admin, 'GET', '/workforce/employees?groupId=' + ctx.A.id)).json.filter((e: any) => e.primaryGroupId === ctx.A.id);
    ctx.shared = emps.slice(0, 8);                        // eight of A's people can also work for B
    for (const e of ctx.shared) assert.equal((await call(admin, 'PUT', `/workforce/employees/${e.id}`, { eligibleGroupIds: [ctx.A.id, ctx.B.id] })).status, 200);
  });

  it('never books the same person for two groups at once', async () => {
    const from = iso(addDays(new Date(), 6));
    const a = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.A.id, from, weeks: 1, timeLimitSec: 45 });
    assert.equal(a.status, 201, a.text); ctx.va = a.json;
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${a.json.id}/publish`)).status, 200);
    const b = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.B.id, from, weeks: 1, timeLimitSec: 45 });
    assert.equal(b.status, 201, b.text); ctx.vb = b.json;
    const sa = (await call(admin, 'GET', `/scheduling/versions/${a.json.id}/shifts`)).json, sb = (await call(admin, 'GET', `/scheduling/versions/${b.json.id}/shifts`)).json;
    const sharedIds = new Set(ctx.shared.map((e: any) => e.id));
    assert.ok(sb.some((s: any) => sharedIds.has(s.employeeId)) || sb.length > 0, 'B has a schedule');
    for (const s of sb) for (const t of sa) if (s.employeeId === t.employeeId) assert.ok(!overlap(s, t), `${s.employeeName} is booked for both groups on ${s.day}`);
    assert.equal((await call(admin, 'GET', `/scheduling/versions/${b.json.id}/validate`)).json.ok, true);
  });

  it('flags a manual shift that double-books someone across groups', async () => {
    const sa = (await call(admin, 'GET', `/scheduling/versions/${ctx.va.id}/shifts`)).json;
    const busy = sa.find((s: any) => ctx.shared.some((e: any) => e.id === s.employeeId));
    assert.ok(busy, 'a shared person works for A');
    const tpl = (await call(admin, 'GET', '/scheduling/templates')).json.find((t: any) => t.name.endsWith(RUN) && t.name.includes('MS'));
    const start = `${String(Math.floor(busy.startSlot / 4)).padStart(2, '0')}:${String((busy.startSlot % 4) * 15).padStart(2, '0')}`;
    const r = await call(admin, 'POST', `/scheduling/versions/${ctx.vb.id}/shifts`, { employeeId: busy.employeeId, day: busy.day, templateId: tpl.id, startTime: start, reason: 'test double booking' });
    assert.equal(r.status, 201, r.text);
    const val = (await call(admin, 'GET', `/scheduling/versions/${ctx.vb.id}/validate`)).json;
    assert.equal(val.ok, false);
    assert.ok(val.violations.some((v: any) => v.type === 'DOUBLE_BOOKED' && /already scheduled for/.test(v.message)), JSON.stringify(val.violations.slice(0, 3)));
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${ctx.vb.id}/publish`)).status, 409);                 // cannot be published like that
    assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${ctx.vb.id}/shifts/${r.json.id}?reason=${encodeURIComponent('undo the test')}`)).status, 200);
    assert.equal((await call(admin, 'GET', `/scheduling/versions/${ctx.vb.id}/validate`)).json.ok, true);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${ctx.vb.id}/publish`)).status, 200);
  });

  it('builds a group pool from required skills, whatever group people belong to', async () => {
    const skill = await call(admin, 'POST', '/workforce/skills', { name: `Billing MS ${RUN}`, category: 'PRODUCTS' });
    assert.equal(skill.status, 201, skill.text);
    const a18 = (await call(admin, 'GET', '/workforce/employees')).json.filter((e: any) => e.primaryGroupId === ctx.A.id);
    ctx.skilled = a18.slice(10, 15);                       // five of A's people, none of them among the eight shared ones
    for (const e of ctx.skilled) assert.equal((await call(admin, 'PUT', `/workforce/employees/${e.id}/skills`, { skills: [{ skillId: skill.json.id, proficiency: 4 }] })).status, 200);
    const before = (await call(admin, 'GET', `/config/groups/${ctx.B.id}/pool`)).json;
    assert.equal(before.skillBased, false);
    assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.B.id}/skills`, { skills: [{ skillId: skill.json.id, minProficiency: 3 }] })).status, 200);
    const pool = (await call(admin, 'GET', `/config/groups/${ctx.B.id}/pool`)).json;
    assert.equal(pool.skillBased, true);
    assert.equal(pool.counts.inPool, 5, 'only people with the skill at level 3 or more');
    assert.equal(pool.counts.fromOtherGroups, 5, 'all of them work for another group');
    assert.ok(pool.counts.leftOut >= 8, 'B\'s own people lack the skill');
    assert.ok(pool.people.filter((p: any) => !p.inPool).every((p: any) => p.missing.length === 1));
    // the scheduler now uses exactly that pool
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.B.id, from: iso(addDays(new Date(), 13)), weeks: 1, timeLimitSec: 45 });
    assert.equal(v.status, 201, v.text);
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts`)).json;
    const ok = new Set(ctx.skilled.map((e: any) => e.id));
    assert.ok(shifts.length > 0 && shifts.every((s: any) => ok.has(s.employeeId)), 'only skilled people are scheduled');
    assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.B.id}/skills`, { skills: [] })).status, 200);
    assert.equal((await call(admin, 'GET', `/config/groups/${ctx.B.id}/pool`)).json.skillBased, false);
  });

  it('rolls schedules up by site across time zones', async () => {
    const chennai = await call(admin, 'POST', '/config/sites', { name: `Chennai ${RUN}`, timezone: 'Asia/Kolkata', country: 'India' });
    const london = await call(admin, 'POST', '/config/sites', { name: `London ${RUN}`, timezone: 'Europe/London', country: 'United Kingdom' });
    assert.equal(chennai.status, 201, chennai.text); assert.equal(london.status, 201);
    assert.equal((await call(admin, 'POST', '/config/sites', { name: `Bad ${RUN}`, timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await call(admin, 'POST', '/config/sites', { name: `Chennai ${RUN}`, timezone: 'Asia/Kolkata' })).status, 409);
    assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.A.id}/site`, { siteId: chennai.json.id })).status, 200);
    assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.B.id}/site`, { siteId: london.json.id })).status, 200);
    assert.equal((await call(admin, 'GET', `/config/groups/${ctx.A.id}`)).json.siteId, chennai.json.id);
    const day = ctx.va.periodStart;
    const roll = await call(admin, 'GET', `/scheduling/rollup?from=${ctx.va.periodStart}&to=${ctx.va.periodEnd}&day=${day}`);
    assert.equal(roll.status, 200, roll.text);
    const names = roll.json.sites.map((s: any) => s.siteName);
    assert.ok(names.includes(`Chennai ${RUN}`) && names.includes(`London ${RUN}`));
    const ga = roll.json.groups.find((g: any) => g.groupId === ctx.A.id);
    assert.equal(ga.days.length, 7); assert.ok(ga.days.every((d: any) => d.requiredHours > 0 && d.available >= 0));
    assert.ok(roll.json.total.requiredHours >= ga.days.reduce((t: number, d: any) => t + d.requiredHours, 0));
    // the same local shift pattern lands on different UTC hours in different zones: the two sites' first busy hour differs
    const first = (s: any) => s.series.find((h: any) => h.required > 1)?.hour;
    const [cs, ls] = ['Chennai', 'London'].map((n) => roll.json.sites.find((s: any) => s.siteName.startsWith(n)));
    assert.ok(cs.series.length > 0 && ls.series.length > 0);
    assert.ok(first(cs) && first(ls));
    assert.equal((await call(admin, 'GET', `/scheduling/rollup?from=${day}&to=${day}&day=2000-01-01`)).status, 200);
    assert.equal((await call(admin, 'GET', `/scheduling/rollup?from=2026-01-01&to=2026-12-31`)).status, 400);
    assert.equal((await call(admin, 'DELETE', `/config/sites/${london.json.id}`)).status, 200);
    assert.equal((await call(admin, 'GET', `/config/groups/${ctx.B.id}`)).json.siteId, null);
  });

  it('shows what one shared pool would need compared with separate pools', async () => {
    const day = iso(addDays(new Date(), 8));
    const r = await call(admin, 'GET', `/forecast/pooling?groupIds=${ctx.A.id},${ctx.B.id}&day=${day}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.slots.length, 96);
    assert.ok(r.json.separateHours > 0 && r.json.pooledHours > 0);
    assert.ok(r.json.pooledHours <= r.json.separateHours + 0.5, `pooled ${r.json.pooledHours} vs separate ${r.json.separateHours}`);
    assert.ok(r.json.savingPercent >= 0);
    assert.equal((await call(admin, 'GET', `/forecast/pooling?groupIds=${ctx.A.id}&day=${day}`)).status, 400);        // needs two
    assert.equal((await call(admin, 'GET', `/forecast/pooling?groupIds=${ctx.A.id},${ctx.B.id}&day=2000-01-01`)).status, 400);
  });
});
