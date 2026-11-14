/**
 * Time-off approval through the API: the impact of a request on the team's cover, checked against the published schedule, and bulk approval that approves only what passes. Needs a
 * running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/timeOffImpactApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const NEED = 5, FIRST = 32, LAST = 68;      // 08:00 to 17:00 needs five

describe('time-off impact and bulk decisions', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', analyst = '', group: any, versionId = '';
  let shifts: any[] = [], worker = '', workDay = '', spare = '';
  const ids: string[] = [];
  const request = async (employeeId: string, day: string, endDate = day, type = 'VACATION') => {
    const r = await call(admin, 'POST', '/workforce/time-off', { employeeId, type, startDate: day, endDate });
    assert.equal(r.status, 201, r.text); return r.json.id as string;
  };

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `TOI ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
    for (let i = 1; i <= 6; i++) {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `TO${RUN}-${i}`, firstName: `T${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(r.status, 201, r.text); ids.push(r.json.id);
    }
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `TOT${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 });
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '17:00', headcount: NEED })).status, 201);
    const from = new Date(); from.setDate(from.getDate() + 3);
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from: iso(from), weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [t.json.id], useHistory: false });
    assert.equal(v.status, 201, v.text); versionId = v.json.id;
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${versionId}/publish`, {})).status, 200);
    shifts = (await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json;
    assert.ok(shifts.length > 0);
    worker = shifts[0].employeeId; workDay = shifts[0].day;
    // someone joins after the schedule was published: not on it, so asking for leave takes nothing off it
    const s = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `TO${RUN}-9`, firstName: 'Spare', lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
    assert.equal(s.status, 201, s.text); spare = s.json.id;
    await call(admin, 'POST', '/users', { username: `toview${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `toview${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
  });

  /** The coverage a day has without `without`, worked out here from the published shifts and nothing else. */
  const expectedAfter = (day: string, without: string) => {
    const staffed = new Array(96).fill(0);
    for (const s of shifts.filter((x) => x.day === day && x.employeeId !== without)) {
      const away = (s.activities ?? []).filter((a: any) => a.type === 'MEAL' || a.type === 'SPLIT_GAP');
      for (let k = s.startSlot; k < s.startSlot + s.lengthSlots && k < 96; k++) if (!away.some((a: any) => k >= a.startSlot && k < a.startSlot + a.slots)) staffed[k]++;
    }
    let got = 0; for (let k = FIRST; k < LAST; k++) got += Math.min(NEED, staffed[k]);
    return Math.round((got / (NEED * (LAST - FIRST))) * 100);
  };

  it('shows what approving does to cover on a day the person works, matching the published schedule', async () => {
    const id = await request(worker, workDay);
    const r = await call(admin, 'GET', `/workforce/time-off/${id}/impact`);
    assert.equal(r.status, 200, r.text);
    const d = r.json.coverage.days[0];
    assert.equal(d.day, workDay); assert.equal(d.scheduled, true); assert.equal(d.judged, true);
    assert.equal(r.json.coverage.source, 'template');
    assert.equal(d.afterPercent, expectedAfter(workDay, worker), 'cover without them is what the shifts add up to');
    assert.equal(d.beforePercent, expectedAfter(workDay, ''), 'and with them');
    assert.ok(d.afterPercent <= d.beforePercent);
    assert.equal(r.json.target, 90);
    assert.match(r.json.coverage.headline, /Approving leaves|fully covered/);
    // pass or fail follows the number
    assert.equal(r.json.passes.ok, d.afterPercent >= 90 && !r.json.balance?.afterDays || (d.afterPercent >= 90 && r.json.balance.afterDays >= 0 && !r.json.rules.reasons.length && !r.json.cap?.breach));
    if (d.afterPercent < 90) assert.ok(r.json.passes.why.some((w: string) => /cover would fall/.test(w)), r.text);
    assert.equal(r.json.request.id, id);
  });

  it('says nothing is lost on a day they are not scheduled, and passes', async () => {
    const id = await request(spare, workDay);
    const r = (await call(admin, 'GET', `/workforce/time-off/${id}/impact`)).json;
    assert.equal(r.coverage.days[0].scheduled, false);
    assert.equal(r.coverage.days[0].beforePercent, r.coverage.days[0].afterPercent);
    assert.match(r.coverage.headline, /not scheduled/);
    assert.ok(!r.passes.why.some((w: string) => /cover/.test(w)));
  });

  it('refuses to pass a request a strict blackout forbids, and bulk approval leaves it waiting with the reason', async () => {
    const day = '2031-06-10';
    const rule = await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: group.id, startDate: day, endDate: day, strict: true, reason: 'Year-end close' });
    assert.equal(rule.status, 201, rule.text);
    const blocked = await request(spare, day), fine = await request(spare, '2031-06-17');
    const imp = (await call(admin, 'GET', `/workforce/time-off/${blocked}/impact`)).json;
    assert.equal(imp.passes.ok, false);
    assert.match(imp.passes.why.join(' '), /Year-end close/);
    const out = await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [blocked, fine], status: 'APPROVED' });
    assert.equal(out.status, 200, out.text);
    assert.equal(out.json.decided, 1); assert.equal(out.json.skipped, 1);
    assert.equal(out.json.left[0].id, blocked); assert.match(out.json.left[0].why.join(' '), /Year-end close/);
    const status = async (id: string) => (await call(admin, 'GET', `/workforce/time-off?employeeId=${spare}`)).json.find((t: any) => t.id === id).status;
    assert.equal(await status(blocked), 'REQUESTED', 'the blocked one is still waiting');
    assert.equal(await status(fine), 'APPROVED');
    await call(admin, 'DELETE', `/self-service/time-off-rules/${rule.json.id}`);
  });

  it('approves in bulk exactly the requests whose own checks pass, and decides the rest the same way as one at a time', async () => {
    const a = await request(ids[1], '2031-07-01'), b = await request(ids[2], '2031-07-02'), c = await request(ids[3], '2031-07-03');
    const verdicts = await Promise.all([a, b, c].map(async (id) => (await call(admin, 'GET', `/workforce/time-off/${id}/impact`)).json.passes.ok as boolean));
    const out = (await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [a, b, c], status: 'APPROVED' })).json;
    assert.equal(out.decided, verdicts.filter(Boolean).length);
    assert.equal(out.skipped, verdicts.filter((v) => !v).length);
    const now = (await call(admin, 'GET', '/workforce/time-off?from=2031-07-01&to=2031-07-03')).json as any[];
    [a, b, c].forEach((id, i) => assert.equal(now.find((t) => t.id === id).status, verdicts[i] ? 'APPROVED' : 'REQUESTED'));
    // asking again for ones already decided leaves them alone
    const again = (await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [a, b, c], status: 'APPROVED' })).json;
    assert.equal(again.decided, 0);
    assert.ok(again.left.every((l: any) => /Already approved|No longer waiting/.test(l.why.join(' ')) || verdicts.every((v) => !v)));
  });

  it('declines in bulk only with a reason, and keeps the reason', async () => {
    const a = await request(ids[4], '2031-08-04'), b = await request(ids[5], '2031-08-05');
    assert.equal((await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [a, b], status: 'REJECTED' })).status, 400);
    const out = await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [a, b], status: 'REJECTED', reason: 'Peak week' });
    assert.equal(out.status, 200, out.text); assert.equal(out.json.decided, 2);
    const rows = (await call(admin, 'GET', '/workforce/time-off?from=2031-08-04&to=2031-08-05&status=REJECTED')).json as any[];
    assert.ok(rows.filter((t) => [a, b].includes(t.id)).every((t) => t.reason === 'Peak week'));
  });

  it('refuses bad input and unknown requests', async () => {
    assert.equal((await call(admin, 'GET', '/workforce/time-off/00000000-0000-4000-8000-000000000000/impact')).status, 404);
    assert.equal((await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: [], status: 'APPROVED' })).status, 400);
    assert.equal((await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: Array.from({ length: 51 }, () => '00000000-0000-4000-8000-000000000000'), status: 'APPROVED' })).status, 400);
    const out = await call(admin, 'POST', '/workforce/time-off/bulk-decide', { ids: ['00000000-0000-4000-8000-000000000000'], status: 'APPROVED' });
    assert.equal(out.status, 200); assert.equal(out.json.decided, 0); assert.equal(out.json.skipped, 1);
  });

  it('judges each day in the group the person is rostered in (not only their primary group) and applies that group\'s rules', async () => {
    // A shared person: home group A, also eligible for B. They work some days in A's schedule and the rest in B's.
    const A = (await call(admin, 'POST', '/config/groups', { name: `TOI-A ${RUN}` })).json, B = (await call(admin, 'POST', '/config/groups', { name: `TOI-B ${RUN}` })).json;
    const mk = async (n: string, primaryGroupId: string, eligibleGroupIds: string[]) => (await call(admin, 'POST', '/workforce/employees', { employeeNumber: `TX${RUN}-${n}`, firstName: `X${n}`, lastName: 'Shared', primaryGroupId, eligibleGroupIds, weeklyContractHours: 40, maxWeeklyHours: 48 })).json.id as string;
    const shared = await mk('0', A.id, [A.id, B.id]);
    for (let i = 1; i <= 5; i++) await mk(String(i), B.id, [B.id]);
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `TOX${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 });
    for (const [g, n, last] of [[A, 1, 3], [B, NEED + 1, 7]] as const) for (let d = 0; d < last; d++) await call(admin, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '17:00', headcount: n });
    const from = new Date(); from.setDate(from.getDate() + 3);
    const build = async (g: any) => {     // the home group is built first: a guest only gets the time the home group leaves free
      const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.id, from: iso(from), weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [t.json.id], useHistory: false });
      assert.equal(v.status, 201, v.text);
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`, {})).status, 200);
      return ((await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts`)).json as any[]).filter((s) => s.employeeId === shared).map((s) => s.day as string).sort();
    };
    const inA = await build(A), inB = await build(B);
    assert.ok(inA.length > 0 && inB.length > 0, `the shared person works in both groups (A ${inA.length} days, B ${inB.length} days)`);
    const days = [...inA, ...inB].sort();
    const id = await request(shared, days[0], days.at(-1)!);
    const imp = (await call(admin, 'GET', `/workforce/time-off/${id}/impact`)).json;
    assert.deepEqual(imp.coverage.groups.sort(), [A.name, B.name].sort());
    const byDay = new Map<string, any>(imp.coverage.days.map((d: any) => [d.day, d]));
    for (const day of inA) assert.equal(byDay.get(day).groupName, A.name, `${day} is judged in group A`);
    for (const day of inB) { const d = byDay.get(day); assert.equal(d.groupName, B.name, `${day} is judged in group B`); assert.equal(d.scheduled, true); assert.equal(d.judged, true); assert.ok(d.afterPercent < d.beforePercent); }
    // A needs one person and the shared person is it: without them A has nothing
    assert.equal(byDay.get(inA[0]).afterPercent, 0);
    assert.equal(imp.passes.ok, false);
    // a strict blackout for group B on a day they work in B stops it, though their home group A has no such rule
    const rule = await call(admin, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: B.id, startDate: inB[0], endDate: inB[0], strict: true, reason: 'B stocktake' });
    assert.equal(rule.status, 201, rule.text);
    assert.match((await call(admin, 'GET', `/workforce/time-off/${id}/impact`)).json.rules.blockers.join(' '), /B stocktake/);
    await call(admin, 'DELETE', `/self-service/time-off-rules/${rule.json.id}`);
  });

  it('can be read by someone who cannot decide, and only decided by someone who can', async () => {
    const id = await request(spare, '2031-09-09');
    assert.equal((await call(analyst, 'GET', `/workforce/time-off/${id}/impact`)).status, 200);
    assert.equal((await call(analyst, 'POST', '/workforce/time-off/bulk-decide', { ids: [id], status: 'APPROVED' })).status, 403);
  });
});
