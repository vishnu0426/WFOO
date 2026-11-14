import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyFrom, accuracyLine, compareLine, describe as describeSchedule, freshness, horizonFor, isDue, nextRun, notification, type Report } from '../src/modules/forecast/refreshMath.ts';

const weekly = { enabled: true, frequency: 'WEEKLY' as const, dayOfWeek: 0, hour: 6, lastRunDay: null as string | null };
const now = (day: string, dow: number, hour: number) => ({ day, dow, hour });

describe('when a schedule is due', () => {
  it('weekly: on its weekday once its hour has come, not before, not on other days', () => {
    assert.equal(isDue(weekly, now('2026-11-09', 0, 6)), true);
    assert.equal(isDue(weekly, now('2026-11-09', 0, 5)), false, 'the hour has not come');
    assert.equal(isDue(weekly, now('2026-11-09', 0, 23)), true, 'still due later the same day if it was missed');
    assert.equal(isDue(weekly, now('2026-11-10', 1, 9)), false, 'wrong weekday');
  });
  it('only once per occasion', () => {
    assert.equal(isDue({ ...weekly, lastRunDay: '2026-11-09' }, now('2026-11-09', 0, 8)), false);
    assert.equal(isDue({ ...weekly, lastRunDay: '2026-11-02' }, now('2026-11-09', 0, 8)), true, 'last week\'s run does not count');
  });
  it('daily: every day at its hour', () => {
    const d = { ...weekly, frequency: 'DAILY' as const };
    assert.equal(isDue(d, now('2026-11-12', 3, 6)), true); assert.equal(isDue(d, now('2026-11-12', 3, 5)), false);
  });
  it('never when it is switched off', () => assert.equal(isDue({ ...weekly, enabled: false }, now('2026-11-09', 0, 12)), false));
});

describe('when it runs next', () => {
  it('says today, tomorrow or the weekday', () => {
    assert.equal(nextRun(weekly, now('2026-11-09', 0, 3))!.text, 'today at 06:00');
    assert.equal(nextRun(weekly, now('2026-11-09', 0, 9))!.text, 'now (it is due)');
    assert.equal(nextRun({ ...weekly, lastRunDay: '2026-11-09' }, now('2026-11-09', 0, 9))!.text, 'Monday at 06:00');
    assert.equal(nextRun({ ...weekly, dayOfWeek: 3 }, now('2026-11-09', 0, 9))!.text, 'Thursday at 06:00');
    assert.equal(nextRun({ ...weekly, frequency: 'DAILY', lastRunDay: '2026-11-09' }, now('2026-11-09', 0, 9))!.text, 'tomorrow at 06:00');
    assert.equal(nextRun({ ...weekly, enabled: false }, now('2026-11-09', 0, 9)), null);
  });
  it('describes the schedule', () => {
    assert.equal(describeSchedule({ frequency: 'WEEKLY', dayOfWeek: 0, hour: 6 }), 'every Monday at 06:00');
    assert.equal(describeSchedule({ frequency: 'DAILY', dayOfWeek: 0, hour: 22 }), 'every day at 22:00');
  });
});

describe('is the data fresh enough', () => {
  it('yesterday is fine, within the limit is fine, beyond it is not', () => {
    assert.equal(freshness('2026-11-11', '2026-11-12', 3).ok, true);
    assert.match(freshness('2026-11-11', '2026-11-12', 3).text, /up to date/);
    assert.equal(freshness('2026-11-09', '2026-11-12', 3).ok, true, 'exactly at the limit');
    const old = freshness('2026-10-31', '2026-11-12', 3);
    assert.equal(old.ok, false); assert.equal(old.ageDays, 12); assert.match(old.text, /12 days old.*more than the 3 allowed.*data feed/);
  });
  it('no history at all is not fresh', () => { const f = freshness(null, '2026-11-12', 3); assert.equal(f.ok, false); assert.match(f.text, /no interval history/); });
});

describe('the report in words', () => {
  const acc = (over: any = {}) => ({ status: 'GOOD' as const, direction: 'STEADY' as const, message: '', latestWeek: { weekStart: '2026-11-02', days: 7, wapeDaily: 0.054, bias: 0.031 }, queues: [], ...over });
  it('says how the live forecast did, with the lean and how it compares with before', () => {
    assert.equal(accuracyLine(acc(), null), 'The live forecast missed by 5.4% a day last week (good), running 3.1% high.');
    assert.match(accuracyLine(acc(), 0.081), /better than the 8.1% before/);
    assert.match(accuracyLine(acc({ status: 'POOR', latestWeek: { weekStart: 'x', days: 6, wapeDaily: 0.2, bias: -0.1 } }), 0.05), /20% a day last week \(poor\), running 10% low, worse than the 5% before/);
    assert.match(accuracyLine(acc({ latestWeek: { weekStart: 'x', days: 7, wapeDaily: 0.05, bias: 0.005 } }), null), /no real lean either way/);
    assert.match(accuracyLine(null, null), /not enough finished data/);
    assert.match(accuracyLine(acc({ latestWeek: null }), null), /not enough finished data/);
  });
  it('says how the new draft differs from the live one', () => {
    const c = { baseVersion: 'v3', days: 28, volumeBase: 100000, volumeNew: 103100, deltaPct: 3.1, biggest: { day: '2026-12-24', delta: 410, deltaPct: 9 }, peakRequiredBase: 30, peakRequiredNew: 31 };
    assert.equal(compareLine(c), 'Over the 28 days it shares with v3, the new draft is +3.1% higher (+3,100 contacts). Biggest difference: 2026-12-24 (+410 contacts).');
    assert.match(compareLine({ ...c, volumeNew: 98000, deltaPct: -2, biggest: null }), /−2% lower \(−2,000 contacts\)\.$/);
    assert.match(compareLine({ ...c, deltaPct: 0, volumeNew: 100000 }), /same volume/);
    assert.match(compareLine(null), /no live forecast/); assert.match(compareLine({ ...c, days: 0, deltaPct: null }), /share no days/);
  });
});

describe('what people are told', () => {
  const report: Report = { freshness: freshness('2026-11-11', '2026-11-12', 3), live: { id: 'a', seq: 3, name: 'x' }, accuracy: null, previousWape: null, draft: null, compare: null, archivedDrafts: 0, notified: 0 };
  it('a new draft: the headline and what to do next', () => {
    const n = notification({ group: 'Sales', kind: 'SHORT', status: 'CREATED', reason: '', report });
    assert.equal(n.title, 'Sales: new short-term forecast draft is ready'); assert.match(n.body, /Review it under Forecasts, then submit it for approval\.$/);
  });
  it('a skipped run says why and that nothing changed', () => {
    const n = notification({ group: 'Sales', kind: 'LONG', status: 'SKIPPED', reason: 'The newest history is 12 days old, which is more than the 3 allowed. Check the data feed.', report });
    assert.equal(n.title, 'Sales: long-term forecast not refreshed'); assert.match(n.body, /live forecast is unchanged/);
  });
  it('a failed run says so and how to try again', () => assert.match(notification({ group: 'Sales', kind: 'SHORT', status: 'FAILED', reason: 'The engine did not answer.', report }).body, /run it again from Forecasts/));
});

describe('the pieces', () => {
  it('takes the accuracy out of a trend, worst queues first', () => {
    const a = accuracyFrom({ total: { status: 'CHECK', direction: 'WORSENING', message: 'm', latest: { weekStart: '2026-11-02', days: 7, wapeDaily: 0.1, bias: 0.02 } },
      queues: [{ name: 'A', status: 'GOOD', latest: { wapeDaily: 0.04, bias: 0 } }, { name: 'B', status: 'POOR', latest: { wapeDaily: 0.2, bias: 0.1 } }, { name: 'C', status: 'NO_DATA', latest: null }] })!;
    assert.deepEqual(a.queues.map((q) => q.name), ['B', 'A']); assert.equal(a.status, 'CHECK'); assert.equal(accuracyFrom(null), null);
  });
  it('the new forecast is as long as the live one unless told otherwise', () => {
    const live = { fromDay: '2026-11-09', toDay: '2026-12-20' };           // 42 days
    assert.deepEqual(horizonFor('SHORT', { horizonWeeks: null, horizonDays: null }, live), { weeks: 6 });
    assert.deepEqual(horizonFor('SHORT', { horizonWeeks: 12, horizonDays: null }, live), { weeks: 12 });
    assert.deepEqual(horizonFor('SHORT', { horizonWeeks: null, horizonDays: null }, null), { weeks: 6 });
    assert.deepEqual(horizonFor('LONG', { horizonWeeks: null, horizonDays: null }, null), { days: 365 });
    assert.deepEqual(horizonFor('LONG', { horizonWeeks: null, horizonDays: null }, { fromDay: '2026-01-01', toDay: '2027-12-31' }), { days: 730 });
  });
});
