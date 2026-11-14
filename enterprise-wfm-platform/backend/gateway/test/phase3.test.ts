/**
 * Enterprise scheduling rules that need no database: time zones and clock changes, schedule review, and the impact of publishing. Run with:  npx tsx --test test/phase3.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertShift, restAdjust, shiftDelta } from '../src/modules/clockChange.ts';
import { approvalOf, approvalProblem, diffShifts } from '../src/modules/scheduleReview.ts';

describe('a shift seen from another time zone', () => {
  it('is the same when both groups share a zone', () => {
    assert.deepEqual(convertShift('2026-03-02', 36, 32, 'Europe/London', 'Europe/London'), { day: '2026-03-02', startSlot: 36, lengthSlots: 32 });
  });
  it('moves to the other zone clock: 09:00-17:00 in London is 17:00-01:00 in Manila', () => {
    const r = convertShift('2026-01-12', 36, 32, 'Europe/London', 'Asia/Manila');
    assert.deepEqual(r, { day: '2026-01-12', startSlot: 68, lengthSlots: 32 });          // 17:00 Manila (UTC+8), 8 hours
  });
  it('can land on the day before', () => {
    const r = convertShift('2026-01-12', 4, 32, 'Asia/Manila', 'America/New_York');       // 01:00 Manila = 12:00 the day before in New York
    assert.equal(r.day, '2026-01-11');
    assert.equal(r.startSlot, 48);
  });
  it('keeps the real elapsed length over a clock change', () => {
    // the night of 2026-03-29 in London the clocks go forward at 01:00: 00:00-08:00 is 8 scheduled hours but 7 worked
    const real = shiftDelta('2026-03-29', 0, 32, 'Europe/London');
    assert.equal(real.elapsedSlots, 28);
    const other = convertShift('2026-03-29', 0, 32, 'Europe/London', 'UTC');
    assert.equal(other.lengthSlots, 28);
  });
  it('half-hour zones work', () => {
    const r = convertShift('2026-01-12', 36, 8, 'UTC', 'Asia/Kolkata');                    // 09:00 UTC = 14:30 IST
    assert.equal(r.startSlot, 58);
  });
});

describe('rest across a clock change', () => {
  it('asks for an hour more on the wall clock where the clocks go forward, an hour less where they go back, and nothing on other days', () => {
    const days = ['2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30'];
    assert.deepEqual(restAdjust(days, 'Europe/London'), [0, 0, 4, 0]);
    assert.deepEqual(restAdjust(['2026-10-24', '2026-10-25', '2026-10-26'], 'Europe/London'), [0, -4, 0]);
    assert.deepEqual(restAdjust(days, 'Asia/Kolkata'), [0, 0, 0, 0]);                       // no daylight saving
    assert.deepEqual(restAdjust(['2026-04-04', '2026-04-05'], 'Australia/Sydney'), [0, -4]); // autumn there: back on 5 April
  });
});

describe('schedule review', () => {
  const draft = (over: object) => ({ status: 'DRAFT', rev: 3, approvalState: 'NONE', ...over });
  it('a draft counts as submitted only while it is the revision that was submitted', () => {
    assert.equal(approvalOf(draft({ approvalState: 'SUBMITTED', submittedRev: 3 })).state, 'SUBMITTED');
    const edited = approvalOf(draft({ approvalState: 'SUBMITTED', submittedRev: 2 }));
    assert.equal(edited.state, 'NONE');
    assert.equal(edited.changedSince, true);
  });
  it('an approval is lost when the schedule is edited afterwards', () => {
    assert.equal(approvalOf(draft({ approvalState: 'APPROVED', approvedRev: 3 })).state, 'APPROVED');
    assert.equal(approvalOf(draft({ approvalState: 'APPROVED', approvedRev: 1 })).state, 'NONE');
  });
  it('publishing is blocked until approval when it is required, and free when it is not', () => {
    assert.equal(approvalProblem(draft({}), false), null);
    assert.match(approvalProblem(draft({}), true)!, /needs approval/);
    assert.match(approvalProblem(draft({ approvalState: 'SUBMITTED', submittedRev: 3 }), true)!, /waiting for approval/);
    assert.match(approvalProblem(draft({ approvalState: 'APPROVED', approvedRev: 2 }), true)!, /changed after it was reviewed/);
    assert.equal(approvalProblem(draft({ approvalState: 'APPROVED', approvedRev: 3 }), true), null);
  });
});

describe('what publishing changes for each person', () => {
  const now = Date.parse('2026-06-10T08:00:00Z');
  const row = (employeeId: string, day: string, startSlot: number, lengthSlots = 32) => ({ employeeId, day, startSlot, lengthSlots });
  it('finds added, removed and moved shifts, and leaves identical ones out', () => {
    const before = [row('a', '2026-06-20', 36), row('a', '2026-06-21', 36), row('b', '2026-06-20', 36), row('c', '2026-06-22', 36)];
    const after = [row('a', '2026-06-20', 36), row('a', '2026-06-21', 52), row('b', '2026-06-20', 36), row('d', '2026-06-22', 36, 16)];
    const { people, unchanged } = diffShifts(before, after, '2026-06-10', 48, 'UTC', now);
    assert.equal(unchanged, 2);
    assert.equal(people.get('a')!.changed, 1);
    assert.equal(people.get('a')!.hoursDelta, 0);
    assert.equal(people.get('c')!.removed, 1);
    assert.equal(people.get('c')!.hoursDelta, -8);
    assert.equal(people.get('d')!.added, 1);
    assert.equal(people.get('d')!.hoursDelta, 4);
    assert.equal(people.has('b'), false);
  });
  it('ignores days that are already over', () => {
    const { people } = diffShifts([row('a', '2026-06-01', 36)], [row('a', '2026-06-01', 52)], '2026-06-10', 48, 'UTC', now);
    assert.equal(people.size, 0);
  });
  it('flags a change with less notice than the minimum, using the earlier of the old and new start', () => {
    const near = diffShifts([row('a', '2026-06-11', 60)], [row('a', '2026-06-11', 36)], '2026-06-10', 48, 'UTC', now);    // new start 09:00 tomorrow: 25 hours away
    assert.equal(near.people.get('a')!.shortNotice, 1);
    const far = diffShifts([row('a', '2026-06-14', 60)], [row('a', '2026-06-14', 36)], '2026-06-10', 48, 'UTC', now);
    assert.equal(far.people.get('a')!.shortNotice, 0);
    const zero = diffShifts([row('a', '2026-06-11', 60)], [row('a', '2026-06-11', 36)], '2026-06-10', 0, 'UTC', now);
    assert.equal(zero.people.get('a')!.shortNotice, 0);
  });
  it('judges notice on the group own clock', () => {
    // 09:00 on 2026-06-12 in Manila is 01:00 UTC; from 2026-06-10 08:00 UTC that is 41 hours away, inside 48
    const manila = diffShifts([], [row('a', '2026-06-12', 36)], '2026-06-10', 48, 'Asia/Manila', now);
    assert.equal(manila.people.get('a')!.shortNotice, 1);
    const utc = diffShifts([], [row('a', '2026-06-12', 36)], '2026-06-10', 48, 'UTC', now);                                  // 09:00 UTC is 49 hours away
    assert.equal(utc.people.get('a')!.shortNotice, 0);
  });
});

describe('coverage of an overnight shift from the day before', () => {
  it('lands on the first hours of the period, less its meal, and never before the start', async () => {
    const { addShiftCoverage } = await import('../src/modules/shiftCoverage.ts');
    const cover = new Array(96).fill(0);
    // 22:00 to 06:00 (starts at slot 88, 32 slots), meal 00:15-00:45 (slots 97-99 of its own day)
    addShiftCoverage(cover, -1, { startSlot: 88, lengthSlots: 32, activities: [{ type: 'MEAL', startSlot: 97, slots: 3 }] });
    assert.equal(cover.slice(0, 24).reduce((a, b) => a + b, 0), 24 - 3);
    assert.deepEqual(cover.slice(1, 4), [0, 0, 0]);
    assert.equal(cover[0], 1);
    assert.equal(cover[24], 0);
    assert.equal(Object.keys(cover).length, 96, 'nothing was written outside the period');
  });
});
