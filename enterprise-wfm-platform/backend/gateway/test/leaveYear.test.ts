/** Leave balances as a year-by-year record: carry-in, carry expiry, hand adjustments and the year-end close. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closeYear, estimatedCarry, expiryDay, leaveBalance } from '../src/modules/leaveYear.ts';

const base = { entitled: 24, mode: 'UPFRONT' as const, asOfMonth: 6, usedThisYear: 0, carriedIn: 0 };

describe('a balance', () => {
  it('is the whole year at once, or one twelfth for each month', () => {
    assert.equal(leaveBalance({ ...base }).remainingDays, 24);
    assert.equal(leaveBalance({ ...base, mode: 'MONTHLY', asOfMonth: 3 }).remainingDays, 6);
    assert.equal(leaveBalance({ ...base, mode: 'MONTHLY', asOfMonth: 12 }).remainingDays, 24);
  });
  it('adds carried-in days and hand adjustments, and takes off what is used', () => {
    const b = leaveBalance({ ...base, carriedIn: 5, adjusted: 2, usedThisYear: 10 });
    assert.equal(b.remainingDays, 21); assert.equal(b.carriedOverDays, 5); assert.equal(b.adjustedDays, 2); assert.equal(b.expiredDays, 0);
  });
  it('never goes below zero', () => {
    assert.equal(leaveBalance({ ...base, usedThisYear: 40 }).remainingDays, 0);
    assert.equal(leaveBalance({ ...base, adjusted: -30 }).remainingDays, 0);
  });
});

describe('carry expiry', () => {
  const exp = '2027-03-31';
  it('keeps carried days until the date passes', () => {
    const b = leaveBalance({ ...base, carriedIn: 5, carryExpiry: exp, asOf: '2027-03-31', usedByExpiry: 0 });
    assert.equal(b.remainingDays, 29); assert.equal(b.expiredDays, 0); assert.equal(b.carryExpiresOn, exp);
  });
  it('lapses the carried days not used by the date, and counts the ones that were', () => {
    const none = leaveBalance({ ...base, carriedIn: 5, carryExpiry: exp, asOf: '2027-04-01', usedByExpiry: 0, usedThisYear: 0 });
    assert.equal(none.expiredDays, 5); assert.equal(none.remainingDays, 24);
    const some = leaveBalance({ ...base, carriedIn: 5, carryExpiry: exp, asOf: '2027-04-01', usedByExpiry: 2, usedThisYear: 2 });
    assert.equal(some.expiredDays, 3); assert.equal(some.remainingDays, 24, 'the 2 used came out of the carried days, so the year is whole');
    const all = leaveBalance({ ...base, carriedIn: 5, carryExpiry: exp, asOf: '2027-04-01', usedByExpiry: 9, usedThisYear: 9 });
    assert.equal(all.expiredDays, 0); assert.equal(all.remainingDays, 20, '5 carried + 24 - 9 used');
  });
  it('no expiry date means carried days never lapse', () => {
    assert.equal(leaveBalance({ ...base, carriedIn: 5, carryExpiry: null, asOf: '2027-12-31' }).remainingDays, 29);
  });
  it('builds the date from a month and day, and refuses nonsense', () => {
    assert.equal(expiryDay(2027, '03-31'), '2027-03-31');
    for (const bad of [undefined, null, '', '3-31', '13-01', '00-10', '03-32', 'March']) assert.equal(expiryDay(2027, bad as any), null);
  });
});

describe('the estimate used before a year is closed', () => {
  it('is last year\'s unused days up to the cap', () => {
    assert.equal(estimatedCarry(24, 20, 10), 4);
    assert.equal(estimatedCarry(24, 0, 10), 10);
    assert.equal(estimatedCarry(24, 30, 10), 0);
  });
});

describe('closing a year', () => {
  const c = { entitled: 24, usedThisYear: 10, carriedIn: 0, adjusted: 0, carryExpiry: null, usedByExpiry: 0, cap: 5 };
  it('carries what is left up to the cap, and the rest lapses', () => {
    const r = closeYear(c);
    assert.equal(r.carriedOut, 5); assert.equal(r.lapsed, 9); assert.equal(r.used, 10);
  });
  it('carries all of it when under the cap, and nothing when the cap is zero', () => {
    assert.deepEqual([closeYear({ ...c, usedThisYear: 22 }).carriedOut, closeYear({ ...c, usedThisYear: 22 }).lapsed], [2, 0]);
    const none = closeYear({ ...c, cap: 0 }); assert.equal(none.carriedOut, 0); assert.equal(none.lapsed, 14);
  });
  it('counts days carried in and adjusted by hand, and lapses carried days not used by the expiry date', () => {
    const r = closeYear({ ...c, carriedIn: 6, adjusted: 1, usedThisYear: 4, carryExpiry: '2026-03-31', usedByExpiry: 4, cap: 30 });
    assert.equal(r.expired, 2, '6 came in, 4 were used before the date, 2 lapse');
    assert.equal(r.carriedOut, 25, '24 + 4 kept carried days + 1 adjusted - 4 used');
    assert.equal(r.lapsed, 0);
  });
  it('a person who used more than they had carries nothing', () => {
    const r = closeYear({ ...c, usedThisYear: 40 }); assert.equal(r.carriedOut, 0); assert.equal(r.lapsed, 0);
  });
  it('the next year starts from the closed record', () => {
    const y1 = closeYear(c);
    const y2 = leaveBalance({ ...base, carriedIn: y1.carriedOut });
    assert.equal(y2.remainingDays, 24 + 5);
  });
});
