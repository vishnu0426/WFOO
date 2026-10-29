/** Rotation arithmetic: weekly templates unrolled to a day cycle, and what a pattern means for hours, rest, runs and weekends. Pure, needs no server. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analysePattern, compileWeekly, type TemplateLite } from '../src/modules/rotationPlan.ts';

const T = (id: string, startSlot: number, lengthSlots: number, paidSlots = lengthSlots - 2): TemplateLite => ({ id, name: id, startSlot, lengthSlots, paidSlots, active: true });
const templates = (...t: TemplateLite[]) => new Map(t.map((x) => [x.id, x]));
const noLimits = {};

describe('compileWeekly', () => {
  it('repeats each step for its weeks and joins them in order', () => {
    const a = ['D', 'D', 'D', 'D', 'D', null, null], b = [null, 'E', 'E', 'E', 'E', 'E', null];
    const out = compileWeekly([{ name: 'Days', weeks: 2, days: a }, { name: 'Lates', weeks: 1, days: b }]);
    assert.equal(out.length, 21);
    assert.deepEqual(out.slice(0, 7), a); assert.deepEqual(out.slice(7, 14), a); assert.deepEqual(out.slice(14), b);
  });
});

describe('analysePattern', () => {
  const day = T('D', 28, 48, 46);   // 07:00, 12 h with a 30-minute meal: 11.5 paid hours

  it('4-on-4-off on 12-hour shifts: runs, hours and rest', () => {
    const r = analysePattern({ cycleDays: 8, sequence: ['D', 'D', 'D', 'D', null, null, null, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits, contractHours: 40 });
    const c = r.crews[0];
    assert.equal(c.shiftsPerCycle, 4); assert.equal(c.longestRun, 4); assert.equal(c.paidHoursPerCycle, 46);
    assert.equal(c.averageWeeklyHours, 40.3);         // 46 h per 8 days
    assert.equal(c.shortestRestHours, 12);            // same shift each day: 07:00 + 12 h, next at 07:00
    assert.equal(c.maxDaysInAnyWeek, 4);
    assert.ok(r.findings.some((f) => f.level === 'OK'));
  });

  it('flags a late-to-early changeover against the rest limit, and hours against the contract', () => {
    const late = T('L', 56, 32, 30), early = T('E', 24, 32, 30);   // 14:00-22:00 then 06:00 the next day: 8 h apart
    const r = analysePattern({ cycleDays: 7, sequence: ['L', 'L', 'E', 'E', 'E', null, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(late, early), limits: { minRestHours: 11, maxWeeklyHours: 40 }, contractHours: 40 });
    assert.equal(r.crews[0].shortestRestHours, 8);
    assert.ok(r.findings.some((f) => f.level === 'WARN' && /8 h apart/.test(f.text)));
    assert.ok(r.findings.some((f) => /averages 37.5 h/.test(f.text)));       // five 7.5 h shifts against a 40 h contract
  });

  it('knows when there is no day off, and a run that is too long', () => {
    const all = analysePattern({ cycleDays: 4, sequence: ['D', 'D', 'D', 'D'], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(all.crews[0].neverOff, true);
    assert.ok(all.findings.some((f) => /no day off/i.test(f.text)));
    const long = analysePattern({ cycleDays: 10, sequence: ['D', 'D', 'D', 'D', 'D', 'D', 'D', null, null, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: { maxConsecutiveDays: 6 } });
    assert.equal(long.crews[0].longestRun, 7);
    assert.ok(long.findings.some((f) => f.level === 'WARN' && /7 working days/.test(f.text)));
  });

  it('counts a run that wraps around the end of the cycle once, not twice', () => {
    const r = analysePattern({ cycleDays: 8, sequence: ['D', 'D', null, null, null, null, 'D', 'D'], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(r.crews[0].longestRun, 4);
  });

  it('weekends: Monday to Friday work never touches one; 2-2-3 gives every other weekend off', () => {
    const wk = analysePattern({ cycleDays: 7, sequence: ['D', 'D', 'D', 'D', 'D', null, null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(wk.crews[0].weekendDaysPerWeek, 0); assert.equal(wk.crews[0].weekendsFullyOff, 1);
    const seq = ['D', 'D', null, null, 'D', 'D', 'D', null, null, 'D', 'D', null, null, null];
    const p = analysePattern({ cycleDays: 14, sequence: seq, crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(p.crews[0].weekendDaysPerWeek, 1);       // Sat and Sun worked in one week of two
    assert.equal(p.crews[0].weekendsFullyOff, 0.5);
  });

  it('compares crews: the same week shifted can give one crew the weekends', () => {
    const seq = ['D', 'D', 'D', 'D', 'D', null, null];       // Monday to Friday
    const r = analysePattern({ cycleDays: 7, sequence: seq, crews: [{ name: 'A', offsetDays: 0 }, { name: 'B', offsetDays: 5 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(r.crews[0].weekendDaysPerWeek, 0);
    assert.equal(r.crews[1].weekendDaysPerWeek, 2);          // B works Wednesday to Sunday
    assert.ok(r.findings.some((f) => f.level === 'INFO' && /B works more weekend days/.test(f.text)));
    const even = analysePattern({ cycleDays: 14, sequence: ['D', 'D', null, null, 'D', 'D', 'D', null, null, 'D', 'D', null, null, null], crews: [{ name: 'A', offsetDays: 0 }, { name: 'B', offsetDays: 7 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.equal(even.crews[0].weekendDaysPerWeek, even.crews[1].weekendDaysPerWeek, '2-2-3 is built so every offset shares the weekends equally');
  });

  it('says so when nothing is scheduled, and when a template is gone', () => {
    const empty = analysePattern({ cycleDays: 7, sequence: new Array(7).fill(null), crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.ok(empty.findings.some((f) => /No day in this pattern has a shift/.test(f.text)));
    const gone = analysePattern({ cycleDays: 2, sequence: ['X', null], crews: [{ name: 'A', offsetDays: 0 }], anchorDow: 0, templates: templates(day), limits: noLimits });
    assert.ok(gone.findings.some((f) => /inactive or missing/.test(f.text)));
  });
});
