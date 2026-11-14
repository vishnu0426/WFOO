/**
 * Enterprise scheduling policies through the API: split shifts, overtime and holiday settings, schedule approval, what publishing changes for each person, and a person shared
 * between groups in different time zones. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/enterprisePolicies.test.ts
 */
import { before, after, describe, it } from 'node:test';
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
const tpl = (extra: object) => ({ name: `T${RUN}-${Math.random().toString(36).slice(2, 6)}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, ...extra });

describe('enterprise scheduling policies', { skip: !BASE || !PASSWORD }, () => {
  let admin = '';
  const policy = async (patch: object) => {
    const cur = (await call(admin, 'GET', '/config/scheduling-policy')).json;
    const r = await call(admin, 'PUT', '/config/scheduling-policy', { ...cur, scheduling: { ...cur.scheduling, ...patch } });
    assert.equal(r.status, 200, r.text);
  };
  const people = async (group: any, n: number, tag: string, extra: object = {}) => {
    const ids: string[] = [];
    for (let i = 1; i <= n; i++) {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `${tag}${RUN}-${i}`, firstName: `${tag}${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48, ...extra });
      assert.equal(r.status, 201, r.text); ids.push(r.json.id);
    }
    return ids;
  };
  const need = async (group: any, headcount: number, start = '08:00', end = '18:00') => {
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: start, endTime: end, headcount })).status, 201);
  };
  const build = async (group: any, from: string, templateIds: string[], extra: object = {}) => {
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds, useHistory: false, ...extra });
    assert.equal(v.status, 201, v.text); return v.json;
  };
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    await policy({ requireApproval: false, overtime: 'FREE', holidays: 'ALLOW', changeNoticeHours: 48 });
  });
  after(async () => { if (admin) await policy({ requireApproval: false, overtime: 'FREE', holidays: 'ALLOW', changeNoticeHours: 48 }); });

  describe('split shifts', () => {
    it('are refused when the gap or the parts do not make sense', async () => {
      const short = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 10, mealMinutes: 30, splitShift: true }));
      assert.equal(short.status, 400); assert.match(short.text, /between 1 and 6 hours/);
      const tiny = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 5, mealMinutes: 180, splitShift: true }));
      assert.equal(tiny.status, 400); assert.match(tiny.text, /at least 2 hours/);
      const longMeal = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 10, mealMinutes: 180 }));
      assert.equal(longMeal.status, 400); assert.match(longMeal.text, /use a split shift/);
    });

    it('are built with a fixed unpaid gap that covers nothing', async () => {
      const group = (await call(admin, 'POST', '/config/groups', { name: `Split ${RUN}` })).json;
      const t = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '07:00', latestStart: '07:00', durationHours: 10, mealMinutes: 180, mealAnchorMinutes: 240, splitShift: true }));
      assert.equal(t.status, 201, t.text);
      assert.equal(t.json.splitShift, true); assert.equal(t.json.mealMinutes, 180); assert.equal(t.json.paidHours, 7);
      await people(group, 6, 'SP'); await need(group, 3, '07:00', '17:00');
      const v = await build(group, '2026-12-07', [t.json.id]);
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.id}/shifts`)).json as any[];
      assert.ok(shifts.length > 0);
      for (const s of shifts) {
        const gap = s.activities.filter((a: any) => a.type === 'MEAL');
        assert.equal(gap.length, 1, 'one gap'); assert.equal(gap[0].slots, 12, 'three hours'); assert.equal(gap[0].split, true, 'marked as the design of the shift');
        assert.equal(gap[0].startSlot - s.startSlot, 16, 'where the template put it, not moved');
      }
      const cov = (await call(admin, 'GET', `/scheduling/versions/${v.id}/coverage?day=2026-12-08&grain=15`)).json;
      const mid = cov.slots.find((s: any) => s.slot === 48);       // 07:00 start + 4 h anchor = 11:00 gap, three hours long
      const on = shifts.filter((x) => x.day === '2026-12-08').length;
      assert.ok(on > 0 && mid.scheduled < on, `the gap counts as away (${mid.scheduled} covering of ${on} on shift)`);
    });
  });

  describe('overtime', () => {
    it('never planned: nobody is given more than their contract hours in a week', async () => {
      await policy({ overtime: 'NEVER' });
      const group = (await call(admin, 'POST', '/config/groups', { name: `OT ${RUN}` })).json;
      const t = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 }));
      await people(group, 6, 'OT'); await need(group, 6);
      const v = await build(group, '2026-12-07', [t.json.id]);
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.id}/shifts`)).json as any[];
      const hours = new Map<string, number>();
      for (const s of shifts) hours.set(s.employeeId, (hours.get(s.employeeId) ?? 0) + (s.lengthSlots - s.activities.filter((a: any) => a.type === 'MEAL').reduce((n: number, a: any) => n + a.slots, 0)) / 4);
      assert.ok(hours.size > 0);
      for (const [, h] of hours) assert.ok(h <= 40 + 1e-9, `${h} hours in the week`);
      await policy({ overtime: 'FREE' });
    });
  });

  describe('public holidays', () => {
    it('are not staffed when the group does not work them, and are when it does', async () => {
      const group = (await call(admin, 'POST', '/config/groups', { name: `Hol ${RUN}` })).json;
      const t = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 }));
      await people(group, 8, 'HO'); await need(group, 4);
      assert.equal((await call(admin, 'POST', '/forecast/events', { groupId: group.id, name: `Holiday ${RUN}`, kind: 'holiday', startDay: '2026-12-09', endDay: '2026-12-09' })).status, 201);
      await policy({ holidays: 'CLOSED' });
      const closed = await build(group, '2026-12-07', [t.json.id]);
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${closed.id}/shifts`)).json as any[];
      assert.ok(shifts.length > 0);
      assert.equal(shifts.filter((s) => s.day === '2026-12-09').length, 0, 'nobody on the holiday');
      assert.ok(shifts.filter((s) => s.day === '2026-12-08').length > 0);
      await policy({ holidays: 'ALLOW' });
      const open = await build(group, '2026-12-07', [t.json.id]);
      const shifts2 = (await call(admin, 'GET', `/scheduling/versions/${open.id}/shifts`)).json as any[];
      assert.ok(shifts2.filter((s) => s.day === '2026-12-09').length > 0, 'staffed like any other day');
    });
  });

  describe('approval and what publishing changes', () => {
    let group: any, template: any, v1: any, v2: any, ids: string[];
    before(async () => {
      group = (await call(admin, 'POST', '/config/groups', { name: `Appr ${RUN}` })).json;
      template = (await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 }))).json;
      ids = await people(group, 8, 'AP'); await need(group, 4);
    });

    it('publishing needs approval when the organisation requires it, and an edit after approval takes the approval away', async () => {
      await policy({ requireApproval: true });
      v1 = await build(group, '2026-12-07', [template.id]);
      assert.equal(v1.approval.state, 'NONE');
      let r = await call(admin, 'POST', `/scheduling/versions/${v1.id}/publish`, {});
      assert.equal(r.status, 409); assert.equal(r.json.error?.code ?? r.json.code, 'APPROVAL_REQUIRED');
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v1.id}/approve`, {})).status, 409, 'cannot approve what was not submitted');
      r = await call(admin, 'POST', `/scheduling/versions/${v1.id}/submit`, { note: 'please check' });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.approval.state, 'SUBMITTED');
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v1.id}/publish`, {})).status, 409, 'submitted is not approved');
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v1.id}/reject`, {})).status, 400, 'a reason is required');
      r = await call(admin, 'POST', `/scheduling/versions/${v1.id}/reject`, { reason: 'Monday is thin' });
      assert.equal(r.json.approval.state, 'NONE'); assert.equal(r.json.approval.note, 'Monday is thin');
      await call(admin, 'POST', `/scheduling/versions/${v1.id}/submit`, {});
      r = await call(admin, 'POST', `/scheduling/versions/${v1.id}/approve`, {});
      assert.equal(r.status, 200, r.text); assert.equal(r.json.approval.state, 'APPROVED');
      // an edit after the approval means the approved schedule is no longer this one
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v1.id}/shifts`)).json as any[];
      assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${v1.id}/shifts/${shifts[0].id}?reason=${encodeURIComponent('test edit after approval')}`)).status, 200);
      const now = (await call(admin, 'GET', `/scheduling/versions/${v1.id}`)).json;
      assert.equal(now.approval.state, 'NONE'); assert.equal(now.approval.changedSince, true);
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v1.id}/publish`, {})).status, 409);
      await call(admin, 'POST', `/scheduling/versions/${v1.id}/submit`, {});
      await call(admin, 'POST', `/scheduling/versions/${v1.id}/approve`, {});
      r = await call(admin, 'POST', `/scheduling/versions/${v1.id}/publish`, {});
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.impact.previous, [], 'nothing was live, so nothing is replaced');
      await policy({ requireApproval: false });
    });

    it('says who is affected before publishing a replacement, and publishes with a count of the people told', async () => {
      v2 = await build(group, '2026-12-07', [template.id]);
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v2.id}/shifts`)).json as any[];
      const victim = shifts[shifts.length - 1];             // not the one removed from the first schedule, which would then match
      assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${v2.id}/shifts/${victim.id}?reason=${encodeURIComponent('test: take a shift away')}`)).status, 200);
      const im = (await call(admin, 'GET', `/scheduling/versions/${v2.id}/impact`)).json;
      assert.equal(im.previous.length, 1); assert.equal(im.previous[0].id, v1.id);
      const mine = im.people.find((p: any) => p.employeeId === victim.employeeId);
      assert.ok(mine, 'the person whose shift was removed is listed');
      assert.ok(mine.removed + mine.changed + mine.added >= 1);
      assert.equal(im.totals.people, im.people.length);
      const r = await call(admin, 'POST', `/scheduling/versions/${v2.id}/publish`, { acknowledgeReason: 'test' });
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.impact.totals.people, im.totals.people);
      assert.equal((await call(admin, 'GET', `/scheduling/versions/${v1.id}`)).json.status, 'ARCHIVED');
    });
  });

  describe('the independent check', () => {
    it('validates a schedule the solver made, reports cover apart from validity, and finds a rule broken afterwards', async () => {
      const group = (await call(admin, 'POST', '/config/groups', { name: `Val ${RUN}` })).json;
      const t = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 }));
      const ids = await people(group, 8, 'VA'); await need(group, 4);
      const v = await build(group, '2026-12-07', [t.json.id]);
      const ok = await call(admin, 'POST', `/scheduling/versions/${v.id}/validate`, {});
      assert.equal(ok.status, 200, ok.text);
      assert.equal(ok.json.valid, true, JSON.stringify(ok.json.findings.filter((f: any) => f.severity === 'HARD')));
      assert.ok(['VALIDATED', 'VALIDATED_WITH_WARNINGS'].includes(ok.json.status));
      assert.ok(['ADEQUATE', 'UNDERSTAFFED'].includes(ok.json.coverageStatus), 'cover is reported on its own, apart from validity');
      assert.equal(ok.json.days.length, 7);
      // a rule is broken after the schedule was made: a person's weekly maximum is cut below what they were given
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.id}/shifts`)).json as any[];
      const who = shifts[0].employeeId;
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${who}`, { maxWeeklyHours: 8, weeklyContractHours: 8, reason: 'test: a contract changed after the schedule was made' })).status, 200);
      const bad = await call(admin, 'POST', `/scheduling/versions/${v.id}/validate`, {});
      assert.equal(bad.json.valid, false);
      const hit = bad.json.findings.find((f: any) => f.code === 'WEEKLY_MAX');
      assert.ok(hit && hit.severity === 'HARD' && hit.employeeId === who && hit.employeeName && hit.day, JSON.stringify(bad.json.findings.slice(0, 3)));
      const pub = await call(admin, 'POST', `/scheduling/versions/${v.id}/publish`, {});
      assert.equal(pub.status, 409, 'a roster that breaks a rule is not published');
      assert.ok(ids.includes(who));
    });

    it('the engine checks its own roster before answering, and the build records the verdict', async () => {
      const group = (await call(admin, 'POST', '/config/groups', { name: `Eng ${RUN}` })).json;
      const t = await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 }));
      await people(group, 6, 'EN'); await need(group, 3);
      const v = await build(group, '2026-12-14', [t.json.id]);
      const verdict = v.stats.solver.verdict;
      assert.ok(verdict && verdict.checked === true && verdict.valid === true, JSON.stringify(verdict));
      assert.ok(['VALIDATED', 'VALIDATED_WITH_WARNINGS'].includes(verdict.status));
      assert.ok(Array.isArray(v.stats.solver.capabilityNotes));
    });

    it('a person who must keep one usual start and end is held to it when the schedule is published, however it was made', async () => {
      await policy({ consistentTimes: { mode: 'OFF', startToleranceMin: 0, endToleranceMin: 0 } });
      const group = (await call(admin, 'POST', '/config/groups', { name: `Con ${RUN}` })).json;
      const early = await call(admin, 'POST', '/scheduling/templates', tpl({ name: `Early ${RUN}`, earliestStart: '07:00', latestStart: '07:00', durationHours: 9, mealMinutes: 60 }));
      const late = await call(admin, 'POST', '/scheduling/templates', tpl({ name: `Late ${RUN}`, earliestStart: '11:00', latestStart: '11:00', durationHours: 9, mealMinutes: 60 }));
      const ids = await people(group, 6, 'CN', { shiftConsistency: 'OFF' }); await need(group, 3);
      const v = await build(group, '2026-12-21', [early.json.id, late.json.id]);
      const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.id}/shifts`)).json as any[];
      const starts = new Map<string, Set<number>>();
      for (const sh of shifts) { if (!starts.has(sh.employeeId)) starts.set(sh.employeeId, new Set()); starts.get(sh.employeeId)!.add(sh.startSlot); }
      const mixed = [...starts].find(([, set]) => set.size > 1);
      assert.ok(mixed, 'nobody worked two different start times, so there was nothing to hold anyone to: make the scenario mix starts');
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${mixed[0]}`, { shiftConsistency: 'REQUIRE', reason: 'test: this person now must keep their usual times' })).status, 200);
      await policy({ consistentTimes: { mode: 'OFF', startToleranceMin: 30, endToleranceMin: 30 } });
      const check = await call(admin, 'POST', `/scheduling/versions/${v.id}/validate`, {});
      const hit = check.json.findings.find((f: any) => f.code === 'CONSISTENCY');
      assert.ok(hit && hit.severity === 'HARD' && hit.employeeId === mixed[0], JSON.stringify(check.json.findings.filter((f: any) => f.severity === 'HARD').slice(0, 3)));
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.id}/publish`, {})).status, 409);
      assert.ok(ids.includes(mixed[0]));
    });
  });

  describe('a person shared between groups in different time zones', () => {
    it('is kept clear of the other group shifts on the other group clock', async () => {
      // group A works on Manila time (UTC+8), early mornings; group B is on UTC and wants cover round the clock from the same people
      const A = (await call(admin, 'POST', '/config/groups', { name: `Manila ${RUN}`, timezone: 'Asia/Manila' })).json;
      const B = (await call(admin, 'POST', '/config/groups', { name: `London ${RUN}`, timezone: 'UTC' })).json;
      await people(A, 4, 'TZ', { eligibleGroupIds: [B.id] });
      const early = (await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '02:00', latestStart: '02:00', durationHours: 9, mealMinutes: 60, groupIds: [A.id] }))).json;
      const any = (await call(admin, 'POST', '/scheduling/templates', tpl({ earliestStart: '00:00', latestStart: '16:00', startStepMinutes: 120, durationHours: 9, mealMinutes: 60, groupIds: [B.id] }))).json;
      await need(A, 4, '02:00', '11:00'); await need(B, 4, '00:00', '23:45');
      const va = await build(A, '2026-12-07', [early.id]);
      assert.equal((await call(admin, 'POST', `/scheduling/versions/${va.id}/publish`, {})).status, 200);
      const vb = await build(B, '2026-12-07', [any.id], { guests: 'ALWAYS' });
      const sa = (await call(admin, 'GET', `/scheduling/versions/${va.id}/shifts`)).json as any[];
      const sb = (await call(admin, 'GET', `/scheduling/versions/${vb.id}/shifts`)).json as any[];
      assert.ok(sa.length > 0 && sb.length > 0);
      const at = (day: string, slot: number, offsetHours: number) => Date.parse(`${day}T00:00:00Z`) + slot * 900_000 - offsetHours * 3_600_000;    // an instant, from a wall-clock slot in a zone
      const manila = sa.map((s) => ({ who: s.employeeId, from: at(s.day, s.startSlot, 8), to: at(s.day, s.startSlot + s.lengthSlots, 8) }));
      const rest = 11 * 3_600_000;
      let shared = 0;
      for (const s of sb) {
        const from = at(s.day, s.startSlot, 0), to = at(s.day, s.startSlot + s.lengthSlots, 0);
        for (const m of manila.filter((x) => x.who === s.employeeId)) {
          shared++;
          assert.ok(to <= m.from - rest || from >= m.to + rest, `shift ${s.day} ${s.startTime}-${s.endTime} (UTC) is within ${11} hours of a Manila shift ${new Date(m.from).toISOString()}-${new Date(m.to).toISOString()}`);
        }
      }
      assert.ok(shared > 0, 'the same people were used by both groups, so the check means something');
    });
  });
});
