/** Shift template rules: lengths, meals and breaks by length, per-day windows, who a template is offered to. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkTemplate, isVariable, lengthsOf, paidSlots, rulesFor, startsFor, unpaidMeal, whyNotOffered, windowFor, type TemplateLike } from '../src/modules/templateRules.ts';

const base: TemplateLike = { workDays: [0, 1, 2, 3, 4], earliestStart: 24, latestStart: 36, startStep: 2, lengthSlots: 34, mealSlots: 2, breakCount: 2, breakSlots: 1 };
const person = { groupIds: ['g1'], employmentType: 'FULL_TIME', skillIds: ['s1'] };

describe('templateRules', () => {
  describe('lengths', () => {
    it('a fixed template offers one length', () => {
      assert.deepEqual(lengthsOf(base), [34]);
      assert.equal(isVariable(base), false);
    });
    it('a variable template offers every length from shortest to longest in steps, ending on the longest', () => {
      assert.deepEqual(lengthsOf({ lengthSlots: 40, minLengthSlots: 16, lengthStep: 4 }), [16, 20, 24, 28, 32, 36, 40]);
      assert.deepEqual(lengthsOf({ lengthSlots: 34, minLengthSlots: 16, lengthStep: 4 }), [16, 20, 24, 28, 32, 34], 'the longest is always offered');
      assert.equal(isVariable({ lengthSlots: 34, minLengthSlots: 16 }), true);
    });
    it('treats a shortest length at or above the longest as fixed', () => {
      assert.deepEqual(lengthsOf({ lengthSlots: 34, minLengthSlots: 34 }), [34]);
      assert.deepEqual(lengthsOf({ lengthSlots: 34, minLengthSlots: 50 }), [34]);
    });
  });

  describe('meal and breaks by length', () => {
    it('a fixed template keeps its own meal and breaks for its length', () => {
      assert.deepEqual(rulesFor(base, 34), { mealSlots: 2, breakCount: 2, breakSlots: 1 });
    });
    it('a variable template without rules scales: meal from 5 hours, a break for every 4 hours', () => {
      const t = { ...base, minLengthSlots: 16 };
      assert.deepEqual(rulesFor(t, 16), { mealSlots: 0, breakCount: 1, breakSlots: 1 });   // 4 h: one break, no meal
      assert.deepEqual(rulesFor(t, 24), { mealSlots: 2, breakCount: 1, breakSlots: 1 });   // 6 h
      assert.deepEqual(rulesFor(t, 34), { mealSlots: 2, breakCount: 2, breakSlots: 1 });   // 8.5 h
    });
    it('explicit rules use the one with the largest start not above the length, and shorter shifts get nothing', () => {
      const t = { ...base, minLengthSlots: 12, lengthRules: [{ fromSlots: 16, mealSlots: 0, breakCount: 1, breakSlots: 1 }, { fromSlots: 28, mealSlots: 4, breakCount: 2, breakSlots: 1 }] };
      assert.deepEqual(rulesFor(t, 12), { mealSlots: 0, breakCount: 0, breakSlots: 1 });
      assert.deepEqual(rulesFor(t, 20), { mealSlots: 0, breakCount: 1, breakSlots: 1 });
      assert.deepEqual(rulesFor(t, 28), { mealSlots: 4, breakCount: 2, breakSlots: 1 });
      assert.deepEqual(rulesFor(t, 34), { mealSlots: 4, breakCount: 2, breakSlots: 1 });
    });
    it('a meal never swallows the shift', () => {
      assert.equal(rulesFor({ ...base, mealSlots: 8 }, 8).mealSlots, 0);
    });
    it('paid time is the length less the unpaid meal, and a paid meal costs nothing', () => {
      assert.equal(unpaidMeal(base, 34), 2);
      assert.equal(paidSlots(base, 34), 32);
      assert.equal(paidSlots({ ...base, mealPaid: true }, 34), 34);
      assert.equal(paidSlots(null, 34), 34, 'a shift without a template has no unpaid meal');
    });
  });

  describe('start times by weekday', () => {
    it('uses the general window unless the day has its own', () => {
      const t = { ...base, dayWindows: { '4': { earliest: 20, latest: 24 } } };
      assert.deepEqual(windowFor(t, 0), { earliest: 24, latest: 36 });
      assert.deepEqual(windowFor(t, 4), { earliest: 20, latest: 24 });
      assert.deepEqual(startsFor(t, 0), [24, 26, 28, 30, 32, 34, 36]);
      assert.deepEqual(startsFor(t, 4), [20, 22, 24]);
    });
    it('offers nothing on a day the template does not run', () => {
      assert.deepEqual(startsFor(base, 6), []);
      assert.deepEqual(startsFor({ ...base, dayWindows: { '6': { earliest: 24, latest: 30 } } }, 6), [], 'a window does not switch a day on');
    });
  });

  describe('who a template is offered to', () => {
    it('everyone, when nothing is restricted', () => assert.equal(whyNotOffered(base, person, '2026-11-02'), null));
    it('respects the dates it is in force', () => {
      const t = { ...base, effectiveFrom: '2026-11-05', effectiveTo: '2026-12-01' };
      assert.match(whyNotOffered(t, person, '2026-11-04')!, /not started/);
      assert.equal(whyNotOffered(t, person, '2026-11-05'), null);
      assert.equal(whyNotOffered(t, person, '2026-12-01'), null);
      assert.match(whyNotOffered(t, person, '2026-12-02')!, /ended/);
    });
    it('respects groups, contract types and skills', () => {
      assert.match(whyNotOffered({ ...base, groupIds: ['g2'] }, person, '2026-11-02')!, /other groups/);
      assert.equal(whyNotOffered({ ...base, groupIds: ['g2', 'g1'] }, person, '2026-11-02'), null);
      assert.match(whyNotOffered({ ...base, employmentTypes: ['PART_TIME'] }, person, '2026-11-02')!, /contract types/);
      assert.match(whyNotOffered({ ...base, skillIds: ['s9'] }, person, '2026-11-02')!, /skill/);
      assert.equal(whyNotOffered({ ...base, skillIds: ['s9', 's1'] }, person, '2026-11-02'), null, 'any one of the skills is enough');
    });
    it('treats empty lists as no restriction', () => {
      assert.equal(whyNotOffered({ ...base, groupIds: [], employmentTypes: [], skillIds: [] }, person, '2026-11-02'), null);
    });
  });

  describe('checkTemplate', () => {
    it('accepts a sensible variable template', () => {
      assert.equal(checkTemplate({ ...base, minLengthSlots: 16, lengthRules: [{ fromSlots: 20, mealSlots: 2, breakCount: 1, breakSlots: 1 }] }), null);
    });
    it('rejects nonsense', () => {
      assert.match(checkTemplate({ ...base, minLengthSlots: 40 })!, /shortest/);
      assert.match(checkTemplate({ ...base, dayWindows: { '2': { earliest: 40, latest: 30 } } })!, /latest start/);
      assert.match(checkTemplate({ ...base, dayWindows: { '9': { earliest: 1, latest: 2 } } })!, /weekday/);
      assert.match(checkTemplate({ ...base, lengthRules: [{ fromSlots: 20, mealSlots: 0, breakCount: 0, breakSlots: 1 }, { fromSlots: 20, mealSlots: 0, breakCount: 1, breakSlots: 1 }] })!, /same length/);
      assert.match(checkTemplate({ ...base, lengthRules: [{ fromSlots: 8, mealSlots: 8, breakCount: 0, breakSlots: 1 }] })!, /too long/);
      assert.match(checkTemplate({ ...base, effectiveFrom: '2026-12-01', effectiveTo: '2026-11-01' })!, /end before/);
    });
  });
});
