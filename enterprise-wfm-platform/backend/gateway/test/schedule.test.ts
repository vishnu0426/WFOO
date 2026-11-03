/** When a pulled connector runs: every N minutes, or at a set time of day, on chosen weekdays, on the organisation's clock. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSchedule, describeSchedule, firstRunAt, maxGapMin, nextRunAfter, zonedToUtc, type Schedule } from '../src/modules/integrations/schedule.ts';

const at = (iso: string) => new Date(iso);
const daily = (time: string, days: number[] | null = null): Schedule => ({ everyMin: 1440, at: time, days });
const every = (n: number, days: number[] | null = null): Schedule => ({ everyMin: n, at: null, days });
const WEEKDAYS = [1, 2, 3, 4, 5];

describe('schedule rules', () => {
  it('accepts the shapes the screen can send', () => {
    assert.equal(checkSchedule(every(15)), null);
    assert.equal(checkSchedule(daily('02:00')), null);
    assert.equal(checkSchedule(daily('23:59', WEEKDAYS)), null);
    assert.equal(checkSchedule(every(5, [6, 7])), null);
  });
  it('refuses what makes no sense, in plain words', () => {
    assert.match(checkSchedule(every(1)) ?? '', /5 minutes/);
    assert.match(checkSchedule(every(2000)) ?? '', /5 minutes/);
    assert.match(checkSchedule(daily('25:00')) ?? '', /02:00/);
    assert.match(checkSchedule(daily('2:00')) ?? '', /02:00/);
    assert.match(checkSchedule({ everyMin: 15, at: '02:00', days: null }) ?? '', /cannot also repeat/);
    assert.match(checkSchedule(every(15, [])) ?? '', /at least one day/);
    assert.match(checkSchedule(every(15, [0])) ?? '', /at least one day/);
    assert.match(checkSchedule(every(15, [1, 1])) ?? '', /at least one day/);
  });
});

describe('time zones', () => {
  it('finds the instant a wall clock reads, for zones ahead of and behind UTC', () => {
    assert.equal(zonedToUtc(2026, 3, 31, 2, 0, 'UTC').toISOString(), '2026-03-31T02:00:00.000Z');
    assert.equal(zonedToUtc(2026, 3, 31, 2, 0, 'Asia/Kolkata').toISOString(), '2026-03-30T20:30:00.000Z');
    assert.equal(zonedToUtc(2026, 1, 15, 2, 0, 'America/New_York').toISOString(), '2026-01-15T07:00:00.000Z');     // winter, UTC-5
    assert.equal(zonedToUtc(2026, 7, 15, 2, 0, 'America/New_York').toISOString(), '2026-07-15T06:00:00.000Z');     // summer, UTC-4
  });
});

describe('next run', () => {
  it('an interval is simply later', () => {
    assert.equal(nextRunAfter(every(15), at('2026-03-31T10:00:00Z'), 'UTC').toISOString(), '2026-03-31T10:15:00.000Z');
  });
  it('a daily run goes to today if its time has not passed, otherwise tomorrow', () => {
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-31T01:00:00Z'), 'UTC').toISOString(), '2026-03-31T02:00:00.000Z');
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-31T02:00:00Z'), 'UTC').toISOString(), '2026-04-01T02:00:00.000Z', 'strictly after');
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-31T09:00:00Z'), 'UTC').toISOString(), '2026-04-01T02:00:00.000Z');
  });
  it('a daily run is on the organisation clock, not UTC', () => {
    // 02:00 in Kolkata is 20:30 UTC the evening before
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-31T10:00:00Z'), 'Asia/Kolkata').toISOString(), '2026-03-31T20:30:00.000Z');
    // ...and at 21:00 UTC it is already 02:30 there the next day, so the next 02:00 is a day later
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-31T21:00:00Z'), 'Asia/Kolkata').toISOString(), '2026-04-01T20:30:00.000Z');
  });
  it('skips days that are not allowed, including over a weekend', () => {
    // Friday 2026-04-03 after 02:00 -> next weekday is Monday 2026-04-06
    assert.equal(nextRunAfter(daily('02:00', WEEKDAYS), at('2026-04-03T09:00:00Z'), 'UTC').toISOString(), '2026-04-06T02:00:00.000Z');
    // a Saturday-only run from Sunday goes six days on
    assert.equal(nextRunAfter(daily('02:00', [6]), at('2026-04-05T09:00:00Z'), 'UTC').toISOString(), '2026-04-11T02:00:00.000Z');
  });
  it('an interval restricted to some days resumes at the start of the next allowed day', () => {
    // Friday 23:55 every 15 minutes on weekdays: the next run would be Saturday, so it waits for Monday 00:00
    assert.equal(nextRunAfter(every(15, WEEKDAYS), at('2026-04-03T23:55:00Z'), 'UTC').toISOString(), '2026-04-06T00:00:00.000Z');
    assert.equal(nextRunAfter(every(15, WEEKDAYS), at('2026-04-03T10:00:00Z'), 'UTC').toISOString(), '2026-04-03T10:15:00.000Z');
  });
  it('keeps the local time across a clock change', () => {
    // New York clocks go forward on 2026-03-08: 02:00 local is 07:00 UTC before and 06:00 UTC after
    assert.equal(nextRunAfter(daily('02:00'), at('2026-03-07T12:00:00Z'), 'America/New_York').toISOString(), '2026-03-08T07:00:00.000Z', 'the night the clocks change, 02:00 does not exist; it lands at the first valid moment');
    assert.equal(nextRunAfter(daily('09:00'), at('2026-03-08T15:00:00Z'), 'America/New_York').toISOString(), '2026-03-09T13:00:00.000Z', 'summer: 09:00 is UTC-4');
    assert.equal(nextRunAfter(daily('09:00'), at('2026-03-07T15:00:00Z'), 'America/New_York').toISOString(), '2026-03-08T13:00:00.000Z');
  });
  it('first run: an interval starts now on an allowed day; a daily run waits for its time', () => {
    assert.equal(firstRunAt(every(15), at('2026-03-31T10:00:00Z'), 'UTC').toISOString(), '2026-03-31T10:00:00.000Z');
    assert.equal(firstRunAt(every(15, WEEKDAYS), at('2026-04-04T10:00:00Z'), 'UTC').toISOString(), '2026-04-06T00:00:00.000Z', 'Saturday waits for Monday');
    assert.equal(firstRunAt(daily('02:00'), at('2026-03-31T10:00:00Z'), 'UTC').toISOString(), '2026-04-01T02:00:00.000Z');
  });
});

describe('quiet stretches and wording', () => {
  it('knows the longest gap the schedule itself leaves', () => {
    assert.equal(maxGapMin(every(15)), 15);
    assert.equal(maxGapMin(daily('02:00')), 1440);
    assert.equal(maxGapMin(daily('02:00', WEEKDAYS)), 3 * 1440, 'Friday to Monday');
    assert.equal(maxGapMin(daily('02:00', [3])), 7 * 1440);
    assert.equal(maxGapMin(every(15, WEEKDAYS)), 3 * 1440);
  });
  it('describes it the way the screen says it', () => {
    assert.equal(describeSchedule(every(15)), 'Every 15 minutes');
    assert.equal(describeSchedule(every(60)), 'Every hour');
    assert.equal(describeSchedule(every(240)), 'Every 4 hours');
    assert.equal(describeSchedule(daily('02:00')), 'Every day at 02:00');
    assert.equal(describeSchedule(daily('02:00', WEEKDAYS), 'Asia/Kolkata'), 'At 02:00 on weekdays (Asia/Kolkata)');
    assert.equal(describeSchedule(every(30, [6, 7])), 'Every 30 minutes on weekends');
    assert.equal(describeSchedule(daily('06:30', [1, 3, 5])), 'At 06:30 on Mon, Wed, Fri');
  });
});
