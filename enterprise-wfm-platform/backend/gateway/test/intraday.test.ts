/**
 * Intraday: per-group activity settings, the RTA state map, state events, adherence and live coverage.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 * Uses yesterday so the result does not depend on the time of day the suite runs.
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
const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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
const AV = `Available ${RUN}`, NR = `Not Ready ${RUN}`, LO = `Logged Out ${RUN}`, MY = `Mystery ${RUN}`;
const GROUP = `Intra ${RUN}`, QUEUE = `Intra Voice ${RUN}`, TEAM = `Beta ${RUN}`;

describe('intraday and adherence', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    ctx.day = iso(addDays(new Date(), -1));
  });

  it('builds a group, a published forecast and a published schedule for yesterday', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: GROUP, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: QUEUE, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(QUEUE, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 2, fromDay: ctx.day });
    assert.equal(f.status, 201, f.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
    const t = await call(admin, 'POST', '/workforce/teams', { name: TEAM }); ctx.team = t.json;
    assert.equal((await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 60, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 })).status, 201);
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= 12; i++) lines.push(`I${RUN}-${i},Agent${i},Rta${i},${TEAM},${GROUP},FULL_TIME,40,7`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).status, 200);
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: ctx.day, weeks: 1, timeLimitSec: 10 });
    assert.equal(v.status, 201, v.text);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`)).status, 200);
    ctx.shifts = (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts?from=${ctx.day}&to=${ctx.day}`)).json;
    assert.ok(ctx.shifts.length >= 3, 'need some shifts yesterday');
  });

  it('keeps one activity list but lets each group override it', async () => {
    const mk = async (name: string, category: string, countsAsWork: boolean, paid = true, shrinkage = false) => (await call(admin, 'POST', '/config/activities', { name: `${name} ${RUN}`, category, countsAsWork, paid, shrinkage, color: '#DCEBFA' })).json;
    ctx.work = await mk('Work', 'WORK', true); ctx.brk = await mk('Break', 'BREAK', false, true, true); ctx.meal = await mk('Meal', 'MEAL', false, false);
    const g2 = await call(admin, 'POST', '/config/groups', { name: `Other ${RUN}` }); assert.equal(g2.status, 201);
    const before = (await call(admin, 'GET', `/config/groups/${g2.json.id}/activities`)).json.find((a: any) => a.id === ctx.brk.id);
    assert.equal(before.overridden, false); assert.equal(before.shrinkage, true);
    const put = await call(admin, 'PUT', `/config/groups/${g2.json.id}/activities/${ctx.brk.id}`, { enabled: false, shrinkage: false, paid: null });
    assert.equal(put.status, 200, put.text); assert.equal(put.json.overridden, true); assert.equal(put.json.enabled, false); assert.equal(put.json.shrinkage, false);
    assert.equal(put.json.paid, true, 'null falls back to the company setting');
    const mine = (await call(admin, 'GET', `/config/groups/${ctx.group.id}/activities`)).json.find((a: any) => a.id === ctx.brk.id);
    assert.equal(mine.overridden, false, 'another group is not affected');
    assert.equal((await call(admin, 'DELETE', `/config/groups/${g2.json.id}/activities/${ctx.brk.id}`)).status, 204);
    assert.equal((await call(admin, 'GET', `/config/groups/${g2.json.id}/activities`)).json.find((a: any) => a.id === ctx.brk.id).overridden, false);
  });

  it('maps ACD states and reason codes to activities', async () => {
    const add = (state: string, reason: string, activityId: string | null) => call(admin, 'POST', '/intraday/state-map', { state, reason, activityId });
    assert.equal((await add(AV, '', ctx.work.id)).status, 201);
    assert.equal((await add(NR, 'Break', ctx.brk.id)).status, 201);
    assert.equal((await add(NR, 'Lunch', ctx.meal.id)).status, 201);
    assert.equal((await add(LO, '', null)).status, 201);
    assert.equal((await add(AV.toLowerCase(), '', ctx.work.id)).status, 409, 'state + reason is unique, case-insensitive');
    assert.ok((await call(admin, 'GET', '/intraday/state-map')).json.filter((m: any) => m.state.endsWith(RUN)).length === 4);
  });

  it('scores adherence from state events against the published schedule', async () => {
    const [a, b, c] = ctx.shifts;
    const at = (m: number) => `${ctx.day}T${clock(m)}:00Z`;
    const ev: any[] = [];
    // a: sits in Available all shift (never takes the scheduled meal or breaks), then logs out
    ev.push({ employeeNumber: a.employeeNumber, state: AV, at: at(a.startSlot * 15) }, { employeeNumber: a.employeeNumber, state: LO, at: at((a.startSlot + a.lengthSlots) * 15) });
    // b: follows the schedule exactly
    const plan = [
      { from: b.startSlot * 15, st: AV, r: '' },
      ...b.activities.map((x: any) => ({ from: x.startSlot * 15, st: NR, r: x.type === 'MEAL' ? 'Lunch' : 'Break' })),
      ...b.activities.map((x: any) => ({ from: (x.startSlot + x.slots) * 15, st: AV, r: '' })),
      { from: (b.startSlot + b.lengthSlots) * 15, st: LO, r: '' },
    ];
    for (const s of plan) ev.push({ employeeNumber: b.employeeNumber, state: s.st, reason: s.r, at: at(s.from) });
    // c: an ACD state nobody has mapped yet
    ev.push({ employeeNumber: c.employeeNumber, state: MY, at: at(c.startSlot * 15) });
    ev.push({ employeeNumber: 'NOPE', state: AV });
    const r = await call(admin, 'POST', '/intraday/events', { events: ev });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.accepted, ev.length - 1); assert.equal(r.json.errors.length, 1);

    const out = await call(admin, 'GET', `/intraday/adherence?groupId=${ctx.group.id}&day=${ctx.day}`);
    assert.equal(out.status, 200, out.text);
    const by = (n: string) => out.json.agents.find((x: any) => x.employeeNumber === n);
    assert.equal(by(b.employeeNumber).dayPercent, 100, 'b followed the schedule');
    assert.equal(by(b.employeeNumber).status, 'IN');
    if (a.activities.length) assert.ok(by(a.employeeNumber).dayPercent < 100, 'a skipped the meal and breaks, so was out of adherence beyond the grace period');
    assert.equal(by(c.employeeNumber).status, 'UNKNOWN');
    assert.deepEqual(out.json.unmappedStates.map((u: any) => u.state), [MY]);
    assert.ok(out.json.summary.total >= 3 && out.json.publishedSchedule && out.json.hasEvents);
  });

  it('shows live coverage against the published forecast and the schedule', async () => {
    const r = await call(admin, 'GET', `/intraday/coverage?groupId=${ctx.group.id}&day=${ctx.day}`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.ready, true);
    assert.equal(r.json.slots.length, 96);
    assert.ok(r.json.slots.some((s: any) => s.scheduled > 0) && r.json.slots.some((s: any) => s.required > 0));
    // the dashboard's day detail: last week's volume, handle time, day-level figures, and a specific forecast by id
    assert.ok(r.json.slots.some((x: any) => x.historical !== null && x.aht > 0), 'last week and handle time are present');
    assert.ok(r.json.stats.peakRequired > 0 && r.json.stats.serviceLevel > 0 && 'coveragePercent' in r.json.stats && 'wape' in r.json.stats);
    const byId = await call(admin, 'GET', `/intraday/coverage?groupId=${ctx.group.id}&day=${ctx.day}&versionId=${r.json.versionId}`);
    assert.equal(byId.json.ready, true); assert.equal(byId.json.versionId, r.json.versionId);
    assert.equal((await call(admin, 'GET', `/intraday/coverage?groupId=${ctx.group.id}&day=${ctx.day}&versionId=00000000-0000-4000-8000-000000000000`)).json.ready, false);
    const none = await call(admin, 'GET', `/intraday/coverage?groupId=${ctx.group.id}&day=2001-01-01`);
    assert.equal(none.json.ready, false); assert.match(none.json.reason, /does not cover/);
  });
});
