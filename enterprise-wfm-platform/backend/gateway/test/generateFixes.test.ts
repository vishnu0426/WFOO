import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { crewNote, durationText, forecastFix, niceDay, optionEstimate, optionsNote, overstaffPct, solverHeadline, solveNote, startOnOrAfter, templateLabel, uncoveredFix, type Fc } from '../../../src/services/generateFixes.ts';

const fc = (seq: number, status: string, fromDay: string, toDay: string, kind = 'SHORT'): Fc => ({ id: `f${seq}`, seq, name: `Short-term v${seq}`, status, kind, fromDay, toDay });

describe('the forecast against the dates picked', () => {
  const base = { from: '2026-11-08', weeks: 1, weekStart: 6 };            // a Sunday pay week
  it('is fine when a published short-term forecast covers any of the dates', () => {
    assert.deepEqual(forecastFix({ ...base, forecasts: [fc(1, 'PUBLISHED', '2026-11-01', '2026-11-30')] }), { kind: 'NONE' });
    assert.deepEqual(forecastFix({ ...base, forecasts: [fc(1, 'PUBLISHED', '2026-11-10', '2026-12-30')] }), { kind: 'NONE' }, 'a partial overlap is not a failure');
  });
  it('a forecast that starts later: start on the first pay-week day it covers', () => {
    const f = forecastFix({ ...base, forecasts: [fc(5, 'PUBLISHED', '2027-01-03', '2027-01-30')] });
    assert.equal(f.kind, 'START'); assert.deepEqual([(f as any).startDay, (f as any).label], ['2027-01-03', 'Start on 3 Jan 2027']);
    assert.match((f as any).text, /covers 3 Jan 2027 to 30 Jan 2027, not 8 Nov 2026 to 14 Nov 2026/);
  });
  it('rounds up to the pay week\'s first day when the forecast starts mid-week', () => {
    const f = forecastFix({ ...base, forecasts: [fc(5, 'PUBLISHED', '2027-01-05', '2027-01-30')] }) as any;
    assert.equal(f.startDay, '2027-01-10'); assert.equal(f.label, 'Start on 10 Jan 2027');
  });
  it('a forecast too short to hold a pay-week start: start on its first day', () => assert.equal((forecastFix({ ...base, forecasts: [fc(5, 'PUBLISHED', '2027-01-05', '2027-01-08')] }) as any).startDay, '2027-01-05'));
  it('a forecast that has ended: build one', () => {
    const f = forecastFix({ ...base, forecasts: [fc(2, 'PUBLISHED', '2026-09-01', '2026-09-30')] });
    assert.equal(f.kind, 'BUILD'); assert.match((f as any).text, /ended on 30 Sep 2026/); assert.equal((f as any).label, 'Build a forecast for these dates');
  });
  it('no forecast at all: build one', () => assert.equal(forecastFix({ ...base, forecasts: [] }).kind, 'BUILD'));
  it('a draft that covers the dates beats building a new one, and says what state it is in', () => {
    const f = forecastFix({ ...base, forecasts: [fc(4, 'DRAFT', '2026-11-01', '2026-11-30'), fc(5, 'APPROVED', '2026-11-01', '2026-11-30'), fc(6, 'PUBLISHED', '2027-01-03', '2027-01-30')] }) as any;
    assert.equal(f.kind, 'DRAFT'); assert.equal(f.version.seq, 5); assert.match(f.text, /v5 covers these dates but is approved but not published/); assert.equal(f.label, 'Open forecast v5 to publish it');
  });
  it('ignores archived and long-term forecasts', () => assert.equal(forecastFix({ ...base, forecasts: [fc(1, 'ARCHIVED', '2026-11-01', '2026-11-30'), fc(2, 'PUBLISHED', '2026-11-01', '2026-11-30', 'LONG')] }).kind, 'BUILD'));
  it('counts the weeks asked for', () => assert.equal(forecastFix({ from: '2026-11-01', weeks: 4, weekStart: 6, forecasts: [fc(1, 'PUBLISHED', '2026-11-25', '2026-12-30')] }).kind, 'NONE'));
});

describe('days with no target', () => {
  const pub = fc(5, 'PUBLISHED', '2027-01-03', '2027-01-30');
  it('before the forecast: start where it does', () => assert.deepEqual(uncoveredFix(['2026-12-28', '2026-12-29'], pub, 6), { kind: 'START', startDay: '2027-01-03', label: 'Start on 3 Jan 2027' }));
  it('otherwise a forecast has to be built', () => { assert.equal(uncoveredFix(['2027-02-05'], pub, 6)?.kind, 'BUILD'); assert.equal(uncoveredFix(['2027-02-05'], undefined, 6)?.kind, 'BUILD'); assert.equal(uncoveredFix([], pub, 6), null); });
});

describe('days and weekdays', () => {
  it('names a day', () => assert.equal(niceDay('2027-01-03'), '3 Jan 2027'));
  it('finds the next pay-week start', () => { assert.equal(startOnOrAfter('2027-01-03', 6), '2027-01-03'); assert.equal(startOnOrAfter('2027-01-04', 6), '2027-01-10'); assert.equal(startOnOrAfter('2027-01-04', 0), '2027-01-04'); });
});

describe('template names', () => {
  it('say the start window is when it starts, and the length', () => {
    assert.equal(templateLabel({ name: 'Day shift', earliestStart: '06:00', latestStart: '09:00', durationHours: 8.5 }), 'Day shift · starts 06:00–09:00 · 8.5h');
    assert.equal(templateLabel({ name: 'Night', earliestStart: '22:00', latestStart: '22:00', durationHours: 8 }), 'Night · starts 22:00 · 8h');
  });
});

describe('too many people for the work', () => {
  it('says so, with the crew that would do, when contracts give a quarter or more over the need', () => {
    const n = crewNote({ people: 355, contractHours: 14200, neededHours: 8983 })!;
    assert.equal(n.surplusPct, 37); assert.equal(n.neededPeople, 225); assert.match(n.text, /14,200 h but the forecast needs about 8,983 h/);
  });
  it('stays quiet when the crew is about right, or there is no target', () => {
    assert.equal(crewNote({ people: 100, contractHours: 4000, neededHours: 3500 }), null);
    assert.equal(crewNote({ people: 100, contractHours: 4000, neededHours: 0 }), null);
    assert.equal(crewNote({ people: 0, contractHours: 0, neededHours: 100 }), null);
  });
  it('overstaffing is paid time over the need, in percent', () => { assert.equal(overstaffPct(13030, 8983), 45); assert.equal(overstaffPct(8000, 9000), 0); assert.equal(overstaffPct(100, 0), 0); });
  it('the solver headline does not call a starting roster a good solution', () => {
    assert.equal(solverHeadline('FEASIBLE', true), 'Starting roster only'); assert.equal(solverHeadline('FEASIBLE', false), 'Good solution'); assert.equal(solverHeadline('OPTIMAL', false), 'Best possible');
  });
});

describe('too many shift choices for the optimiser', () => {
  const fixed = (h: number) => ({ earliestStart: String(h).padStart(2, '0') + ':00', latestStart: String(h).padStart(2, '0') + ':00', startStepMinutes: 15, workDays: [0, 1, 2, 3, 4, 5, 6] });
  it('counts people x days x start times', () => {
    assert.equal(optionEstimate({ people: 355, days: 7, templates: Array.from({ length: 12 }, (_, h) => fixed(h)) }), 29820);
    assert.equal(optionEstimate({ people: 10, days: 7, templates: [{ earliestStart: '06:00', latestStart: '09:00', startStepMinutes: 60, workDays: [0, 1, 2, 3, 4] }] }), Math.round(10 * 7 * 4 * 5 / 7));
  });
  it('is quiet where the optimiser was tuned in our tests and speaks where it was not', () => {
    assert.equal(optionsNote(29820), null);
    assert.match(optionsNote(59640)!, /59,640 shift choices.*45,000.*fewer templates or start times/);
  });
});

describe('how long a build takes', () => {
  it('in plain time', () => { assert.equal(durationText(45), '45 seconds'); assert.equal(durationText(80), '1 min 20 s'); assert.equal(durationText(120), '2 minutes'); assert.equal(durationText(400), '7 minutes'); assert.equal(durationText(1), '1 second'); });
  it('says it is the most, and what limits it', () => {
    const t = solveNote({ people: 130, windows: 1, seconds: 80 }, 60);
    assert.match(t, /^Takes up to about 1 min 20 s for 130 people: the search stops at 60 s per four-week window, sooner if it has a good roster/);
  });
});
