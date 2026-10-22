/**
 * The compliance rule-pack resolution chain, most specific wins: an employee's own override, else their team's pack,
 * else their WFM group's, else the whole organisation's. Confirmed end to end by assigning a strict pack (India: no
 * night work without consent) and a lenient one (no rules at all) at each scope in turn and watching a manual night
 * shift gain or lose its LAW_NIGHT_WORK violation.
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

const ctx: Record<string, any> = {};
let admin = '';

describe('compliance rule-pack override: employee beats team beats group beats tenant', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('prepares a group, a team of two, a published forecast, a day template and a night-window template', async () => {
    const group = `Override ${RUN}`, queue = `Override Voice ${RUN}`;
    const g = await call(admin, 'POST', '/config/groups', { name: group, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 35) });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 3 });
    assert.equal(f.status, 201, f.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);

    const day = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '08:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
    assert.equal(day.status, 201, day.text); ctx.dayTpl = day.json;
    const night = await call(admin, 'POST', '/scheduling/templates', { name: `Night ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '20:00', latestStart: '20:00', startStepMinutes: 30, durationHours: 2, mealMinutes: 0, breakCount: 0 });
    assert.equal(night.status, 201, night.text); ctx.nightTpl = night.json;

    const t = await call(admin, 'POST', '/workforce/teams', { name: `Override Team ${RUN}` }); assert.equal(t.status, 201, t.text); ctx.team = t.json;
    const e1 = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `OV1${RUN}`, firstName: 'Override', lastName: 'One', teamId: ctx.team.id, primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e1.status, 201, e1.text); ctx.e1 = e1.json;
    const e2 = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `OV2${RUN}`, firstName: 'Override', lastName: 'Two', teamId: ctx.team.id, primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
    assert.equal(e2.status, 201, e2.text); ctx.e2 = e2.json;

    const gen = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: nextMonday(), weeks: 1, timeLimitSec: 15, templateIds: [ctx.dayTpl.id] });
    assert.equal(gen.status, 201, gen.text); ctx.version = gen.json;

    const india = (await call(admin, 'GET', '/compliance/packs')).json.find((p: any) => p.code === 'IN_OSH_2020');
    assert.ok(india, 'India pack must exist'); ctx.india = india;
    const lenient = await call(admin, 'POST', '/compliance/packs', { name: `Lenient ${RUN}`, rules: [] });
    assert.equal(lenient.status, 201, lenient.text); ctx.lenient = lenient.json;
    ctx.day = nextMonday();
  });

  const nightShiftViolations = async (employeeId: string) => {
    const r = await call(admin, 'POST', `/scheduling/versions/${ctx.version.id}/shifts`, { employeeId, day: ctx.day, templateId: ctx.nightTpl.id, startTime: '20:00', reason: 'Testing the rule-pack override chain' });
    assert.equal(r.status, 201, r.text);
    return r.json.violations as { type: string }[];
  };
  const hasNightViolation = (violations: { type: string }[]) => violations.some((v) => v.type === 'LAW_NIGHT_WORK');

  it('inherits the tenant pack when nothing more specific is assigned', async () => {
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'TENANT', packId: ctx.india.id })).status, 200);
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e1.id)), true, 'tenant pack blocks night work');
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e2.id)), true);
  });

  it('a WFM group pack beats the tenant pack', async () => {
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'GROUP', scopeId: ctx.group.id, packId: ctx.lenient.id })).status, 200);
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e1.id)), false, 'group pack has no night-work rule');
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e2.id)), false);
  });

  it('a team pack beats the WFM group pack', async () => {
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'TEAM', scopeId: ctx.team.id, packId: ctx.india.id })).status, 200);
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e1.id)), true, 'team pack blocks night work again');
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e2.id)), true);
  });

  it('an employee override beats their team pack, and does not leak to a colleague on the same team', async () => {
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'EMPLOYEE', scopeId: ctx.e1.id, packId: ctx.lenient.id })).status, 200);
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e1.id)), false, "e1's personal override has no night-work rule");
    assert.equal(hasNightViolation(await nightShiftViolations(ctx.e2.id)), true, 'e2 still follows the team pack, unaffected by e1\'s override');
    const assigns = (await call(admin, 'GET', '/compliance/assignments')).json;
    const mine = assigns.find((a: any) => a.scopeType === 'EMPLOYEE' && a.scopeId === ctx.e1.id);
    assert.equal(mine.scopeName, `${ctx.e1.firstName} ${ctx.e1.lastName}`);
  });

  it('cleans up every assignment made in this suite', async () => {
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'EMPLOYEE', scopeId: ctx.e1.id, packId: null })).status, 200);
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'TEAM', scopeId: ctx.team.id, packId: null })).status, 200);
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'GROUP', scopeId: ctx.group.id, packId: null })).status, 200);
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'TENANT', packId: null })).status, 200);
    assert.equal((await call(admin, 'DELETE', `/compliance/packs/${ctx.lenient.id}`)).status, 200);
  });
});
