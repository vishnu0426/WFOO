/** 'Days off together each week': the rule in the catalogue, what a country pack or the company can set, how a schedule is judged against it, and how a rotation pattern shows it. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, checkPerson, limitsFrom, longestOffRun, normaliseRule, wholeWeeksIn, type Rule } from '../src/modules/compliance/rules.ts';
import { analysePattern, type TemplateLite } from '../src/modules/rotationPlan.ts';

const rule = (type: Rule['type'], params: Record<string, any>, severity: Rule['severity'] = 'BLOCK'): Rule => normaliseRule({ type, params, severity });
const asha = { id: 'a', name: 'Asha', nightConsent: true };
const shift = (day: string) => ({ day, startSlot: 36, lengthSlots: 34, mealSlots: 4 });
// 2026-10-05 is a Monday
const days = (...d: number[]) => d.map((n) => shift(`2026-10-${String(5 + n).padStart(2, '0')}`));
const week = { from: '2026-10-05', to: '2026-10-18' };

describe('days off together: the rule', () => {
  it('is in the catalogue with a limit a week can hold', () => {
    const c = CATALOG.find((x) => x.type === 'MIN_DAYS_OFF_TOGETHER')!;
    assert.ok(c, 'listed');
    assert.deepEqual([c.params[0].min, c.params[0].max, c.params[0].default], [1, 3, 2]);
    assert.equal(normaliseRule({ type: 'MIN_DAYS_OFF_TOGETHER', params: { days: 9 } }).params.days, 3, 'never above what the screen allows');
  });

  it('is read by the generator from a BLOCK rule only, the strictest one winning', () => {
    assert.equal(limitsFrom([rule('MIN_DAYS_OFF_TOGETHER', { days: 2 }), rule('MIN_DAYS_OFF_TOGETHER', { days: 3 })]).minDaysOffTogether, 3);
    assert.equal(limitsFrom([rule('MIN_DAYS_OFF_TOGETHER', { days: 2 }, 'WARN')]).minDaysOffTogether, undefined);
    assert.equal(limitsFrom([]).minDaysOffTogether, undefined);
  });
});

describe('days off together: judging a schedule', () => {
  it('finds the longest run of days off in a week, counting only the seven days', () => {
    const worked = new Set(['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10']);        // Mon Tue Thu Fri Sat; off Wed and Sun
    assert.equal(longestOffRun(worked, '2026-10-05'), 1);
    assert.equal(longestOffRun(new Set(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']), '2026-10-05'), 2);
    assert.equal(longestOffRun(new Set(), '2026-10-05'), 7);
    assert.equal(longestOffRun(new Set(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']), '2026-10-05'), 0);
  });

  it('judges only the pay weeks that lie wholly inside the period', () => {
    assert.deepEqual(wholeWeeksIn(['2026-10-05', '2026-10-13'], week), ['2026-10-05', '2026-10-12']);
    assert.deepEqual(wholeWeeksIn(['2026-10-05'], { from: '2026-10-06', to: '2026-10-18' }), [], 'the first week starts before the period');
    assert.deepEqual(wholeWeeksIn(['2026-10-12'], { from: '2026-10-05', to: '2026-10-17' }), [], 'the last week runs past the period');
    assert.deepEqual(wholeWeeksIn(['2026-10-09'], { from: '2026-10-01', to: '2026-10-31' }, 2), ['2026-10-07'], 'a pay week that starts on a Wednesday runs Wednesday to Tuesday');
    assert.deepEqual(wholeWeeksIn(['2026-10-09'], { from: '2026-10-05', to: '2026-10-12' }, 2), [], 'and is cut by a period that ends on the Monday');
  });

  it('flags a week whose days off are split, and accepts one whose days off are side by side', () => {
    const r = [rule('MIN_DAYS_OFF_TOGETHER', { days: 2 })];
    const split = checkPerson(r, asha, days(0, 1, 3, 4, 5), 0, week);                      // off Wednesday and Sunday
    assert.equal(split.length, 1);
    assert.match(split[0].message, /at most 1 day off together in the week of 2026-10-05 \(needs 2\)/);
    assert.equal(split[0].day, '2026-10-05');
    assert.equal(checkPerson(r, asha, days(0, 1, 2, 3, 4), 0, week).length, 0);            // Saturday and Sunday off
    assert.equal(checkPerson(r, asha, days(0, 1, 2, 3, 4, 5, 6), 0, week)[0].message.includes('no day off together'), true);
  });

  it('counts a block that runs from Sunday into the next pay week as two different weeks (each week stands alone)', () => {
    const r = [rule('MIN_DAYS_OFF_TOGETHER', { days: 2 })];
    // week 1 off only Sunday, week 2 off only Monday: together they are side by side across the boundary, but neither week holds two
    const f = checkPerson(r, asha, [...days(0, 1, 2, 3, 4, 5), ...days(8, 9, 10, 11, 12, 13)], 0, week);
    assert.equal(f.length, 2);
  });

  it('is not judged without the period (a hand-checked pattern has none), and weeks with no work are not judged', () => {
    const r = [rule('MIN_DAYS_OFF_TOGETHER', { days: 2 })];
    assert.equal(checkPerson(r, asha, days(0, 1, 3, 4, 5), 0).length, 0);
    assert.equal(checkPerson(r, asha, days(0, 1, 2, 3, 4), 0, week).length, 0, 'the second week has no shift: nothing to say');
  });

  it('asks for a single day off when the rule says 1', () => {
    const r = [rule('MIN_DAYS_OFF_TOGETHER', { days: 1 })];
    assert.equal(checkPerson(r, asha, days(0, 1, 2, 3, 4, 5), 0, week).length, 0);
    assert.equal(checkPerson(r, asha, days(0, 1, 2, 3, 4, 5, 6), 0, week).length, 1);
  });
});

describe('days off together: rotation patterns', () => {
  const tpl = new Map<string, TemplateLite>([['D', { id: 'D', name: 'Day', startSlot: 32, lengthSlots: 36, paidSlots: 32, active: true }]]);
  const analyse = (sequence: (string | null)[], minDaysOffTogether: number | null, anchorDow = 0) =>
    analysePattern({ cycleDays: sequence.length, sequence, crews: [{ name: 'A', offsetDays: 0 }], anchorDow, weekStart: 0, templates: tpl, limits: { minDaysOffTogether } });
  const o = null, D = 'D';

  it('is quiet for 5 on and 2 off, whatever the second day off is', () => {
    const a = analyse([D, D, D, D, D, o, o], 2);
    assert.equal(a.crews[0].weeksWithoutOffBlock, 0);
    assert.ok(!a.findings.some((f) => /days off side by side/.test(f.text)));
  });

  it('says so when the days off never sit together', () => {
    const a = analyse([D, D, o, D, D, D, o], 2);                      // off Wednesday and Sunday every week
    assert.equal(a.crews[0].weeksWithoutOffBlock, a.crews[0].weeksChecked);
    assert.ok(a.findings.some((f) => f.level === 'WARN' && /never 2 days off side by side/.test(f.text)), JSON.stringify(a.findings));
  });

  it('counts the weeks it fails in over a cycle that is not a whole number of weeks', () => {
    const a = analyse([D, D, D, D, o, o, o, o, D, D, D, D, o, o, o, o, D, D, D, D, o, o, o, o, D, D, D, D], 3);
    assert.ok(a.crews[0].weeksChecked > 0 && a.crews[0].weeksWithoutOffBlock >= 0 && a.crews[0].weeksWithoutOffBlock <= a.crews[0].weeksChecked);
  });

  it('says nothing and counts nothing when no limit is set', () => {
    const a = analyse([D, D, o, D, D, D, o], null);
    assert.equal(a.crews[0].weeksChecked, 0);
    assert.ok(!a.findings.some((f) => /days off side by side/.test(f.text)));
  });
});
