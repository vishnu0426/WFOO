/** Pure-logic tests for schedule evaluation, shortage analysis, break placement, the generation report and the per-skill split. No database needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyseShortage, buildReport, crewSizeNote, evaluateSchedule, headcount, optimizeBreaks, shortBlocks, staleReasons, type Helpers, type QShift } from '../src/modules/scheduleQuality.ts';
import { splitBySkill } from '../src/modules/skillSplit.ts';

const SPD = 96;
const days = ['2026-11-02', '2026-11-03'];
const sh = (employeeId: string, day: string, startSlot: number, lengthSlots: number, activities: any[] = []): QShift => ({ employeeId, day, startSlot, lengthSlots, activities });

describe('headcount and short blocks', () => {
  it('counts people per slot and finds runs of shortage', () => {
    const shifts = [sh('a', days[0], 32, 8), sh('b', days[0], 34, 8)];
    const sched = headcount(days, shifts);
    assert.equal(sched[32], 1); assert.equal(sched[34], 2); assert.equal(sched[42], 0);
    const required = new Array(days.length * SPD).fill(0);
    for (let s = 32; s < 44; s++) required[s] = 2;
    const blocks = shortBlocks(days, required, sched);
    assert.equal(blocks.length, 2);                    // short at 32-33 and 40-43
    assert.equal(blocks[0].shortSlots, 6);             // 40-43: 1 + 1 + 2 + 2 people short, the worst run comes first
    assert.equal(blocks[1].shortSlots, 2);
  });
});

describe('evaluateSchedule', () => {
  const records = Array.from({ length: 8 }, (_, i) => ({ day: days[0], slot: 40 + i, volume: 100, aht: 180, p10: 80, p90: 125 }));
  const base = { days, required: new Array(days.length * SPD).fill(0), records, serviceLevel: 0.8, answerSec: 20, shrinkage: 0, coverage: { percent: 100, requiredSlots: 100, overSlots: 0 }, violations: 0, overtimeHours: 0, paidHours: 100 };
  const crew = (n: number) => Array.from({ length: n }, (_, i) => sh(`p${i}`, days[0], 36, 24));      // 100 calls x 180s per 15 min = 20 erlangs

  it('a generous crew meets the target and scores high', () => {
    const r = evaluateSchedule({ ...base, shifts: crew(26) });
    assert.ok(r.summary.serviceLevel > 0.9);
    assert.equal(r.summary.intervalsBelowTarget, 0);
    assert.ok(r.score >= 90, `score ${r.score}`);
  });
  it('too few people fail the target and the score drops', () => {
    const r = evaluateSchedule({ ...base, shifts: crew(20) });
    assert.equal(r.summary.serviceLevel, 0);
    assert.equal(r.summary.intervalsBelowTarget, 8);
    assert.ok(r.score < 75);
    assert.ok(r.worst.length > 0);
  });
  it('a busy day is judged harder than a quiet one', () => {
    const r = evaluateSchedule({ ...base, shifts: crew(23) });
    assert.ok(r.summary.serviceLevelBusyDay <= r.summary.serviceLevel && r.summary.serviceLevel <= r.summary.serviceLevelQuietDay);
  });
  it('people at a break are not on the phones', () => {
    const withBreak = crew(26).map((s) => ({ ...s, activities: [{ type: 'BREAK', startSlot: 44, slots: 2 }] }));
    const a = evaluateSchedule({ ...base, shifts: crew(26) }), b = evaluateSchedule({ ...base, shifts: withBreak });
    assert.ok(b.intervals.find((x) => x.slot === 44)!.onPhones < a.intervals.find((x) => x.slot === 44)!.onPhones);
  });
  it('rule violations and overtime cost points', () => {
    const clean = evaluateSchedule({ ...base, shifts: crew(26) }).score;
    const bad = evaluateSchedule({ ...base, shifts: crew(26), violations: 4, overtimeHours: 20 }).score;
    assert.ok(bad < clean);
  });
  it('the parts of the score add up to 100 at most', () => {
    const r = evaluateSchedule({ ...base, shifts: crew(26) });
    assert.equal(r.parts.reduce((s, p) => s + p.max, 0), 100);
    assert.ok(r.parts.every((p) => p.points >= 0 && p.points <= p.max));
  });
});

describe('optimizeBreaks', () => {
  it('moves a break away from a slot that needs every person and keeps the shift, order and length', () => {
    // 4 people on shift 32-64; the middle (slots 44-47) needs all 4 on the phones, the edges need fewer
    const required = new Array(days.length * SPD).fill(0);
    for (let s = 32; s < 64; s++) required[s] = s >= 44 && s < 48 ? 4 : 2;
    const shifts = Array.from({ length: 4 }, (_, i) => sh(`p${i}`, days[0], 32, 32, [{ type: 'BREAK', startSlot: 44, slots: 2 }]));
    const r = optimizeBreaks({ days, shifts, required, shrinkage: 0, slackSlots: 8, flexOf: () => 2 });
    assert.ok(r.phoneShortfallAfter < r.phoneShortfallBefore, `${r.phoneShortfallBefore} -> ${r.phoneShortfallAfter}`);
    for (const m of r.moved) {
      assert.equal(m.activities.length, 1);
      assert.equal(m.activities[0].slots, 2);
      assert.ok(m.activities[0].startSlot > 32 && m.activities[0].startSlot + 2 < 64, 'inside the shift');
    }
  });
  it('never touches training or coaching and keeps activities in order and apart', () => {
    const required = new Array(days.length * SPD).fill(3);
    const acts = [{ type: 'BREAK', startSlot: 40, slots: 1 }, { type: 'TRAINING', startSlot: 44, slots: 4 }, { type: 'MEAL', startSlot: 52, slots: 2 }];
    const shifts = Array.from({ length: 3 }, (_, i) => sh(`p${i}`, days[0], 32, 32, acts));
    const r = optimizeBreaks({ days, shifts, required, shrinkage: 0, slackSlots: 12, flexOf: () => 2 });
    for (const m of r.moved) {
      const a = [...m.activities].sort((x, y) => x.startSlot - y.startSlot);
      assert.deepEqual(a.map((x) => x.type), ['BREAK', 'TRAINING', 'MEAL']);
      assert.deepEqual(a.find((x) => x.type === 'TRAINING'), acts[1]);
      for (let i = 1; i < a.length; i++) assert.ok(a[i].startSlot >= a[i - 1].startSlot + a[i - 1].slots);
    }
  });
  it('leaves things alone when there is nothing to gain', () => {
    const required = new Array(days.length * SPD).fill(1);
    const shifts = [sh('a', days[0], 32, 32, [{ type: 'MEAL', startSlot: 46, slots: 2 }])];
    const r = optimizeBreaks({ days, shifts, required, shrinkage: 0, slackSlots: 4, flexOf: () => 2 });
    assert.equal(r.phoneShortfallAfter, r.phoneShortfallBefore);
  });
});

describe('analyseShortage', () => {
  const helpers: Helpers = {
    blockedReason: (_c, e, _d, start) => (e.noNights && start >= 64 ? 'is not allowed overnight shifts' : null),
    dowOf: () => 0, mondayOf: () => '2026-11-02', addDays: (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); },
  };
  const emp = (id: string, extra: any = {}) => ({ id, firstName: id, lastName: 'X', status: 'ACTIVE', teamId: null, maxWeeklyHours: 40, workDaysPerWeek: 5, minRestHours: 11, maxConsecutiveDays: 6, ...extra });
  const tpl = { id: 't', status: 'ACTIVE', workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: 64, latestStart: 64, startStep: 2, lengthSlots: 34, mealSlots: 2 };
  const ctx: any = { employees: [emp('a', { noNights: true }), emp('b', { noNights: true }), emp('c')], templates: [tpl], timeOff: [], rules: { forTeam: () => [] } };

  it('names who could and could not cover, and offers actions', () => {
    const required = new Array(days.length * SPD).fill(0);
    for (let s = 70; s < 80; s++) required[s] = 2;
    const r = analyseShortage({ ctx, days, shifts: [], required, helpers, targetCoverage: 90, coveragePercent: 0 });
    assert.equal(r.meetsTarget, false);
    assert.equal(r.blocks.length, 1);
    const keys = Object.fromEntries(r.blocks[0].causes.map((c) => [c.key, c.people]));
    assert.equal(keys.NOT_ALLOWED, 2);
    assert.equal(keys.COULD_WORK, 1);
    assert.ok(r.blocks[0].actions.some((a) => a.type === 'ASSIGN'));
    assert.ok(r.blocks[0].actions.some((a) => a.type === 'OVERTIME'));
    assert.equal(r.topCauses[0].key, 'NOT_ALLOWED');
  });
  it('says so when the target is met', () => {
    const required = new Array(days.length * SPD).fill(0);
    const r = analyseShortage({ ctx, days, shifts: [], required, helpers, targetCoverage: 90, coveragePercent: 100 });
    assert.equal(r.meetsTarget, true); assert.equal(r.blocks.length, 0);
  });
  it('reports a person on approved time off, and one already working that day', () => {
    const required = new Array(days.length * SPD).fill(0);
    for (let s = 70; s < 76; s++) required[s] = 3;
    const c2: any = { ...ctx, timeOff: [{ employeeId: 'c', startDay: days[0], endDay: days[0] }] };
    const r = analyseShortage({ ctx: c2, days, shifts: [sh('a', days[0], 32, 32)], required, helpers, targetCoverage: 90, coveragePercent: 0 });
    const keys = Object.fromEntries(r.blocks[0].causes.map((c) => [c.key, c.people]));
    assert.equal(keys.TIME_OFF, 1);
    assert.ok((keys.ON_SHIFT_ELSEWHERE ?? 0) + (keys.NOT_ALLOWED ?? 0) >= 2);
  });
});

describe('buildReport', () => {
  const e = (id: string) => ({ id, firstName: id, lastName: 'Z' });
  const base = { requested: null, poolSize: 3, uncoveredDays: [], projectedDays: [], coveragePercent: 95, targetCoverage: 90, violations: 0, solverStatus: 'OPTIMAL', allEmployees: [], groupId: 'g', templatesUsed: 1 };
  it('succeeds cleanly when everyone is scheduled', () => {
    const r = buildReport({ ...base, pool: [e('a')], poolSize: 1, shifts: [sh('a', days[0], 32, 32)], optionsByPerson: new Map([['a', 5]]), blockedByPerson: new Map() });
    assert.equal(r.status, 'SUCCEEDED'); assert.equal(r.exceptions.length, 0); assert.deepEqual(r.unscheduled, []);
  });
  it('lists people with no possible shift and why, and people who were simply not needed', () => {
    const r = buildReport({ ...base, pool: [e('a'), e('b'), e('c')], shifts: [sh('a', days[0], 32, 32)], optionsByPerson: new Map([['a', 5], ['c', 4]]), blockedByPerson: new Map([['b', new Map([['no overnight shifts', 9]])]]) });
    assert.equal(r.status, 'SUCCEEDED_WITH_WARNINGS');
    const none = r.exceptions.find((x) => x.code === 'NO_POSSIBLE_SHIFT')!;
    assert.deepEqual(none.people!.map((p) => p.id), ['b']); assert.match(none.message, /no overnight shifts/);
    assert.deepEqual(r.exceptions.find((x) => x.code === 'NOT_NEEDED')!.people!.map((p) => p.id), ['c']);
    assert.equal(r.unscheduled.length, 2);
    assert.match(r.unscheduled.find((u) => u.id === 'b')!.reason, /^No shift possible: no overnight shifts/);
    assert.match(r.unscheduled.find((u) => u.id === 'c')!.reason, /^Not needed/);
  });
  it('flags chosen people who are not eligible, missing forecast days and coverage below target', () => {
    const r = buildReport({ ...base, pool: [e('a')], poolSize: 1, requested: { employeeIds: ['a', 'x'] }, allEmployees: [e('a'), e('x')], shifts: [sh('a', days[0], 32, 32)], optionsByPerson: new Map([['a', 1]]), blockedByPerson: new Map(), uncoveredDays: ['2026-11-09'], coveragePercent: 61 });
    const codes = r.exceptions.map((x) => x.code);
    assert.ok(codes.includes('NOT_ELIGIBLE') && codes.includes('NO_FORECAST') && codes.includes('BELOW_TARGET'));
  });
});

describe('staleReasons', () => {
  it('is empty while the forecast is unchanged and explains each way it can go stale', () => {
    const ok = { settings: { forecastRev: 3 }, forecastId: 'f', forecastRevNow: 3, forecastStatusNow: 'PUBLISHED', newerPublishedForecast: null };
    assert.deepEqual(staleReasons(ok), []);
    assert.equal(staleReasons({ ...ok, forecastRevNow: 4 }).length, 1);
    assert.equal(staleReasons({ ...ok, forecastStatusNow: 'ARCHIVED' }).length, 1);
    assert.equal(staleReasons({ ...ok, newerPublishedForecast: { id: 'n', name: 'v9' } }).length, 1);
    assert.deepEqual(staleReasons({ settings: {}, forecastId: null, forecastRevNow: null, forecastStatusNow: null, newerPublishedForecast: null }), []);
  });
});

describe('splitBySkill', () => {
  it('always adds up to the pooled requirement, in proportion to workload', () => {
    const required = [10, 7, 0, 5];
    const out = splitBySkill(required, [[30, 10, 5, 0], [10, 10, 5, 0]]);
    for (let g = 0; g < required.length; g++) assert.equal(out[0][g] + out[1][g], required[g]);
    assert.deepEqual([out[0][0], out[1][0]], [8, 2]);        // 75% / 25% of 10 is 7.5 / 2.5: the larger remainder goes first
    assert.equal(out[0][1], 4); assert.equal(out[1][1], 3);
  });
  it('a quiet slot follows the shares of the whole period', () => {
    const out = splitBySkill([4, 4], [[90, 0], [10, 0]]);
    assert.equal(out[0][1] + out[1][1], 4); assert.ok(out[0][1] >= out[1][1]);
  });
});

describe('crewSizeNote', () => {
  it('says nothing when the contracts roughly match what the forecast needs', () => {
    assert.equal(crewSizeNote({ people: 10, contractHours: 400, requiredSlots: 400 * 4 }), null);
    assert.equal(crewSizeNote({ people: 10, contractHours: 400, requiredSlots: 330 * 4 }), null);
  });
  it('points out surplus and how many people would do', () => {
    const n = crewSizeNote({ people: 355, contractHours: 14200, requiredSlots: 8400 * 4 })!;
    assert.equal(n.level, 'WARNING');
    assert.match(n.message, /14,200 contract hours/);
    assert.match(n.message, /8,400 hours on shift/);
    assert.match(n.message, /41%/);
    assert.match(n.message, /About 210 people/);
  });
  it('is only a note for a mild surplus', () => {
    assert.equal(crewSizeNote({ people: 10, contractHours: 400, requiredSlots: 300 * 4 })!.level, 'INFO');
  });
  it('has nothing to say without a requirement or contracts', () => {
    assert.equal(crewSizeNote({ people: 5, contractHours: 200, requiredSlots: 0 }), null);
    assert.equal(crewSizeNote({ people: 0, contractHours: 0, requiredSlots: 100 }), null);
  });
});
