/** Every kind of pay week: it can start on any weekday, and a year can hold 52, 53 or 54 of them. The calendar maths must agree everywhere. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { payWeekFloor, weekdayOf } from '../src/modules/payWeek.ts';
import { resolveRange } from '../src/modules/reportTime.ts';

const add = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

describe('the first day of a pay week', () => {
  it('lands on the chosen weekday and never more than six days back, for every start and every day of a leap year', () => {
    for (let ws = 0; ws < 7; ws++) {
      for (let i = 0; i < 366; i++) {
        const day = add('2028-01-01', i), f = payWeekFloor(day, ws);
        assert.equal(weekdayOf(f), ws, `${day} with a ${NAMES[ws]} pay week gave ${f}`);
        const back = (Date.parse(day) - Date.parse(f)) / 86_400_000;
        assert.ok(back >= 0 && back <= 6, `${day} is ${back} days after ${f}`);
      }
    }
  });
  it('is the day itself on the first day of the week, and the same for the whole week', () => {
    for (let ws = 0; ws < 7; ws++) {
      const start = payWeekFloor('2027-03-10', ws);
      for (let k = 0; k < 7; k++) assert.equal(payWeekFloor(add(start, k), ws), start);
      assert.equal(payWeekFloor(add(start, 7), ws), add(start, 7));
    }
  });
  it('counts 52, 53 or 54 pay weeks in a year, and every day belongs to exactly one', () => {
    for (const year of [2026, 2027, 2028, 2032]) {            // 2026 and 2032 are the 53-week years of the ISO calendar
      for (let ws = 0; ws < 7; ws++) {
        const weeks = new Set<string>();
        for (let i = 0; i < (year % 4 === 0 ? 366 : 365); i++) weeks.add(payWeekFloor(add(`${year}-01-01`, i), ws));
        assert.ok(weeks.size >= 52 && weeks.size <= 54, `${year}, ${NAMES[ws]} weeks: ${weeks.size}`);
      }
    }
    const iso2026 = new Set<string>(); for (let i = 0; i < 365; i++) iso2026.add(payWeekFloor(add('2026-01-01', i), 0));
    assert.equal(iso2026.size, 53, '2026 touches 53 Monday weeks (it starts on a Thursday and ends on one)');
  });
  it('crosses a year end and a leap day the right way', () => {
    assert.equal(payWeekFloor('2027-01-01', 0), '2026-12-28');
    assert.equal(payWeekFloor('2027-01-01', 6), '2026-12-27');
    assert.equal(payWeekFloor('2028-03-01', 3), '2028-02-24');   // a Thursday week across 29 February
  });
});

describe('report weeks follow the pay week', () => {
  const wed = new Date('2027-03-10T12:00:00Z');                 // a Wednesday
  it('last week, this week and next week are whole pay weeks for every start day', () => {
    for (let ws = 0; ws < 7; ws++) {
      const last = resolveRange('LAST_WEEK', wed, 'UTC', ws), cur = resolveRange('THIS_WEEK', wed, 'UTC', ws), next = resolveRange('NEXT_WEEK', wed, 'UTC', ws);
      for (const r of [last, cur, next]) { assert.equal(weekdayOf(r.from), ws, NAMES[ws]); assert.equal(add(r.from, 6), r.to); }
      assert.equal(add(last.to, 1), cur.from); assert.equal(add(cur.to, 1), next.from);
      assert.ok(cur.from <= '2027-03-10' && '2027-03-10' <= cur.to);
    }
  });
  it('is Monday to Sunday when no pay week is given', () => {
    assert.deepEqual(resolveRange('LAST_WEEK', wed, 'UTC'), { from: '2027-03-01', to: '2027-03-07' });
  });
  it('uses the report time zone for the day it runs, so a Sunday-start week turns over at local midnight', () => {
    const lateSat = new Date('2027-03-13T20:00:00Z');           // Saturday 20:00 UTC = Sunday 01:30 in Kolkata
    assert.equal(resolveRange('THIS_WEEK', lateSat, 'UTC', 6).from, '2027-03-07');
    assert.equal(resolveRange('THIS_WEEK', lateSat, 'Asia/Kolkata', 6).from, '2027-03-14');
  });
});
