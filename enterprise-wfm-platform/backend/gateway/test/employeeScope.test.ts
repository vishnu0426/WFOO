/**
 * Narrowing schedule generation to chosen employees or teams, linking an employee to a WFM group by hand, and
 * listing schedule versions across every group with the group's name attached.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
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
const nextMonday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return iso(addDays(t, (7 - ((t.getDay() + 6) % 7)) % 7 || 7)); };

function historyCsv(queue: string, days: number) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n);
    for (let s = 32; s < 40; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},4,300`);
  }
  return rows.join('\n');
}

async function buildGroup(admin: string, tag: string) {
  const group = `Scope ${tag} ${RUN}`, queue = `Scope Voice ${tag} ${RUN}`;
  const g = await call(admin, 'POST', '/config/groups', { name: group, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 });
  assert.equal(g.status, 201, g.text);
  assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
  const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 35) });
  assert.equal(up.status, 201, up.text);
  assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
  const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 3 });
  assert.equal(f.status, 201, f.text);
  for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
  const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${tag} ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '08:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
  assert.equal(t.status, 201, t.text);
  return { group: g.json, template: t.json };
}

const ctx: Record<string, any> = {};
let admin = '';

describe('employee and team scope at generate time, and the cross-group schedules list', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('prepares a group with two teams of people and a published forecast', async () => {
    const built = await buildGroup(admin, 'A');
    ctx.group = built.group; ctx.tpl = built.template;
    const t1 = await call(admin, 'POST', '/workforce/teams', { name: `Alpha ${RUN}` }); assert.equal(t1.status, 201, t1.text);
    const t2 = await call(admin, 'POST', '/workforce/teams', { name: `Bravo ${RUN}` }); assert.equal(t2.status, 201, t2.text);
    ctx.teamA = t1.json; ctx.teamB = t2.json;
    ctx.empA = []; ctx.empB = [];
    for (let i = 1; i <= 3; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SA${RUN}-${i}`, firstName: `AlphaP${i}`, lastName: 'Test', teamId: ctx.teamA.id, primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
      assert.equal(e.status, 201, e.text); ctx.empA.push(e.json);
    }
    for (let i = 1; i <= 3; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SB${RUN}-${i}`, firstName: `BravoP${i}`, lastName: 'Test', teamId: ctx.teamB.id, primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
      assert.equal(e.status, 201, e.text); ctx.empB.push(e.json);
    }
    ctx.from = nextMonday();
  });

  it('links an unrelated employee into the group by adding it to eligibleGroupIds, without touching their primary group', async () => {
    const other = await call(admin, 'POST', '/config/groups', { name: `Scope Other ${RUN}` });
    assert.equal(other.status, 201, other.text);
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SO${RUN}`, firstName: 'Outside', lastName: 'Person', primaryGroupId: other.json.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text);
    assert.equal((await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json.some((x: any) => x.id === e.json.id), false, 'not a member yet');
    const linked = await call(admin, 'PUT', `/workforce/employees/${e.json.id}`, { eligibleGroupIds: [...e.json.eligibleGroupIds, ctx.group.id] });
    assert.equal(linked.status, 200, linked.text);
    assert.deepEqual(new Set(linked.json.eligibleGroupIds), new Set([other.json.id, ctx.group.id]));
    assert.equal(linked.json.primaryGroupId, other.json.id, 'primary group is unchanged');
    const members = (await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`)).json;
    assert.ok(members.some((x: any) => x.id === e.json.id), 'now shows up as a member of this group');
  });

  it('narrows generation to only the employees chosen, when employeeIds is given', async () => {
    const chosen = [ctx.empA[0].id, ctx.empB[0].id];
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 15, templateIds: [ctx.tpl.id], employeeIds: chosen });
    assert.equal(r.status, 201, r.text);
    assert.ok(r.json.stats.people <= chosen.length, `only chose from ${chosen.length} people, got ${r.json.stats.people}`);
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${r.json.id}/shifts`)).json;
    assert.ok(shifts.every((s: any) => chosen.includes(s.employeeId)), 'every shift belongs to a chosen employee');
  });

  it('narrows generation to only the teams chosen, when teamIds is given', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 15, templateIds: [ctx.tpl.id], teamIds: [ctx.teamA.id] });
    assert.equal(r.status, 201, r.text);
    const teamAIds = new Set(ctx.empA.map((e: any) => e.id));
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${r.json.id}/shifts`)).json;
    assert.ok(shifts.length > 0, 'at least one shift was generated');
    assert.ok(shifts.every((s: any) => teamAIds.has(s.employeeId)), 'every shift belongs to a team Alpha employee');
  });

  it('refuses when the chosen employees/teams have nobody active in the group', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, templateIds: [ctx.tpl.id], employeeIds: ['00000000-0000-0000-0000-000000000000'] });
    assert.equal(r.status, 400, r.text);
    assert.match(r.text, /No active employees match/);
  });

  it('lists schedule versions across every group, each with its group name attached', async () => {
    const built = await buildGroup(admin, 'B');
    const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SC${RUN}`, firstName: 'Group', lastName: 'Two', primaryGroupId: built.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e.status, 201, e.text);
    const gen = await call(admin, 'POST', '/scheduling/versions', { groupId: built.group.id, from: nextMonday(), weeks: 1, timeLimitSec: 15, templateIds: [built.template.id] });
    assert.equal(gen.status, 201, gen.text);

    const all = await call(admin, 'GET', '/scheduling/versions');
    assert.equal(all.status, 200, all.text);
    const groupIds = new Set(all.json.map((v: any) => v.wfmGroupId));
    assert.ok(groupIds.has(ctx.group.id) && groupIds.has(built.group.id), 'includes versions from both groups with no groupId filter');
    const mine = all.json.find((v: any) => v.wfmGroupId === built.group.id);
    assert.equal(mine.groupName, built.group.name);
  });
});
