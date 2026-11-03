/** Daylight saving: which days the clocks change on, and how far a shift that runs over the change is from the hours it is scheduled for. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clockChangeOn, clockChanges, shiftDelta } from '../src/modules/clockChange.ts';

const NY = 'America/New_York';
const night = (day: string, tz: string) => shiftDelta(day, 88, 32, tz);   // 22:00, 8 hours

describe('the day the clocks change', () => {
  it('finds a spring-forward and a fall-back, and the time they happen', () => {
    assert.deepEqual(clockChangeOn('2027-03-14', NY), { day: '2027-03-14', deltaMinutes: -60, atWall: '02:00', kind: 'FORWARD' });
    assert.deepEqual(clockChangeOn('2027-11-07', NY), { day: '2027-11-07', deltaMinutes: 60, atWall: '02:00', kind: 'BACK' });
    assert.equal(clockChangeOn('2027-03-13', NY), null); assert.equal(clockChangeOn('2027-03-15', NY), null);
  });
  it('knows each part of the world changes on its own day, and some never do', () => {
    assert.equal(clockChangeOn('2027-03-28', 'Europe/London')?.kind, 'FORWARD');
    assert.equal(clockChangeOn('2027-03-14', 'Europe/London'), null, 'the week the US changes, Britain has not yet');
    assert.equal(clockChangeOn('2027-10-03', 'Australia/Sydney')?.kind, 'FORWARD', 'the southern summer starts in October');
    assert.equal(clockChanges(Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10)), 'Asia/Kolkata').length, 0);
    assert.equal(clockChanges(Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10)), NY).length, 2);
  });
  it('handles a zone that moves by half an hour', () => {
    const c = clockChanges(Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10)), 'Australia/Lord_Howe');
    assert.equal(c.length, 2); assert.ok(c.every((x) => Math.abs(x.deltaMinutes) === 30), JSON.stringify(c));
  });
});

describe('a shift over the change', () => {
  it('is an hour shorter than scheduled when the clocks go forward, and an hour longer when they go back', () => {
    const fwd = night('2027-03-13', NY);                       // 22:00 Saturday to 06:00 Sunday, over the jump at 02:00
    assert.equal(fwd.scheduledSlots, 32); assert.equal(fwd.elapsedSlots, 28); assert.equal(fwd.deltaMinutes, -60);
    const back = night('2027-11-06', NY);
    assert.equal(back.elapsedSlots, 36); assert.equal(back.deltaMinutes, 60);
  });
  it('is exactly as scheduled when it does not span the change, whatever the day', () => {
    assert.equal(shiftDelta('2027-03-14', 32, 32, NY).deltaMinutes, 0, '08:00 to 16:00 on the day itself starts after the change');
    assert.equal(night('2027-03-12', NY).deltaMinutes, 0); assert.equal(night('2027-03-14', NY).deltaMinutes, 0);
    assert.equal(night('2027-03-13', 'Asia/Kolkata').deltaMinutes, 0);
    assert.equal(night('2027-03-13', 'UTC').deltaMinutes, 0);
  });
  it('is shorter by half an hour in a half-hour zone, and a shift that starts after the jump is not affected', () => {
    const lh = clockChanges(Array.from({ length: 365 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10)), 'Australia/Lord_Howe').find((x) => x.kind === 'FORWARD')!;
    const prev = new Date(Date.UTC(+lh.day.slice(0, 4), +lh.day.slice(5, 7) - 1, +lh.day.slice(8, 10) - 1)).toISOString().slice(0, 10);
    assert.equal(night(prev, 'Australia/Lord_Howe').deltaMinutes, -30);
  });
  it('a day shift that ends before the change on the day it happens is unaffected, one that starts at 01:00 is', () => {
    assert.equal(shiftDelta('2027-03-14', 4, 32, NY).deltaMinutes, -60, '01:00 to 09:00 jumps over 02:00');
    assert.equal(shiftDelta('2027-03-14', 4, 4, NY).deltaMinutes, 0, '01:00 to 02:00 ends as the clocks jump: nothing is skipped');
  });
});
