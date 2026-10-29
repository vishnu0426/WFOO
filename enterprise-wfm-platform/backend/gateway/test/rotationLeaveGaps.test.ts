/**
 * Rotations and approved time off, and the gaps that are left: a rotation does not put people on shifts during approved leave (and follows
 * approvals and cancellations made after it was generated); what the published roster still lacks is listed and can be offered as overtime,
 * to crew members on a day off as well.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const MON = '2026-11-02';   // a Monday in the future

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

const ctx: Record<string, any> = {};
let admin = '';
const person = async (n: number) => {
  const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `LG${RUN}-${n}`, firstName: `Person${n}`, lastName: 'Leave', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
  assert.equal(e.status, 201, e.text); return e.json;
};
const days = async (employeeId: string) => ((await call(admin, 'GET', `/scheduling/versions/${ctx.versionId}/shifts`)).json as any[]).filter((s) => s.employeeId === employeeId).map((s) => s.day as string).sort();
const leave = (employeeId: string, startDate: string, endDate: string, approve: boolean) => call(admin, 'POST', '/workforce/time-off', { employeeId, type: 'VACATION', startDate, endDate, approve });

describe('rotations: approved time off, and gaps offered as overtime', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Leave ${RUN}` });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '07:00', durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    ctx.people = [await person(1), await person(2), await person(3), await person(4)];
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '07:00', endTime: '15:00', headcount: 4 })).status, 201);
    const pat = await call(admin, 'POST', '/scheduling/rotations', { wfmGroupId: ctx.group.id, name: `Five on two off ${RUN}`, kind: 'DAY_CYCLE', cycleDays: 7, sequence: [ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, ctx.tpl.id, null, null], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorDate: MON });
    assert.equal(pat.status, 201, pat.text); ctx.pattern = pat.json;
    const m = await call(admin, 'PUT', `/scheduling/rotations/${ctx.pattern.id}/members`, { members: ctx.people.map((p: any) => ({ employeeId: p.id, crewName: 'Crew A' })) });
    assert.equal(m.status, 200, m.text);
  });

  it('leaves out the days of approved leave when the roster is generated, but not a request nobody has approved', async () => {
    const [p1, p2] = ctx.people;
    assert.equal((await leave(p1.id, addDays(MON, 1), addDays(MON, 2), true)).status, 201);          // Tuesday and Wednesday, approved
    const pending = await leave(p2.id, addDays(MON, 3), addDays(MON, 3), false); assert.equal(pending.status, 201); ctx.pendingId = pending.json.id;
    const g = await call(admin, 'POST', `/scheduling/rotations/${ctx.pattern.id}/materialize`, { through: addDays(MON, 6) });
    assert.equal(g.status, 201, g.text); ctx.versionId = g.json.versionId;
    assert.equal(g.json.leaveShiftsSkipped, 2, 'two shifts were left out for leave');
    assert.deepEqual(await days(p1.id), [MON, addDays(MON, 3), addDays(MON, 4)]);
    assert.equal((await days(p2.id)).length, 5, 'a pending request changes nothing');
    assert.equal((await days(ctx.people[2].id)).length, 5);
  });

  it('follows an approval made after the roster was generated, and puts the shift back when the leave is cancelled', async () => {
    const p2 = ctx.people[1], thursday = addDays(MON, 3);
    const ok = await call(admin, 'POST', `/workforce/time-off/${ctx.pendingId}/decide`, { status: 'APPROVED' });
    assert.equal(ok.status, 200, ok.text);
    assert.ok(!(await days(p2.id)).includes(thursday), 'approved leave takes the shift off');
    const back = await call(admin, 'POST', `/workforce/time-off/${ctx.pendingId}/decide`, { status: 'CANCELLED' });
    assert.equal(back.status, 200, back.text);
    assert.ok((await days(p2.id)).includes(thursday), 'cancelled leave puts it back');
    const quick = await leave(p2.id, thursday, thursday, true);                                       // approved as it is entered
    assert.ok(!(await days(p2.id)).includes(thursday));
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${quick.json.id}/decide`, { status: 'CANCELLED' })).status, 200);
    assert.ok((await days(p2.id)).includes(thursday));
  });

  it('shows the leave in the coverage preview', async () => {
    const r = await call(admin, 'GET', `/scheduling/rotations/${ctx.pattern.id}/preview?from=${MON}&days=7&coverageSource=MANUAL`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.available, true);
    const tue = r.json.daily.find((d: any) => d.day === addDays(MON, 1));
    assert.ok(tue.shortHours >= 8, `Tuesday is short by the person on leave (got ${tue.shortHours})`);
  });

  it('lists what the published roster still lacks, and offers it as overtime to crew members on a day off and to others, never to someone on leave or over a limit', async () => {
    ctx.extra = await person(5);                                                                        // not in the crew
    const pub = await call(admin, 'POST', `/scheduling/versions/${ctx.versionId}/publish`, { acknowledgeReason: 'test roster' });
    assert.equal(pub.status, 200, pub.text);
    const s = await call(admin, 'GET', `/scheduling/offers/shortages?groupId=${ctx.group.id}&from=${MON}&days=7`);
    assert.equal(s.status, 200, s.text); assert.deepEqual(s.json.unpublishedDays, []);
    const tue = s.json.gaps.find((g: any) => g.day === addDays(MON, 1));
    assert.ok(tue, 'Tuesday is short'); assert.equal(tue.startTime, '07:00'); assert.equal(tue.endTime, '15:00'); assert.equal(tue.spots, 1);
    const sat = s.json.gaps.find((g: any) => g.day === addDays(MON, 5));
    assert.equal(sat.spots, 4, 'nobody is rostered at the weekend');
    assert.ok(s.json.totalShortHours >= 8 + 8 + 32 + 32, `total ${s.json.totalShortHours}`);

    // Tuesday: the crew member on leave is not asked; the person outside the crew is
    const o = await call(admin, 'POST', '/scheduling/offers', { groupId: ctx.group.id, kind: 'OVERTIME', day: addDays(MON, 1), startTime: '07:00', endTime: '15:00', spots: 1 });
    assert.equal(o.status, 201, o.text);
    const d1 = (await call(admin, 'GET', `/scheduling/offers/${o.json.id}`)).json;
    const asked1 = d1.invites.map((i: any) => i.employeeId);
    assert.ok(asked1.includes(ctx.extra.id)); assert.ok(!asked1.includes(ctx.people[0].id), 'someone on approved leave is not asked to work');
    await call(admin, 'POST', `/scheduling/offers/${o.json.id}/cancel`);

    // Saturday: every crew member is on a day off and can be asked
    const w = await call(admin, 'POST', '/scheduling/offers', { groupId: ctx.group.id, kind: 'OVERTIME', day: addDays(MON, 5), startTime: '07:00', endTime: '15:00', spots: 4 });
    assert.equal(w.status, 201, w.text);
    const asked2 = (await call(admin, 'GET', `/scheduling/offers/${w.json.id}`)).json.invites.map((i: any) => i.employeeId);
    // person 1 has worked only three days that week (two were leave), so Saturday fits within the company's limits; the three who already work five days are screened out by those limits
    assert.ok(asked2.includes(ctx.people[0].id), 'a crew member on a day off is asked when it fits the rules');
    assert.ok(asked2.includes(ctx.extra.id));
    await call(admin, 'POST', `/scheduling/offers/${w.json.id}/cancel`);
  });

  it('counts a rotation and the schedule filling its gaps together once both are published', async () => {
    const fill = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: MON, weeks: 1, timeLimitSec: 15, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id], fillFromVersionId: ctx.versionId, name: `Fill ${RUN}` });
    assert.equal(fill.status, 201, fill.text);
    const pub = await call(admin, 'POST', `/scheduling/versions/${fill.json.id}/publish`, { acknowledgeReason: 'test fill' });
    assert.equal(pub.status, 200, pub.text);
    const s = await call(admin, 'GET', `/scheduling/offers/shortages?groupId=${ctx.group.id}&from=${MON}&days=7`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.gaps.find((g: any) => g.day === addDays(MON, 1)), undefined, 'the fill covers the person on leave, so Tuesday is no longer short');
    const sat = s.json.gaps.find((g: any) => g.day === addDays(MON, 5));
    assert.ok(sat && sat.spots < 4, 'the fill person now counts at the weekend, and the rest is still short');
  });

  it('answers with an empty list and says so for days nothing is published', async () => {
    const s = await call(admin, 'GET', `/scheduling/offers/shortages?groupId=${ctx.group.id}&from=${addDays(MON, 60)}&days=3`);
    assert.equal(s.status, 200, s.text); assert.equal(s.json.gaps.length, 0); assert.equal(s.json.unpublishedDays.length, 3);
  });
});
