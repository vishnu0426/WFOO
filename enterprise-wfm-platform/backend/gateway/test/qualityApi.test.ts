/**
 * Schedule quality end to end: bulk employee edit, company defaults and per-person overrides for same start/end times, per-skill coverage,
 * the generation report, evaluation and score, shortage analysis, break placement, stale schedules and publish checks.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/qualityApi.test.ts
 * Builds everything it needs under unique names.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
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

function historyCsv(queues: string[], days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  queues.forEach((queue, qi) => {
    for (let n = days; n >= 1; n--) {
      const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
      for (let s = 0; s < 96; s++) {
        const mean = (curve[Math.floor(s / 4)] * f * (qi === 0 ? 0.35 : 0.25)) / 4;
        rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
      }
    }
  });
  return rows.join('\n');
}

const ctx: Record<string, any> = {};
let admin = '';
const GROUP = `QA ${RUN}`, GROUP2 = `QB ${RUN}`, TEAM = `Team ${RUN}`, SKILL_A = `English ${RUN}`, SKILL_B = `French ${RUN}`;
const shiftsOf = async (versionId: string) => (await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts`)).json as any[];
const startsBy = (shifts: any[]) => { const m = new Map<string, Set<number>>(); for (const s of shifts) m.set(s.employeeId, (m.get(s.employeeId) ?? new Set()).add(s.startSlot)); return m; };

describe('schedule quality', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('builds a group whose two queues need different skills, with history and a published forecast', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: GROUP, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const sa = await call(admin, 'POST', '/workforce/skills', { name: SKILL_A, category: 'LANGUAGES' }); assert.equal(sa.status, 201, sa.text);
    const sb = await call(admin, 'POST', '/workforce/skills', { name: SKILL_B, category: 'LANGUAGES' }); assert.equal(sb.status, 201, sb.text);
    ctx.skillA = sa.json; ctx.skillB = sb.json;
    const qa = await call(admin, 'POST', '/config/queues', { name: `QA Voice ${RUN}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300, skillId: sa.json.id });
    const qb = await call(admin, 'POST', '/config/queues', { name: `QB Voice ${RUN}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300, skillId: sb.json.id });
    assert.equal(qa.status, 201, qa.text); assert.equal(qb.status, 201, qb.text);
    assert.equal(qa.json.skillId, sa.json.id, 'the queue keeps the skill it needs');
    assert.equal((await call(admin, 'PUT', `/config/queues/${qb.json.id}`, { skillId: null })).json.skillId, null, 'a skill can be cleared');
    assert.equal((await call(admin, 'PUT', `/config/queues/${qb.json.id}`, { skillId: sb.json.id })).json.skillId, sb.json.id);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv([qa.json.name, qb.json.name], 70) });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 3 });
    assert.equal(f.status, 201, f.text); ctx.forecast = f.json;
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
  });

  it('has people, a team and shift templates', async () => {
    const t = await call(admin, 'POST', '/workforce/teams', { name: TEAM }); assert.equal(t.status, 201, t.text);
    for (const [name, a, b] of [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '12:00', '14:00']]) {
      const r = await call(admin, 'POST', '/scheduling/templates', { name: `${name} ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
      assert.equal(r.status, 201, r.text);
    }
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week,skills'];
    for (let i = 1; i <= 40; i++) lines.push(`Q${RUN}-${i},Agent${i},Quality${i},${TEAM},${GROUP},FULL_TIME,40,5,${i % 2 ? SKILL_A : SKILL_B}:3`);
    const ok = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
    assert.equal(ok.status, 200, ok.text);
    const list = await call(admin, 'GET', `/workforce/employees?groupId=${ctx.group.id}`);
    assert.equal(list.json.length, 40); ctx.emps = list.json;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    ctx.from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
  });

  describe('company defaults', () => {
    it('start with sensible values and survive an update from an older client', async () => {
      const pol = (await call(admin, 'GET', '/config/scheduling-policy')).json;
      assert.equal(pol.scheduling.targetCoverage, 90); assert.equal(pol.scheduling.consistentTimes.mode, 'OFF'); assert.equal(pol.scheduling.enforcePublishChecks, false);
      const { scheduling, updatedAt, updatedBy, ...old } = pol;
      const put = await call(admin, 'PUT', '/config/scheduling-policy', { ...old, scheduling: { ...scheduling, consistentTimes: { mode: 'PREFER', startToleranceMin: 30, endToleranceMin: 30 }, targetCoverage: 85 } });
      assert.equal(put.status, 200, put.text); assert.equal(put.json.scheduling.consistentTimes.mode, 'PREFER');
      const older = await call(admin, 'PUT', '/config/scheduling-policy', old);       // a client that does not know the new settings
      assert.equal(older.status, 200); assert.equal(older.json.scheduling.targetCoverage, 85, 'the saved defaults are kept');
      assert.equal((await call(admin, 'PUT', '/config/scheduling-policy', { ...old, scheduling: { ...scheduling, targetCoverage: 20 } })).status, 400, 'target out of range');
      assert.equal((await call(admin, 'PUT', '/config/scheduling-policy', { ...old, scheduling })).json.scheduling.consistentTimes.mode, 'OFF');   // back to the starting point for the other tests
      ctx.policy = { old, scheduling };
    });
  });

  describe('bulk edit of employees', () => {
    it('changes the same fields on many people at once and records why', async () => {
      const ids = ctx.emps.slice(0, 10).map((e: any) => e.id);
      assert.equal((await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { allowOvernight: true } })).status, 400, 'a reason is required');
      assert.equal((await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: {}, reason: 'nothing' })).status, 400, 'nothing chosen');
      const r = await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { allowOvernight: true, shiftConsistency: 'REQUIRE', nightShiftConsent: true }, reason: 'Night cover for the new queue' });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.updated, 10); assert.deepEqual(r.json.skipped, []);
      const e = (await call(admin, 'GET', `/workforce/employees/${ids[3]}`)).json;
      assert.equal(e.allowOvernight, true); assert.equal(e.shiftConsistency, 'REQUIRE'); assert.equal(e.nightShiftConsent, true);
      const audit = await call(admin, 'GET', `/audit?entityType=EMPLOYEE&entityId=${ids[3]}`);
      if (audit.status === 200) assert.ok(JSON.stringify(audit.json).includes('Night cover for the new queue'), 'the reason is in the audit trail');
    });
    it('skips people it cannot change and says why, without failing the rest', async () => {
      const ids = ctx.emps.slice(10, 14).map((e: any) => e.id);
      const r = await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { weeklyContractHours: 60 }, reason: 'Trying too many hours' });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.updated, 0); assert.equal(r.json.skipped.length, 4); assert.match(r.json.skipped[0].reason, /cannot exceed/);
      const mixed = await call(admin, 'POST', '/workforce/employees/bulk', { ids: [...ids, '00000000-0000-4000-8000-000000000000'], changes: { location: 'Chennai' }, reason: 'Move to the Chennai site' });
      assert.equal(mixed.json.updated, 4); assert.equal(mixed.json.skipped.length, 1);
      assert.equal((await call(admin, 'GET', `/workforce/employees/${ids[0]}`)).json.location, 'Chennai');
    });
    it('adds and removes groups and skills without wiping what is already there', async () => {
      const g2 = await call(admin, 'POST', '/config/groups', { name: GROUP2 }); assert.equal(g2.status, 201, g2.text);
      const ids = ctx.emps.slice(14, 17).map((e: any) => e.id);
      await call(admin, 'POST', '/workforce/employees/bulk', { ids, eligibleGroups: { add: [g2.json.id], remove: [] }, reason: 'Cross-cover for the second group' });
      let e = (await call(admin, 'GET', `/workforce/employees/${ids[0]}`)).json;
      assert.deepEqual([...e.eligibleGroupIds].sort(), [ctx.group.id, g2.json.id].sort(), 'the primary group stays');
      await call(admin, 'POST', '/workforce/employees/bulk', { ids: [ids[0]], changes: { primaryGroupId: g2.json.id }, reason: 'Moved to the second group' });
      e = (await call(admin, 'GET', `/workforce/employees/${ids[0]}`)).json;
      assert.equal(e.primaryGroupId, g2.json.id); assert.ok(e.eligibleGroupIds.includes(ctx.group.id) && e.eligibleGroupIds.includes(g2.json.id), 'changing the primary group keeps the others');
      await call(admin, 'POST', '/workforce/employees/bulk', { ids: [ids[0]], changes: { primaryGroupId: ctx.group.id }, eligibleGroups: { add: [], remove: [g2.json.id] }, reason: 'Back again' });
      e = (await call(admin, 'GET', `/workforce/employees/${ids[0]}`)).json;
      assert.deepEqual(e.eligibleGroupIds, [ctx.group.id]);
      const sk = await call(admin, 'POST', '/workforce/employees/bulk', { ids, skills: { add: [{ skillId: ctx.skillA.id, proficiency: 5 }], remove: [] }, reason: 'Extra English training done' });
      assert.equal(sk.json.updated, 3);
      e = (await call(admin, 'GET', `/workforce/employees/${ids[1]}`)).json;
      assert.equal(e.skills.find((s: any) => s.skillId === ctx.skillA.id).proficiency, 5);
      await call(admin, 'POST', '/workforce/employees/bulk', { ids, skills: { add: [], remove: [ctx.skillA.id] }, reason: 'Undo' });
      assert.ok(!(await call(admin, 'GET', `/workforce/employees/${ids[2]}`)).json.skills.some((s: any) => s.skillId === ctx.skillA.id));
    });
    it('is only for people who may edit employees', async () => {
      const an = await call(admin, 'POST', '/users', { username: `qa${RUN}`, displayName: 'Qa', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
      assert.ok([201, 409].includes(an.status));
      const tok = (await call(null, 'POST', '/auth/login', { username: `qa${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
      assert.equal((await call(tok, 'POST', '/workforce/employees/bulk', { ids: [ctx.emps[0].id], changes: { location: 'x' }, reason: 'nope' })).status, 403);
    });
  });

  describe('a generated schedule', () => {
    it('keeps each person to one start and end when the rule is required, and reports what happened', async () => {
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 30, consistentTimes: { mode: 'REQUIRE', startToleranceMin: 0, endToleranceMin: 0 } });
      assert.equal(r.status, 201, r.text); ctx.v1 = r.json;
      assert.ok(['OPTIMAL', 'FEASIBLE'].includes(r.json.stats.solver.status));
      const shifts = await shiftsOf(r.json.id);
      assert.ok(shifts.length > 0);
      for (const [id, starts] of startsBy(shifts)) assert.equal(starts.size, 1, `person ${id} starts at ${[...starts]}`);
      const ends = new Map<string, Set<number>>();
      for (const s of shifts) ends.set(s.employeeId, (ends.get(s.employeeId) ?? new Set()).add(s.startSlot + s.lengthSlots));
      for (const [id, e] of ends) assert.equal(e.size, 1, `person ${id} ends at ${[...e]}`);
      assert.equal(r.json.settings.consistentTimes.mode, 'REQUIRE');
    });
    it('splits the requirement by skill when the queues need different skills', async () => {
      assert.equal(r1(ctx.v1).settings.skills.length, 2, 'two skills are judged separately');
      const report = (await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/report`)).json;
      assert.ok(report.exceptions.some((e: any) => e.code === 'SKILLS'));
    });
    it('gives a report with a status, the people scheduled and everyone who was not, with reasons', async () => {
      const rep = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/report`);
      assert.equal(rep.status, 200); assert.equal(rep.json.available, true);
      assert.ok(['SUCCEEDED', 'SUCCEEDED_WITH_WARNINGS'].includes(rep.json.status));
      assert.equal(rep.json.people.inPool, 40);
      assert.equal(rep.json.people.scheduled + rep.json.people.notScheduled, 40);
      assert.equal(rep.json.unscheduled.length, rep.json.people.notScheduled);
      for (const u of rep.json.unscheduled) assert.ok(u.reason.length > 5);
      const csv = await fetch(api(`/scheduling/versions/${ctx.v1.id}/report.csv`), { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type') ?? '', /csv/);
      assert.match(await csv.text(), /^section,/);
    });
    it('names a person who could not be given any shift', async () => {
      const e = ctx.emps[20];
      const w = await call(admin, 'PUT', `/workforce/employees/${e.id}/availability`, { windows: [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, startTime: '00:00', endTime: '24:00', kind: 'UNAVAILABLE' })) });
      assert.equal(w.status, 200, w.text);
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 20 });
      assert.equal(r.status, 201, r.text);
      const rep = (await call(admin, 'GET', `/scheduling/versions/${r.json.id}/report`)).json;
      const none = rep.exceptions.find((x: any) => x.code === 'NO_POSSIBLE_SHIFT');
      assert.ok(none, 'someone had no possible shift'); assert.ok(none.people.some((p: any) => p.id === e.id));
      assert.equal(rep.status, 'SUCCEEDED_WITH_WARNINGS');
      assert.ok(rep.unscheduled.find((u: any) => u.id === e.id).reason.startsWith('No shift possible'));
      await call(admin, 'PUT', `/workforce/employees/${e.id}/availability`, { windows: [] });
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
    it('honours an assigned start time for one person while others vary', async () => {
      const ids = ctx.emps.slice(30, 36).map((e: any) => e.id);
      assert.equal((await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { fixedStartSlot: 32, shiftConsistency: 'DEFAULT' }, reason: 'Fixed 08:00 start' })).json.updated, 6);
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 30, consistentTimes: { mode: 'OFF', startToleranceMin: 0, endToleranceMin: 0 } });
      assert.equal(r.status, 201, r.text);
      const starts = startsBy(await shiftsOf(r.json.id));
      let worked = 0;
      for (const id of ids) { const s = starts.get(id); if (!s) continue; worked++; assert.deepEqual([...s], [32], 'only the assigned start'); }
      assert.ok(worked > 0, 'at least one of them worked');
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
      await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { fixedStartSlot: null }, reason: 'Clear the fixed start' });
    });
    it('a person set to OFF varies even when the company default requires one start', async () => {
      const id = ctx.emps[5].id;
      await call(admin, 'POST', '/workforce/employees/bulk', { ids: [id], changes: { shiftConsistency: 'OFF' }, reason: 'Needs flexible shifts' });
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 30, consistentTimes: { mode: 'REQUIRE', startToleranceMin: 0, endToleranceMin: 0 } });
      assert.equal(r.status, 201, r.text);
      const starts = startsBy(await shiftsOf(r.json.id));
      for (const [pid, s] of starts) if (pid !== id) assert.equal(s.size, 1);
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
  });

  describe('evaluation, shortage and breaks', () => {
    it('estimates service level per interval and gives one score with its parts', async () => {
      const ev = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/evaluation`);
      assert.equal(ev.status, 200, ev.text); assert.equal(ev.json.available, true);
      assert.ok(ev.json.score >= 0 && ev.json.score <= 100);
      assert.equal(ev.json.parts.reduce((s: number, p: any) => s + p.max, 0), 100);
      assert.ok(ev.json.summary.serviceLevel >= 0 && ev.json.summary.serviceLevel <= 1);
      assert.ok(ev.json.summary.serviceLevelBusyDay <= ev.json.summary.serviceLevelQuietDay + 1e-9);
      assert.equal(ev.json.byDay.length, 7);
      const detail = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/evaluation?detail=1`);
      assert.ok(detail.json.intervals.length > 100);
    });
    it('shows where the schedule is short, why, and what could be done', async () => {
      const sh = await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}/shortage`);
      assert.equal(sh.status, 200, sh.text);
      assert.equal(typeof sh.json.meetsTarget, 'boolean'); assert.ok(sh.json.headline.length > 10);
      for (const b of sh.json.blocks.slice(0, 5)) {
        assert.ok(b.peakShort > 0 && b.causes.length > 0 && b.actions.length > 0);
        assert.equal(b.causes.reduce((s: number, c: any) => s + c.people, 0), 40, 'every person is accounted for');
      }
    });
    it('moves meals and breaks inside the slack without touching the shifts', async () => {
      const before = await shiftsOf(ctx.v1.id);
      const noReason = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/optimize-breaks`, { slackMinutes: 60 });
      assert.equal(noReason.status, 400);
      const r = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/optimize-breaks`, { slackMinutes: 60, reason: 'Cover the afternoon peak' });
      assert.equal(r.status, 200, r.text); assert.ok(r.json.phoneShortfallAfter <= r.json.phoneShortfallBefore);
      const after = await shiftsOf(ctx.v1.id);
      assert.equal(after.length, before.length);
      const key = (s: any) => `${s.employeeId}|${s.day}|${s.startSlot}|${s.lengthSlots}`;
      assert.deepEqual(after.map(key).sort(), before.map(key).sort(), 'the shifts themselves are unchanged');
      for (const s of after) for (const a of s.activities) assert.ok(a.startSlot > s.startSlot && a.startSlot + a.slots < s.startSlot + s.lengthSlots, 'inside the shift');
    });
  });

  describe('stale schedules and publish checks', () => {
    it('are marked stale when a newer forecast is published', async () => {
      assert.deepEqual((await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}`)).json.stale, [], 'current to begin with');
      const f = await call(admin, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'SHORT', weeks: 3 });
      assert.equal(f.status, 201, f.text);
      for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
      const v = (await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}`)).json;
      assert.ok(v.stale.length >= 1, JSON.stringify(v.stale));
      const list = (await call(admin, 'GET', `/scheduling/versions?groupId=${ctx.group.id}`)).json.find((x: any) => x.id === ctx.v1.id);
      assert.ok(list.stale.length >= 1);
    });
    it('can be published as before, and with checks enforced need a reason', async () => {
      const fresh = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 20 });
      assert.equal(fresh.status, 201, fresh.text);
      const { old, scheduling } = ctx.policy;
      await call(admin, 'PUT', '/config/scheduling-policy', { ...old, scheduling: { ...scheduling, targetCoverage: 100, enforcePublishChecks: true } });
      const blocked = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/publish`, {});
      assert.equal(blocked.status, 409, blocked.text); assert.match(blocked.text, /CHECKS_NOT_ACKNOWLEDGED/);
      const shortReason = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/publish`, { acknowledgeReason: 'x' });
      assert.equal(shortReason.status, 409);
      const ok = await call(admin, 'POST', `/scheduling/versions/${ctx.v1.id}/publish`, { acknowledgeReason: 'Overtime will cover the gap' });
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.acknowledged.reason, 'Overtime will cover the gap'); assert.ok(ok.json.checks.length >= 1);
      await call(admin, 'PUT', '/config/scheduling-policy', { ...old, scheduling });
      await call(admin, 'DELETE', `/scheduling/versions/${fresh.json.id}`);
    });
  });

  describe('what people worked before the schedule starts', () => {
    it('counts the previous published schedule and says so in the report', async () => {
      const pub = (await call(admin, 'GET', `/scheduling/versions/${ctx.v1.id}`)).json;
      assert.equal(pub.status, 'PUBLISHED', 'the earlier test published it');
      const next = iso(addDays(new Date(`${ctx.from}T00:00:00`), 7));
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: next, weeks: 1, timeLimitSec: 20 });
      assert.equal(r.status, 201, r.text);
      assert.ok(r.json.settings.history.people > 0, JSON.stringify(r.json.settings.history));
      assert.ok(r.json.settings.history.shifts >= r.json.settings.history.people);
      const report = (await call(admin, 'GET', `/scheduling/versions/${r.json.id}/report`)).json;
      assert.ok(report.exceptions.some((x: any) => x.code === 'HISTORY'), JSON.stringify(report.exceptions.map((x: any) => x.code)));
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
    it('can be switched off, and then nothing is carried over', async () => {
      const next = iso(addDays(new Date(`${ctx.from}T00:00:00`), 7));
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: next, weeks: 1, timeLimitSec: 20, useHistory: false });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.settings.history, null);
      assert.deepEqual(r.json.settings.carryOver, []);
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
    it('has no history to count when the schedule is the first', async () => {
      const early = iso(addDays(new Date(`${ctx.from}T00:00:00`), -30));
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: early, weeks: 1, timeLimitSec: 10 });
      if (r.status === 201) { assert.equal(r.json.settings.history?.people ?? 0, 0); await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`); }
      else assert.ok(r.status === 400, r.text);          // no forecast that far back: refused, not a crash
    });
  });

  describe('shift templates with variable length, rules and limits', () => {
    const body = (over: Record<string, unknown> = {}) => ({
      name: `Var ${RUN}-${Math.random().toString(36).slice(2, 6)}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '06:00', latestStart: '12:00', startStepMinutes: 60, durationHours: 8, minDurationHours: 4, lengthStepMinutes: 60,
      mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30, ...over,
    });
    const madeIds: string[] = [];
    const make = async (over: Record<string, unknown> = {}) => { const r = await call(admin, 'POST', '/scheduling/templates', body(over)); assert.equal(r.status, 201, r.text); madeIds.push(r.json.id); return r.json; };
    // the templates these tests make would otherwise stay active and enlarge every later schedule
    after(async () => { for (const id of madeIds) await call(admin, 'DELETE', `/scheduling/templates/${id}`); });
    const generate = (templateIds: string[], extra: Record<string, unknown> = {}) => call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 20, templateIds, ...extra });

    it('saves and returns the new fields', async () => {
      const t = await make({ lengthRules: [{ fromHours: 4, mealMinutes: 0, breakCount: 1, breakMinutes: 15 }, { fromHours: 7, mealMinutes: 30, breakCount: 2, breakMinutes: 15 }], dayWindows: { '5': { earliest: '09:00', latest: '10:00' } },
        employmentTypes: ['FULL_TIME'], effectiveFrom: '2020-01-01', mealPaid: true });
      assert.equal(t.minDurationHours, 4); assert.equal(t.durationHours, 8); assert.equal(t.lengthStepMinutes, 60); assert.equal(t.mealPaid, true);
      assert.equal(t.lengthRules.length, 2); assert.deepEqual(t.dayWindows, { '5': { earliest: '09:00', latest: '10:00' } });
      assert.deepEqual(t.employmentTypes, ['FULL_TIME']); assert.equal(t.effectiveFrom, '2020-01-01'); assert.equal(t.effectiveTo, null);
      assert.equal(t.paidHours, 8, 'a paid meal costs nothing');
      const list = (await call(admin, 'GET', '/scheduling/templates')).json.find((x: any) => x.id === t.id);
      assert.deepEqual(list.lengthRules, t.lengthRules);
      ctx.tplRules = t;
    });
    it('a plain template is unchanged', async () => {
      const t = await make({ minDurationHours: null, durationHours: 8.5 });
      assert.equal(t.minDurationHours, null); assert.equal(t.lengthRules, null); assert.equal(t.dayWindows, null); assert.equal(t.groupIds, null); assert.equal(t.paidHours, 8);
    });
    it('refuses nonsense with a plain message', async () => {
      for (const [over, re] of [
        [{ minDurationHours: 9 }, /shortest/], [{ dayWindows: { '2': { earliest: '10:00', latest: '08:00' } } }, /latest start/],
        [{ lengthRules: [{ fromHours: 5, mealMinutes: 0, breakCount: 0, breakMinutes: 15 }, { fromHours: 5, mealMinutes: 0, breakCount: 1, breakMinutes: 15 }] }, /same length/],
        [{ effectiveFrom: '2026-12-01', effectiveTo: '2026-11-01' }, /end before/], [{ lengthRules: [{ fromHours: 1, mealMinutes: 60, breakCount: 0, breakMinutes: 15 }] }, /too long/],
      ] as [Record<string, unknown>, RegExp][]) {
        const r = await call(admin, 'POST', '/scheduling/templates', body(over));
        assert.equal(r.status, 400, JSON.stringify(over)); assert.match(r.text, re);
      }
    });
    it('a schedule built from it uses lengths the template offers, with the meal that length gets', async () => {
      const t = await make({ lengthRules: [{ fromHours: 4, mealMinutes: 0, breakCount: 1, breakMinutes: 15 }, { fromHours: 7, mealMinutes: 30, breakCount: 2, breakMinutes: 15 }] });
      const r = await generate([t.id]);
      assert.equal(r.status, 201, r.text);
      const shifts = await shiftsOf(r.json.id);
      assert.ok(shifts.length > 0);
      for (const s of shifts) {
        assert.ok([16, 20, 24, 28, 32].includes(s.lengthSlots), `length ${s.lengthSlots}`);
        const meal = s.activities.filter((a: any) => a.type === 'MEAL').reduce((n: number, a: any) => n + a.slots, 0);
        const breaks = s.activities.filter((a: any) => a.type === 'BREAK').length;
        assert.equal(meal, s.lengthSlots >= 28 ? 2 : 0, `meal for ${s.lengthSlots} slots`);
        assert.equal(breaks, s.lengthSlots >= 28 ? 2 : 1, `breaks for ${s.lengthSlots} slots`);
      }
      const paid = shifts.reduce((n: number, s: any) => n + (s.lengthSlots - (s.lengthSlots >= 28 ? 2 : 0)) / 4, 0);
      assert.ok(Math.abs(r.json.stats.hours.paid - paid) < 0.01, `paid ${r.json.stats.hours.paid} vs ${paid}`);
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
    it('a start window per weekday decides when shifts start', async () => {
      const t = await make({ minDurationHours: null, durationHours: 8, dayWindows: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), { earliest: '10:00', latest: '10:00' }])) });
      const r = await generate([t.id]);
      assert.equal(r.status, 201, r.text);
      const shifts = await shiftsOf(r.json.id);
      assert.ok(shifts.length > 0);
      assert.ok(shifts.every((s: any) => s.startSlot === 40), 'every shift starts at 10:00');
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
    it('is not offered to people it is not for, or outside its dates', async () => {
      const other = await make({ employmentTypes: ['PART_TIME'] });
      const r1 = await generate([other.id]);
      assert.equal(r1.status, 400, 'everyone here is full-time'); assert.match(r1.text, /ruled out/);
      const later = await make({ effectiveFrom: '2099-01-01' });
      assert.equal((await generate([later.id])).status, 400);
      const ended = await make({ effectiveTo: '2020-01-01' });
      assert.equal((await generate([ended.id])).status, 400);
    });
    it('a manual shift can be added at one of the lengths it offers, and no other', async () => {
      const t = ctx.tplRules;
      const v = await generate([(await make()).id]);
      assert.equal(v.status, 201, v.text);
      const person = ctx.emps[0];
      const ok = await call(admin, 'POST', `/scheduling/versions/${v.json.id}/shifts`, { employeeId: person.id, day: ctx.from, templateId: t.id, startTime: '08:00', lengthHours: 6, reason: 'Short shift for a quiet morning' });
      assert.ok([200, 201].includes(ok.status), ok.text);
      const bad = await call(admin, 'POST', `/scheduling/versions/${v.json.id}/shifts`, { employeeId: person.id, day: ctx.from, templateId: t.id, startTime: '08:00', lengthHours: 5.5, reason: 'Not an offered length' });
      assert.equal(bad.status, 400, bad.text); assert.match(bad.text, /offers/);
      const mine = (await shiftsOf(v.json.id)).find((s: any) => s.employeeId === person.id && s.day === ctx.from);
      assert.equal(mine.lengthSlots, 24);
      await call(admin, 'DELETE', `/scheduling/versions/${v.json.id}`);
    });
    it('notes when the week is assumed to repeat, and only for one-week schedules', async () => {
      const r = await generate([(await make({ minDurationHours: null, durationHours: 8.5 })).id], { assumeRepeat: true });
      assert.equal(r.status, 201, r.text);
      const report = (await call(admin, 'GET', `/scheduling/versions/${r.json.id}/report`)).json;
      assert.ok(report.exceptions.some((x: any) => x.code === 'REPEAT'), JSON.stringify(report.exceptions.map((x: any) => x.code)));
      assert.equal(r.json.settings.assumeRepeat, true);
      const two = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 2, timeLimitSec: 10, assumeRepeat: true });
      assert.equal(two.status, 400, 'one-week schedules only'); assert.match(two.text, /one-week/);
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
  });

  describe('a planning forecast from a file', () => {
    const planCsv = (queue: string, days: string[], opts: { header?: string; slots?: number; vol?: number } = {}) => {
      const rows = [`queue,date,interval,${opts.header ?? 'forecast_volume'},aht`];
      for (const d of days) for (let s = 0; s < (opts.slots ?? 96); s++) rows.push(`${queue},${d},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${opts.vol ?? 12},180`);
      return rows.join('\n');
    };
    const importPlan = (csv: string, extra: Record<string, unknown> = {}) => call(admin, 'POST', '/forecast/versions/import', { groupId: ctx.group.id, csv, fileName: 'plan.csv', ...extra });

    it('has a queue to plan for', async () => {
      const q = await call(admin, 'POST', '/config/queues', { name: `Plan Q ${RUN}`, channel: 'VOICE', wfmGroupId: ctx.group.id, ahtDefault: 180 });
      assert.equal(q.status, 201, q.text); ctx.planQueue = q.json;
      ctx.planDays = [ctx.from, iso(addDays(new Date(`${ctx.from}T00:00:00`), 1))];
    });
    it('checks a file without saving it', async () => {
      const r = await importPlan(planCsv(ctx.planQueue.name, ctx.planDays), { dryRun: true });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.ok, true); assert.equal(r.json.days, 2); assert.equal(r.json.totalVolume, 12 * 96 * 2); assert.equal(r.json.volumeColumn, 'forecast_volume');
      assert.equal(r.json.gaps.length, 0); assert.deepEqual(r.json.problems, []);
      const before = (await call(admin, 'GET', `/forecast/versions?groupId=${ctx.group.id}`)).json.filter((v: any) => v.type === 'IMPORTED');
      assert.equal(before.length, 0, 'a dry run saves nothing');
    });
    it('says plainly what is wrong with a file', async () => {
      const past = await importPlan(planCsv(ctx.planQueue.name, ['2026-01-05']), { dryRun: true });
      assert.equal(past.json.ok, false); assert.match(past.json.problems.join(' '), /in the past/);
      const gaps = await importPlan(planCsv(ctx.planQueue.name, ctx.planDays, { slots: 90 }), { dryRun: true });
      assert.equal(gaps.json.ok, false); assert.match(gaps.json.problems.join(' '), /96 quarter-hours/);
      const allowed = await importPlan(planCsv(ctx.planQueue.name, ctx.planDays, { slots: 90 }), { dryRun: true, allowGaps: true });
      assert.equal(allowed.json.ok, true);
      const unknown = await importPlan(planCsv('No such queue', ctx.planDays), { dryRun: true });
      assert.equal(unknown.json.ok, false); assert.match(unknown.json.problems.join(' '), /Unknown queue/);
      const real = await importPlan(planCsv(ctx.planQueue.name, ['2026-01-05']));
      assert.equal(real.status, 400, 'saving a file with problems is refused'); assert.match(real.text, /in the past/);
    });
    it('saves it as an imported draft that goes through the usual steps', async () => {
      const r = await importPlan(planCsv(ctx.planQueue.name, ctx.planDays));
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.type, 'IMPORTED'); assert.equal(r.json.status, 'DRAFT'); assert.equal(r.json.kind, 'SHORT'); assert.match(r.json.name, /^Imported v\d+/);
      assert.equal(r.json.summary.series[0].model, 'Imported');
      const data = (await call(admin, 'GET', `/forecast/versions/${r.json.id}/data?grain=day`)).json;
      assert.ok(JSON.stringify(data).includes('1152'), 'a day holds 96 x 12 contacts');
      for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${r.json.id}/${step}`, {})).status, 200, step);
      ctx.planVersion = r.json;
    });
    it('is then what a schedule is built from', async () => {
      const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: ctx.from, weeks: 1, timeLimitSec: 45, forecastVersionId: ctx.planVersion.id });
      assert.equal(r.status, 201, r.text);
      assert.equal(r.json.forecastVersionId, ctx.planVersion.id);
      assert.ok(r.json.stats.coverage.requiredSlots > 0, 'the plan gives a requirement');
      await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    });
  });
});

const r1 = (v: any) => v;
