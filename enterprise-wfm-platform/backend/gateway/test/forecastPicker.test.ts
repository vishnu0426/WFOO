/** The forecast picker on Generate Schedule: what it lists, what it hides, and the words it uses. Pure logic from the admin app. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accuracyText, autoLine, autoShort, coverText, dayWithWeekday, daysText, forecastChoices, forecastTitle, hasOwnName, longDay, monthDay, periodText, pickerView, sectionOf, shortSpan, statusText, type Fv } from '../../../src/services/liveForecasts.ts';
import { versionAccuracies } from '../src/modules/forecast/accuracyHeadline.ts';

const fv = (seq: number, status: string, fromDay: string, toDay: string, publishedAt: string | null = null, name = `Short-term v${seq} · 2 wk from 16 Nov`): Fv =>
  ({ id: `id${seq}`, seq, name, status, kind: 'SHORT', fromDay, toDay, publishedAt });
// the schedule being planned: 16 to 29 November 2026
const FROM = '2026-11-16', TO = '2026-11-29';
const all: Fv[] = [
  fv(8, 'PUBLISHED', '2026-11-16', '2026-11-29', '2026-11-12T00:00:00Z'),
  fv(6, 'PUBLISHED', '2026-11-16', '2026-12-27', '2026-11-04T00:00:00Z'),
  fv(7, 'DRAFT', '2026-11-16', '2026-11-29'),
  fv(9, 'PUBLISHED', '2026-12-01', '2027-01-04', '2026-11-15T00:00:00Z'),
  fv(5, 'DRAFT', '2026-09-29', '2026-11-09'),
  fv(3, 'ARCHIVED', '2026-11-16', '2026-11-29', '2026-10-01T00:00:00Z'),
];
const choices = (withArchived = false) => forecastChoices({ from: FROM, to: TO, forecasts: all, withArchived });

describe('what the picker lists', () => {
  it('puts published forecasts that reach the dates first, and says which one Automatic follows', () => {
    const v = pickerView(choices(), { showUnapproved: false });
    assert.deepEqual(v.usable.map((c) => c.fv.seq), [8, 6]);
    assert.equal(v.auto?.fv.seq, 8, 'the one published last among those that cover every day');
  });
  it('hides forecasts that are not published yet unless asked, and says how many are hidden', () => {
    const hidden = pickerView(choices(), { showUnapproved: false });
    assert.deepEqual(hidden.unapproved, []);
    assert.equal(hidden.hiddenUnapproved, 1, 'v7 covers the dates but is a draft (v5 does not reach them, so it is not counted here)');
    const shown = pickerView(choices(), { showUnapproved: true });
    assert.deepEqual(shown.unapproved.map((c) => c.fv.seq), [7]);
    assert.equal(shown.hiddenUnapproved, 0);
  });
  it('never hides the forecast that is already chosen', () => {
    const v = pickerView(choices(), { showUnapproved: false, chosenId: 'id7' });
    assert.deepEqual(v.unapproved.map((c) => c.fv.seq), [7]);
  });
  it('tucks away the ones that do not reach the dates too, counts both, and shows them together', () => {
    const tucked = pickerView(choices(), { showUnapproved: false });
    assert.deepEqual(tucked.none, []);
    assert.equal(tucked.hiddenNone, 2, 'v5 and v9 miss the dates');
    assert.equal(tucked.hiddenUnapproved, 1);
    const all = pickerView(choices(), { showUnapproved: true });
    assert.deepEqual(all.none.map((c) => c.fv.seq).sort(), [5, 9]);
    assert.equal(all.hiddenNone + all.hiddenUnapproved, 0);
  });
  it('keeps a chosen forecast visible even when it misses the dates', () => {
    assert.deepEqual(pickerView(choices(), { showUnapproved: false, chosenId: 'id9' }).none.map((c) => c.fv.seq), [9]);
  });
  it('lists archived forecasts only when asked for', () => {
    assert.deepEqual(pickerView(choices(), { showUnapproved: true }).archived, []);
    assert.deepEqual(pickerView(choices(true), { showUnapproved: true }).archived.map((c) => c.fv.seq), [3]);
  });
  it('puts every choice in exactly one place', () => {
    const cs = choices(true);
    assert.deepEqual(cs.map(sectionOf).sort(), ['ARCHIVED', 'NONE', 'NONE', 'UNAPPROVED', 'USABLE', 'USABLE']);
  });
});

describe('the words', () => {
  it('names a forecast by what someone called it, else by its version', () => {
    assert.equal(hasOwnName(all[0]), false);
    assert.equal(forecastTitle(all[0]), 'Forecast v8');
    const named = fv(10, 'PUBLISHED', FROM, TO, null, 'Black Friday plan');
    assert.equal(hasOwnName(named), true);
    assert.equal(forecastTitle(named), 'Black Friday plan');
    assert.equal(hasOwnName(fv(4, 'DRAFT', FROM, TO, null, '')), false, 'an empty name is not a name');
  });
  it('says how much of the dates a forecast covers, once', () => {
    const cs = choices();
    assert.equal(coverText(cs.find((c) => c.fv.seq === 8)!), 'Covers all 14 days');
    assert.equal(coverText(cs.find((c) => c.fv.seq === 5)!), 'Does not reach these dates');
    const part = forecastChoices({ from: '2026-11-16', to: '2026-12-13', forecasts: [fv(1, 'PUBLISHED', '2026-11-16', '2026-11-29')] })[0];
    assert.equal(coverText(part), 'Covers 14 of 28 days');
  });
  it('writes a day as "Nov 16", with its weekday where that matters, and the year only when it is not this one', () => {
    assert.equal(monthDay('2026-11-16', 2026), 'Nov 16');
    assert.equal(monthDay('2027-01-04', 2026), 'Jan 4, 2027');
    assert.equal(dayWithWeekday('2026-11-16', 2026), 'Mon, Nov 16');
    assert.equal(longDay('2026-11-16'), 'Monday, November 16, 2026');
  });
  it('writes a range with an en dash, sharing what it can', () => {
    assert.equal(shortSpan('2026-11-16', '2026-11-22', 2026), 'Nov 16 – 22', 'one month');
    assert.equal(shortSpan('2026-11-28', '2026-12-04', 2026), 'Nov 28 – Dec 4', 'two months');
    assert.equal(shortSpan('2026-12-28', '2027-01-03', 2026), 'Dec 28 – Jan 3, 2027', 'two years');
    assert.equal(shortSpan('2027-01-04', '2027-01-10', 2026), 'Jan 4 – 10, 2027', 'next year');
    assert.equal(shortSpan('2026-11-16', '2026-11-16', 2026), 'Nov 16', 'one day');
    assert.ok(!/ to /.test(shortSpan('2026-11-16', '2026-12-29', 2026)), 'never "to"');
  });
  it('states the schedule period once, with weekdays', () => {
    assert.equal(periodText('2026-11-16', '2026-11-22', 2026), 'Mon, Nov 16 – Sun, Nov 22');
    assert.equal(periodText('2026-12-28', '2027-01-03', 2026), 'Mon, Dec 28 – Sun, Jan 3, 2027');
  });
  it('joins days that follow each other and leaves the rest apart', () => {
    assert.equal(daysText(['2026-12-09', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-01'], 2026), 'Nov 30 – Dec 2, Dec 9');
    assert.equal(daysText(['2026-11-30'], 2026), 'Nov 30');
    assert.equal(daysText([], 2026), '');
  });
  it('says what Automatic will use, or that nothing reaches the dates', () => {
    assert.equal(autoLine(choices(), 2026), 'Uses Forecast v8 · live · covers all 14 days (Nov 16 – 29)');
    assert.equal(autoLine(forecastChoices({ from: FROM, to: TO, forecasts: [all[4]] })), 'No published forecast reaches these dates');
  });
  it('has a short form for the closed field', () => {
    assert.equal(autoShort(choices(), 2026), 'Forecast v8 · Nov 16 – 29');
    assert.equal(autoShort([]), 'No published forecast reaches these dates');
    const named = forecastChoices({ from: FROM, to: TO, forecasts: [fv(10, 'PUBLISHED', FROM, TO, '2026-11-12T00:00:00Z', 'Black Friday plan')] });
    assert.equal(autoShort(named, 2026), 'Black Friday plan (v10) · Nov 16 – 29');
  });
  it('names the state of a forecast', () => {
    assert.deepEqual(['PUBLISHED', 'DRAFT', 'SUBMITTED', 'APPROVED', 'ARCHIVED'].map((status) => statusText({ status })), ['Live', 'Draft', 'Waiting for approval', 'Approved, not published', 'Archived']);
  });
});

describe('how well a forecast has done', () => {
  it('says nothing was measured instead of showing a zero', () => {
    assert.equal(accuracyText(undefined), 'Accuracy: not measured yet');
    assert.equal(accuracyText({ state: 'NONE', days: 0, accuracyPct: null }), 'Accuracy: not measured yet');
  });
  it('gives no percentage from under a week of days: too early to judge', () => {
    assert.equal(accuracyText({ state: 'SPARSE', days: 2, accuracyPct: 85.6 }), 'Too early to judge (2 days so far)');
    assert.equal(accuracyText({ state: 'SPARSE', days: 1, accuracyPct: 90 }), 'Too early to judge (1 day so far)');
    assert.equal(accuracyText({ state: 'SPARSE', days: 6, accuracyPct: 90 }), 'Too early to judge (6 days so far)');
  });
  it('shows the figure from a week, as an early reading until two weeks have passed', () => {
    assert.equal(accuracyText({ state: 'SPARSE', days: 7, accuracyPct: 94.2 }), 'Early reading: 94.2% over 7 days');
    assert.equal(accuracyText({ state: 'OK', days: 28, accuracyPct: 91.3 }), '91.3% accurate over 28 days');
  });
});

describe('accuracy per forecast version (same definition as the headline)', () => {
  const row = (versionId: string, day: string, forecast: number, actual: number, queueId = 'q1') => ({ versionId, queueId, day, forecast, actual });
  it('is 100% minus the summed miss as a share of real volume, per version', () => {
    const m = versionAccuracies([row('a', '2026-11-01', 90, 100), row('a', '2026-11-02', 110, 100), row('b', '2026-11-01', 100, 100)]);
    assert.equal(m.get('a')!.accuracyPct, 90, '(10 + 10) / 200 = 10% miss');
    assert.equal(m.get('b')!.accuracyPct, 100);
    assert.equal(m.get('a')!.days, 2);
  });
  it('is an early reading under two weeks of days, and settled from two weeks', () => {
    const days = (n: number) => Array.from({ length: n }, (_, i) => row('a', `2026-11-${String(i + 1).padStart(2, '0')}`, 100, 100));
    assert.equal(versionAccuracies(days(5)).get('a')!.state, 'SPARSE');
    assert.equal(versionAccuracies(days(14)).get('a')!.state, 'OK');
  });
  it('counts a day once however many queues it has, and leaves out a forecast of zero', () => {
    const m = versionAccuracies([row('a', '2026-11-01', 50, 50, 'q1'), row('a', '2026-11-01', 50, 50, 'q2'), row('c', '2026-11-01', 0, 10)]);
    assert.equal(m.get('a')!.days, 1);
    assert.equal(m.has('c'), false);
  });
  it('has no entry at all for a version with nothing to compare', () => {
    assert.equal(versionAccuracies([]).size, 0);
  });
});

describe('a forecast\'s note', () => {
  it('uses the same date style as the rest of the page, never "to" between dates', () => {
    const part = forecastChoices({ from: '2026-11-16', to: '2026-12-13', forecasts: [fv(1, 'PUBLISHED', '2026-11-16', '2026-11-29')] })[0];
    assert.match(part.note, /Covers 14 of 28 days \(Nov 16 – 29\) · live/);
    const none = forecastChoices({ from: '2026-12-01', to: '2026-12-07', forecasts: [fv(2, 'DRAFT', '2026-09-29', '2026-11-09')] })[0];
    assert.match(none.note, /Does not cover these dates \(Sep 29 – Nov 9\) · draft/);
  });
});
