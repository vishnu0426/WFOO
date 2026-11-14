/**
 * A meal is not coverage. The schedule's coverage figures must count a person on their meal as away, and the solver must have been told where each meal is (so the number it aimed for
 * is the number shown). Needs a running gateway:  BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/mealCoverage.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addShiftCoverage, mealOffset, coveredSlots } from '../src/modules/shiftCoverage.ts';

describe('what a shift covers', () => {
  const shift = { startSlot: 32, lengthSlots: 16, activities: [{ type: 'MEAL', startSlot: 38, slots: 2 }, { type: 'BREAK', startSlot: 35, slots: 1 }] };
  it('leaves out the meal, and keeps breaks (the shrinkage percentage already allows for those)', () => {
    const cover = new Array(96).fill(0);
    addShiftCoverage(cover, 0, shift);
    assert.equal(cover.reduce((a, b) => a + b, 0), 14);
    assert.equal(cover[38], 0); assert.equal(cover[39], 0); assert.equal(cover[35], 1); assert.equal(cover[37], 1); assert.equal(cover[40], 1);
    assert.equal(coveredSlots(shift), 14);
  });
  it('lands on the right day of a longer period, and ignores slots past its end', () => {
    const cover = new Array(96 * 2).fill(0);
    addShiftCoverage(cover, 1, { startSlot: 90, lengthSlots: 20, activities: [] });
    assert.equal(cover.slice(96 + 90, 96 + 96).every((v) => v === 1), true);
    assert.equal(cover.reduce((a, b) => a + b, 0), 6, 'only what falls inside the period');
  });
  it('a split-shift gap is away time as well', () => {
    const cover = new Array(96).fill(0);
    addShiftCoverage(cover, 0, { startSlot: 28, lengthSlots: 40, activities: [{ type: 'SPLIT_GAP', startSlot: 44, slots: 12 }] });
    assert.equal(cover.reduce((a, b) => a + b, 0), 28);
  });
});

describe('where a meal falls', () => {
  it('is in the middle of the shift when there is no flexibility, and inside the shift whatever the flexibility', () => {
    assert.equal(mealOffset({ flexSlots: 0 }, 34, 2, 0, 0), 16);
    for (let who = 0; who < 40; who++) for (let day = 0; day < 7; day++) {
      const o = mealOffset({ flexSlots: 6 }, 34, 2, who, day)!;
      assert.ok(o >= 1 && o + 2 <= 33, `offset ${o}`);
    }
  });
  it('spreads people across the flexibility the template allows, so they do not all eat together', () => {
    const times = new Set(Array.from({ length: 30 }, (_, who) => mealOffset({ flexSlots: 4 }, 34, 2, who, 0)));
    assert.ok(times.size >= 6, `only ${times.size} different meal times for 30 people`);
  });
  it('honours an anchored meal, and gives none to a shift with no meal or no room for one', () => {
    assert.equal(mealOffset({ mealAnchorSlot: 20, flexSlots: 0 }, 34, 2, 3, 3), 20);
    assert.equal(mealOffset({}, 34, 0, 0, 0), null);
    assert.equal(mealOffset({}, 4, 2, 0, 0), null);
  });
});

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('the schedule counts meals as away', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', version: any, group: any;
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Meals ${RUN}` })).json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Meal day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '09:00', durationHours: 9, mealMinutes: 60, breakCount: 0, breakMinutes: 15, flexMinutes: 60 });
    assert.equal(t.status, 201, t.text);
    for (let i = 1; i <= 14; i++) assert.equal((await call(admin, 'POST', '/workforce/employees', { employeeNumber: `ML${RUN}-${i}`, firstName: `Meal${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).status, 201);
    for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 6 })).status, 201);
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from: '2026-11-09', weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [t.json.id], useHistory: false });
    assert.equal(v.status, 201, v.text); version = v.json;
  });

  it('reports, for every quarter-hour, exactly the people on shift who are not on a meal', async () => {
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${version.id}/shifts`)).json as any[];
    assert.ok(shifts.some((s) => s.activities.some((a: any) => a.type === 'MEAL')), 'the shifts have meals');
    const day = '2026-11-10';
    const expected = new Array(96).fill(0), withMeals = new Array(96).fill(0);
    for (const s of shifts.filter((x) => x.day === day)) {
      addShiftCoverage(expected, 0, s);
      for (let k = s.startSlot; k < Math.min(96, s.startSlot + s.lengthSlots); k++) withMeals[k]++;
    }
    const cov = (await call(admin, 'GET', `/scheduling/versions/${version.id}/coverage?day=${day}&grain=15`)).json;
    assert.deepEqual(cov.slots.map((s: any) => s.scheduled), expected, 'the coverage view shows people on shift less those on a meal');
    assert.ok(withMeals.some((v, k) => v > expected[k]), 'and that is fewer than everyone on shift at some time');
  });

  it('is what the solver was told: the meals are spread out, not all at the same time', async () => {
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${version.id}/shifts`)).json as any[];
    const starts = new Set(shifts.flatMap((s) => s.activities.filter((a: any) => a.type === 'MEAL').map((a: any) => a.startSlot)));
    assert.ok(starts.size >= 3, `${starts.size} different meal times`);
  });
});
