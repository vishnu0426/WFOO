/** Follow-the-sun arithmetic and report timing. Pure functions: no server needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, localMidnightSlot, type GroupSeries } from '../src/modules/sunMath.ts';
import { nextRun, resolveRange } from '../src/modules/reportTime.ts';

const series = (id: string, tz: string, req: [number, number, number][], have: [number, number, number][]): GroupSeries => {
  const r = new Map<number, number>(), h = new Map<number, number>();
  for (const [from, to, n] of req) for (let s = from; s < to; s++) r.set(s, n);
  for (const [from, to, n] of have) for (let s = from; s < to; s++) h.set(s, n);
  return { id, name: id, timezone: tz, required: r, scheduled: h };
};

describe('local days on one clock', () => {
  it('finds local midnight in each zone, including half-hour zones and daylight saving', () => {
    const utc = localMidnightSlot('2027-01-15', 'UTC') * 900;
    assert.equal(localMidnightSlot('2027-01-15', 'Asia/Kolkata') * 900, utc - 5.5 * 3600, 'India is 5h30 ahead, so its midnight is earlier');
    assert.equal(localMidnightSlot('2027-01-15', 'America/New_York') * 900, utc + 5 * 3600, 'New York is 5h behind in winter');
    assert.equal(localMidnightSlot('2027-07-15', 'America/New_York') * 900, Date.parse('2027-07-15T00:00:00Z') / 1000 + 4 * 3600, 'and 4h behind in summer');
  });
});

describe('follow the sun', () => {
  // two sites that between them should cover UTC 00:00-24:00 with 10 people, but each covers 12 hours with a gap of three hours in the middle
  const H = 4;
  const need = 10;
  it('finds the hours the combined need is not met, and says how bad', () => {
    const a = series('A', 'UTC', [[0, 24 * H, need]], [[0, 9 * H, 10]]);          // UTC 00-09
    const b = series('B', 'UTC', [], [[12 * H, 24 * H, 10]]);                       // UTC 12-24
    const r = analyse([a, b]);
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0].from.slice(11, 16), '09:00');
    assert.equal(r.gaps[0].hours, 3);
    assert.equal(r.gaps[0].worstShort, 10);
    assert.equal(r.totals.shortHours, 30);
    assert.equal(r.totals.coveredPercent, 87.5);
  });
  it('shows who covers each hour of the typical day', () => {
    const a = series('A', 'UTC', [[0, 24 * H, need]], [[0, 12 * H, 10]]);
    const b = series('B', 'UTC', [], [[12 * H, 24 * H, 10]]);
    const r = analyse([a, b]);
    assert.equal(r.profile[3].byGroup.A, 10);
    assert.equal(r.profile[3].byGroup.B ?? 0, 0);
    assert.equal(r.profile[15].byGroup.B, 10);
    assert.equal(r.gaps.length, 0, 'the handover is clean');
  });
  it('suggests sliding a site\'s roster to close a gap, and says by how much it helps', () => {
    // B covers 13-24 but the need runs to 24 from 0: A covers 0-12; hour 12-13 is uncovered; moving B one hour earlier closes it
    const a = series('A', 'UTC', [[0, 24 * H, need]], [[0, 12 * H, 10]]);
    const b = series('B', 'UTC', [], [[13 * H, 25 * H, 10]]);
    const r = analyse([a, b], { maxShiftHours: 3 });
    const s = r.suggestions.find((x) => x.groupId === 'B')!;
    assert.equal(s.bestShiftHours, -1);
    assert.equal(s.shortHoursAfter, 0);
    assert.ok(s.improvementPercent > 90);
    assert.equal(r.suggestions.find((x) => x.groupId === 'A')!.bestShiftHours <= 0, true);
  });
  it('suggests nothing when the cover is already right', () => {
    const a = series('A', 'UTC', [[0, 24 * H, need]], [[0, 12 * H, 10]]);
    const b = series('B', 'UTC', [], [[12 * H, 24 * H, 10]]);
    assert.ok(analyse([a, b]).suggestions.every((s) => s.bestShiftHours === 0 && s.improvementPercent === 0));
  });
});

describe('when reports run', () => {
  it('a daily report runs at the local hour, today if it is still ahead and tomorrow if not', () => {
    const t = { frequency: 'DAILY' as const, hour: 7, timezone: 'Asia/Kolkata' };
    const morning = new Date('2027-03-10T00:00:00Z');                   // 05:30 in Kolkata
    assert.equal(nextRun(morning, t).toISOString(), '2027-03-10T01:30:00.000Z', '07:00 in Kolkata is 01:30 UTC');
    const later = new Date('2027-03-10T03:00:00Z');                     // 08:30 in Kolkata, already past 07:00
    assert.equal(nextRun(later, t).toISOString(), '2027-03-11T01:30:00.000Z');
  });
  it('a weekly report runs on its weekday, Monday being 0', () => {
    const r = nextRun(new Date('2027-03-10T12:00:00Z'), { frequency: 'WEEKLY', dayOfWeek: 0, hour: 6, timezone: 'UTC' });   // 10 March 2027 is a Wednesday
    assert.equal(r.toISOString(), '2027-03-15T06:00:00.000Z');
  });
  it('a monthly report on the 31st runs on the last day of a shorter month', () => {
    const r = nextRun(new Date('2027-02-01T00:00:00Z'), { frequency: 'MONTHLY', dayOfMonth: 31, hour: 5, timezone: 'UTC' });
    assert.equal(r.toISOString(), '2027-02-28T05:00:00.000Z');
  });
  it('keeps the local hour across a daylight saving change', () => {
    const r = nextRun(new Date('2027-03-13T15:00:00Z'), { frequency: 'DAILY', hour: 9, timezone: 'America/New_York' });   // 10:00 on the 13th, the day before US clocks change
    assert.equal(r.toISOString(), '2027-03-14T13:00:00.000Z', '09:00 is then UTC-4, not UTC-5');
  });
  it('works out named ranges on the day a report runs, Monday to Sunday', () => {
    const wed = new Date('2027-03-10T12:00:00Z');
    assert.deepEqual(resolveRange('LAST_WEEK', wed, 'UTC'), { from: '2027-03-01', to: '2027-03-07' });
    assert.deepEqual(resolveRange('YESTERDAY', wed, 'UTC'), { from: '2027-03-09', to: '2027-03-09' });
    assert.deepEqual(resolveRange('NEXT_WEEK', wed, 'UTC'), { from: '2027-03-15', to: '2027-03-21' });
    assert.deepEqual(resolveRange('LAST_MONTH', wed, 'UTC'), { from: '2027-02-01', to: '2027-02-28' });
    assert.deepEqual(resolveRange('NEXT_7_DAYS', wed, 'UTC'), { from: '2027-03-11', to: '2027-03-17' });
  });
  it('uses the report\'s time zone to decide what day it is', () => {
    const lateUtc = new Date('2027-03-10T22:00:00Z');                   // already Thursday 11 March in Kolkata
    assert.deepEqual(resolveRange('YESTERDAY', lateUtc, 'Asia/Kolkata'), { from: '2027-03-10', to: '2027-03-10' });
    assert.deepEqual(resolveRange('YESTERDAY', lateUtc, 'UTC'), { from: '2027-03-09', to: '2027-03-09' });
  });
});
