/** 'Full weekends off each month': which weekends a month has, what a schedule that holds only part of the month must give, and which days a weekends-off request covers. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { engineMonths, weekendDatesIn, weekendMonths, weekendNeed, weekendNeeds, weekendRunsIn, weekendsOfMonth, weekendsOffBefore } from '../src/modules/weekendRule.ts';
import { CATALOG, limitsFrom, normaliseRule } from '../src/modules/compliance/rules.ts';

const SAT_SUN = [5, 6], FRI_SAT = [4, 5];

describe('the weekends of a month', () => {
  it('lists each Saturday-and-Sunday pair, whole', () => {
    // November 2026 starts on a Sunday: its first Sunday belongs to the weekend that began on Saturday 31 October, so it is not a whole weekend of November
    const w = weekendsOfMonth('2026-11-01', SAT_SUN);
    assert.deepEqual(w.map((x) => x[0]), ['2026-11-07', '2026-11-14', '2026-11-21', '2026-11-28']);
    assert.ok(w.every((x) => x.length === 2));
  });
  it('drops a weekend that straddles two months', () => {
    // 31 January 2026 is a Saturday: that weekend runs into February
    const jan = weekendsOfMonth('2026-01-01', SAT_SUN).map((x) => x[0]);
    assert.ok(!jan.includes('2026-01-31'));
    assert.deepEqual(jan, ['2026-01-03', '2026-01-10', '2026-01-17', '2026-01-24']);
  });
  it('follows the weekend days of the group (Friday and Saturday in the Gulf)', () => {
    const w = weekendsOfMonth('2026-11-01', FRI_SAT);
    assert.deepEqual(w.map((x) => x.join('+')), ['2026-11-06+2026-11-07', '2026-11-13+2026-11-14', '2026-11-20+2026-11-21', '2026-11-27+2026-11-28']);
  });
  it('a single weekend day counts as a weekend of one day', () => {
    assert.equal(weekendsOfMonth('2026-11-01', [6]).length, 5);   // Sundays 1, 8, 15, 22, 29
  });
  it('a weekend that wraps the week (Sunday and Monday) is one weekend', () => {
    const w = weekendsOfMonth('2026-11-01', [6, 0]);
    assert.ok(w.some((x) => x.join('+') === '2026-11-08+2026-11-09'));
    assert.ok(w.every((x) => x.length === 2 || x[0] === '2026-11-01'));
  });
});

describe('the months a schedule touches', () => {
  it('a four-week schedule inside one month holds its weekends', () => {
    const m = weekendMonths('2026-11-02', '2026-11-29', SAT_SUN);
    assert.equal(m.length, 1);
    assert.equal(m[0].key, '2026-11');
    assert.equal(m[0].inPeriod.length, 4);
    assert.equal(m[0].before.length, 0);
    assert.equal(m[0].firstIdx, 0);
    assert.equal(m[0].lastIdx, 27);
  });
  it('a schedule across a month end splits its weekends between the months', () => {
    const m = weekendMonths('2026-11-23', '2026-12-13', SAT_SUN);
    assert.deepEqual(m.map((x) => [x.key, x.inPeriod.length]), [['2026-11', 1], ['2026-12', 2]]);
    const nov = m[0];
    assert.equal(nov.before.length, 3, 'three November weekends came before the schedule');
    assert.equal(nov.lastIdx, 7, 'November ends on the 8th day of the schedule');
  });
  it('a month with no whole weekend in the schedule is left out', () => {
    assert.deepEqual(weekendMonths('2026-11-02', '2026-11-06', SAT_SUN), []);
  });
});

describe('what the schedule has to give', () => {
  const whole = () => weekendMonths('2026-11-02', '2026-11-29', SAT_SUN)[0];
  it('with the whole month inside, it is N of the month\'s weekends', () => {
    assert.equal(weekendNeed(2, whole(), 0), 2);
    assert.equal(weekendNeed(4, whole(), 0), 4);
    assert.equal(weekendNeed(9, whole(), 0), 4, 'never more than the month has');
  });
  it('no rule, no need', () => assert.equal(weekendNeed(0, whole(), 0), 0));
  it('the weekends still to come are assumed off, so a first piece of a month asks for less', () => {
    const [nov] = weekendMonths('2026-11-02', '2026-11-15', SAT_SUN);   // two of November's four weekends
    assert.equal(nov.inPeriod.length, 2);
    assert.equal(weekendNeed(2, nov, 0), 0, 'the two later weekends could be the two off');
    assert.equal(weekendNeed(3, nov, 0), 1);
    assert.equal(weekendNeed(4, nov, 0), 2);
  });
  it('the last piece of a month is held to what is left of the rule', () => {
    const [nov] = weekendMonths('2026-11-16', '2026-11-29', SAT_SUN);   // the last two weekends, two before
    assert.equal(nov.before.length, 2);
    assert.equal(weekendNeed(2, nov, 2), 0, 'two were off already');
    assert.equal(weekendNeed(2, nov, 1), 1);
    assert.equal(weekendNeed(2, nov, 0), 2, 'worked both earlier: both of these must be off');
    assert.equal(weekendNeed(3, nov, 0), 2, 'cannot ask for more than the schedule holds');
  });
  it('counts the earlier weekends that were off', () => {
    const [nov] = weekendMonths('2026-11-16', '2026-11-29', SAT_SUN);
    assert.deepEqual(weekendsOffBefore([nov], new Set(['2026-11-07'])), [1]);
    assert.deepEqual(weekendsOffBefore([nov], new Set(['2026-11-07', '2026-11-15'])), [0]);
    assert.deepEqual(weekendsOffBefore([nov], new Set()), [2]);
  });
  it('gives the engine one need per month, in step with the months it is sent', () => {
    const months = weekendMonths('2026-11-23', '2026-12-13', SAT_SUN);
    assert.equal(weekendNeeds(2, months, [0, 0]).length, 2);
    const sent = engineMonths(months, '2026-11-23');
    assert.deepEqual(sent[0].weekends, [{ days: [5, 6] }]);
    assert.deepEqual(sent[1].weekends.map((w) => w.days), [[12, 13], [19, 20]]);
    assert.equal(sent[1].first_day, 8);
  });
});

describe('a weekends-off request', () => {
  it('covers every weekend that touches the dates, whole', () => {
    assert.deepEqual(weekendDatesIn('2026-11-02', '2026-11-15', SAT_SUN), ['2026-11-07', '2026-11-08', '2026-11-14', '2026-11-15']);
    assert.deepEqual(weekendDatesIn('2026-11-07', '2026-11-07', SAT_SUN), ['2026-11-07', '2026-11-08'], 'a Saturday alone still takes the whole weekend');
  });
  it('is empty when the dates hold no weekend', () => assert.deepEqual(weekendDatesIn('2026-11-02', '2026-11-06', SAT_SUN), []));
  it('lists the weekends as runs', () => {
    assert.deepEqual(weekendRunsIn('2026-11-02', '2026-11-15', SAT_SUN), [['2026-11-07', '2026-11-08'], ['2026-11-14', '2026-11-15']]);
  });
});

describe('the labour-pack rule', () => {
  it('is in the catalogue with a sensible range', () => {
    const spec = CATALOG.find((c) => c.type === 'MIN_WEEKENDS_OFF_MONTH');
    assert.ok(spec);
    assert.deepEqual([spec!.params[0].min, spec!.params[0].max, spec!.params[0].default], [1, 4, 2]);
  });
  it('feeds the generator when it blocks, never when it only warns, and the strictest wins', () => {
    const r = (weekends: number, severity: 'BLOCK' | 'WARN' = 'BLOCK') => normaliseRule({ type: 'MIN_WEEKENDS_OFF_MONTH', params: { weekends }, severity });
    assert.equal(limitsFrom([r(1), r(3)]).minWeekendsOffMonth, 3);
    assert.equal(limitsFrom([r(2, 'WARN')]).minWeekendsOffMonth, undefined);
    assert.equal(limitsFrom([normaliseRule({ type: 'MIN_WEEKENDS_OFF_MONTH', params: { weekends: 9 } })]).minWeekendsOffMonth, 4, 'clamped to the catalogue');
  });
});
