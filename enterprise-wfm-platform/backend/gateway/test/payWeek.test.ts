/**
 * The pay week (the weekday a week of contract hours begins on): a company default in the scheduling policy, an optional override on a
 * WFM group, and Generate Schedule using whichever applies when the request does not name one. The end-to-end case is a Sunday-to-Saturday
 * schedule: with Monday weeks it would be cut into a 1-day and a 6-day week and people would not reach 40 hours.
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const SUNDAY = '2026-11-01';   // a Sunday

const ctx: Record<string, any> = {};
let admin = '';
let companyBefore: any = null;

const savePolicy = (pol: any, scheduling: any) => call(admin, 'PUT', '/config/scheduling-policy', {
  minRestHours: pol.minRestHours, maxWeeklyHours: pol.maxWeeklyHours, maxConsecutiveDays: pol.maxConsecutiveDays, maxDaysPerWeek: pol.maxDaysPerWeek,
  adherenceGraceSeconds: pol.adherenceGraceSeconds, weights: pol.weights, timelineColors: pol.timelineColors, scheduling,
});
const readiness = (groupId: string) => call(admin, 'GET', `/scheduling/readiness?groupId=${groupId}&from=${SUNDAY}&weeks=1&coverageSource=MANUAL`);

describe('pay week setting', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    companyBefore = (await call(admin, 'GET', '/config/scheduling-policy')).json;
  });
  after(async () => { if (companyBefore) await savePolicy(companyBefore, companyBefore.scheduling); });   // leave the company setting as it was

  it('is Monday, from no setting at all, for a new group', async () => {
    await savePolicy(companyBefore, { ...companyBefore.scheduling, payWeekStart: 0 });
    const g = await call(admin, 'POST', '/config/groups', { name: `PayWeek ${RUN}` });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    assert.equal(g.json.payWeekStart, null);
    const r = await readiness(ctx.group.id);
    assert.equal(r.json.payWeek.start, 0);
  });

  it('takes the company default, and a client that leaves it out does not wipe it', async () => {
    const saved = await savePolicy(companyBefore, { ...companyBefore.scheduling, payWeekStart: 6 });
    assert.equal(saved.status, 200, saved.text); assert.equal(saved.json.scheduling.payWeekStart, 6);
    assert.deepEqual((await readiness(ctx.group.id)).json.payWeek, { start: 6, source: 'COMPANY', companyStart: 6 });
    const { payWeekStart, ...older } = companyBefore.scheduling;
    const again = await savePolicy(companyBefore, { ...older, targetCoverage: 91 });
    assert.equal(again.json.scheduling.payWeekStart, 6);
  });

  it('lets a group override it, keeps the override through other edits, and falls back when cleared', async () => {
    let u = await call(admin, 'PUT', `/config/groups/${ctx.group.id}`, { payWeekStart: 2 });
    assert.equal(u.json.payWeekStart, 2);
    assert.deepEqual((await readiness(ctx.group.id)).json.payWeek, { start: 2, source: 'GROUP', companyStart: 6 });
    u = await call(admin, 'PUT', `/config/groups/${ctx.group.id}`, { description: 'edited' });
    assert.equal(u.json.payWeekStart, 2);
    u = await call(admin, 'PUT', `/config/groups/${ctx.group.id}`, { payWeekStart: null });
    assert.equal(u.json.payWeekStart, null);
    assert.equal((await readiness(ctx.group.id)).json.payWeek.start, 6);
    assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.group.id}`, { payWeekStart: 7 })).status, 400);
  });

  it('is used by Generate Schedule when the request names none: a Sunday week gives everyone 40 hours', async () => {
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8.5, mealMinutes: 30, breakCount: 0, breakMinutes: 15 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
    for (let i = 1; i <= 7; i++) {
      const e = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `PW${RUN}-${i}`, firstName: `Person${i}`, lastName: 'Test', primaryGroupId: ctx.group.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
      assert.equal(e.status, 201, e.text);
    }
    for (let d = 0; d < 7; d++) {
      const w = await call(admin, 'POST', `/config/groups/${ctx.group.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 6 });   // 42 shifts wanted from 7 people who can work 35: only an engine that counts a Sunday week holds everyone to 5 days
      assert.equal(w.status, 201, w.text);
    }
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: SUNDAY, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.settings.weekStart, 6, 'the schedule remembers the pay week it was built with');
    assert.equal(r.json.stats.hours.paid, 7 * 40, 'seven people, five 8-hour days each: the cap of a Sunday-to-Saturday week');
    assert.equal(r.json.stats.hours.overtime, 0);
    assert.equal(r.json.stats.violations, 0, 'nobody works a sixth day in the Sunday week');
  });

  it('can still be set for one run, and that run remembers it', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: SUNDAY, weeks: 1, weekStart: 0, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [ctx.tpl.id] });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.settings.weekStart, 0);
  });
});
