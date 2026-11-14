import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { activeSection, adjustmentSentence, createBlockers, dragSpan, eventsOnDay, findingsText, footerNote, statusLine, verdictFor, goalSentence, monthWeeks, occupancySentence, pickRange, shrinkageSentence, slotTime, summarizeFindings, timeSlot } from '../../../src/services/forecastForm.ts';

describe('the data check summary', () => {
  const q = (...s: ('INFO' | 'WARNING' | 'CRITICAL')[]) => ({ findings: s.map((severity) => ({ severity })) });
  it('counts cautions and tips apart: a tip never inflates the count', () => {
    const s = summarizeFindings([q(), q('WARNING'), q('INFO', 'CRITICAL')]);
    assert.deepEqual([s.total, s.cautions, s.tips, s.blocks, s.worst, s.queuesWithFindings], [2, 2, 1, 0, 'CRITICAL', 2]);
    assert.equal(findingsText(s), '2 cautions · 1 tip');
    assert.equal(findingsText(summarizeFindings([q('INFO')])), '1 tip');
    assert.equal(summarizeFindings([q('INFO')]).total, 0, 'a tip alone is not something to fix');
    assert.equal(findingsText(summarizeFindings([q(), q()])), 'Nothing to fix in the history');
    assert.equal(summarizeFindings([]).worst, null);
  });
  it('a missing history is blocking, not just serious', () => {
    const s = summarizeFindings([{ findings: [{ severity: 'CRITICAL' as const, code: 'NO_HISTORY' }] }]);
    assert.deepEqual([s.blocks, s.cautions, s.total], [1, 0, 1]); assert.equal(findingsText(s), '1 blocking problem');
  });
  it('the footer says nothing for tips, that you can still create for cautions, and what blocks otherwise', () => {
    assert.equal(footerNote(summarizeFindings([q('INFO')])), null);
    assert.deepEqual(footerNote(summarizeFindings([q('WARNING', 'INFO')])), { text: 'History check: 1 caution. You can still create the forecast; it will be less accurate', tone: 'warn' });
    assert.equal(footerNote(summarizeFindings([{ findings: [{ severity: 'CRITICAL' as const, code: 'NO_HISTORY' }] }]))!.tone, 'bad');
  });
});

describe('the verdict', () => {
  const stale = { severity: 'CRITICAL' as const, kind: 'CAUTION' as const, title: 'Newest data is 12 days old' };
  const tip = { severity: 'INFO' as const, kind: 'TIP' as const, title: 'Borrowed pattern no longer needed' };
  it('is ready when there is nothing, and still ready when there are only tips', () => {
    assert.deepEqual(verdictFor([{ name: 'A', findings: [] }]), { level: 'READY', label: 'Ready', text: 'The history is fit to forecast from.' });
    assert.equal(verdictFor([{ name: 'A', findings: [tip] }]).level, 'READY');
  });
  it('is a caution (amber, not red) for old data, and says what will be less accurate', () => {
    const v = verdictFor([{ name: 'Support Voice', findings: [stale, tip] }]);
    assert.equal(v.level, 'CAUTION'); assert.equal(v.label, 'Ready, with a caution');
    assert.equal(v.text, 'You can create this forecast. One thing will make it less accurate: newest data is 12 days old.');
  });
  it('names the queue when there are several, and lists at most three', () => {
    const v = verdictFor([{ name: 'A', findings: [stale] }, { name: 'B', findings: [stale, stale, stale] }]);
    assert.equal(v.label, 'Ready, with cautions'); assert.match(v.text, /A: newest data is 12 days old; B: newest/); assert.match(v.text, /and 1 more.$/);
  });
  it('reassures about what is repaired automatically', () => assert.match(verdictFor([{ name: 'A', repairedDays: 3, findings: [] }]).text, /3 odd days will be repaired automatically.$/));
  it('is blocked only when a queue has no history at all', () => {
    const v = verdictFor([{ name: 'Sales', findings: [{ severity: 'CRITICAL', code: 'NO_HISTORY' }] }, { name: 'Billing', findings: [] }]);
    assert.deepEqual(v, { level: 'BLOCKED', label: "Can't forecast yet", text: 'Sales has no history. Import it first.' });
  });
  it('says length and freshness as two facts', () => {
    assert.equal(statusLine({ name: 'A', findings: [], length: { level: 'GOOD', days: 56 }, freshness: { level: 'BEHIND', daysBehind: 12 } }), 'History length: good (56 days) · Freshness: 12 days behind');
    assert.equal(statusLine({ name: 'A', findings: [], length: { level: 'LOW', days: 20 }, freshness: { level: 'CURRENT', daysBehind: 1 } }), 'History length: too short (20 days) · Freshness: current');
    assert.equal(statusLine({ name: 'A', findings: [] }), 'History length: none · Freshness: no data');
  });
});

describe('goals as sentences', () => {
  it('read like what they mean', () => {
    assert.equal(goalSentence(80, 20), '80% answered within 20 s');
    assert.equal(occupancySentence(85), 'Agents busy at most 85% of their logged-in time');
    assert.equal(shrinkageSentence(30), '30% of paid time is lost to breaks, training and absence');
  });
});

describe('which section is in view', () => {
  const s = (...tops: number[]) => tops.map((top, i) => ({ id: `s${i}`, top }));
  it('is the last section whose top has reached the top of the page', () => {
    assert.equal(activeSection(s(0, 400, 900)), 's0');
    assert.equal(activeSection(s(-300, 80, 700)), 's1', 'the second has scrolled up to the header');
    assert.equal(activeSection(s(-900, -500, -100)), 's2');
  });
  it('is the first when none has arrived yet, and nothing when there are no sections', () => {
    assert.equal(activeSection(s(300, 800)), 's0'); assert.equal(activeSection([]), null);
  });
});

describe('why Create is not available', () => {
  it('lists every reason', () => {
    assert.deepEqual(createBlockers({ canCreate: true, shortestHistoryDays: 56, horizonProblem: '', busy: false }), []);
    assert.equal(createBlockers({ canCreate: false, shortestHistoryDays: 0, horizonProblem: 'A short-term forecast covers 1 to 18 weeks.', busy: false }).length, 3);
  });
});

describe('a month of events', () => {
  it('lays out whole weeks, Monday first', () => {
    const w = monthWeeks(2026, 10);                       // November 2026 starts on a Sunday
    assert.deepEqual(w[0], ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
    assert.equal(w.length, 6, 'a month that starts on a Sunday needs six weeks'); assert.ok(w.every((x) => x.length === 7)); assert.equal(w.at(-1)![6], '2026-12-06');
    assert.equal(monthWeeks(2027, 1).length, 4, 'February 2027 fits four weeks exactly');
  });
  const e = { id: 'e', name: 'Spring sale', kind: 'campaign', startDay: '2026-11-10', endDay: '2026-11-12', upliftPct: 20, leadDays: 2, lagDays: 1 };
  it('shows an event on its days and lighter on the ramp days before and after', () => {
    const ph = (d: string) => eventsOnDay([e], d).map((x) => x.phase);
    assert.deepEqual([ph('2026-11-07'), ph('2026-11-08'), ph('2026-11-09'), ph('2026-11-10'), ph('2026-11-12'), ph('2026-11-13'), ph('2026-11-14')], [[], ['ramp-in'], ['ramp-in'], ['on'], ['on'], ['ramp-out'], []]);
  });
  it('picks a range from clicks: start, then end, an earlier click moves the start, a third starts again', () => {
    const a = pickRange(null, '2026-11-10'); assert.deepEqual(a, { start: '2026-11-10', end: '2026-11-10' });
    const b = pickRange(a, '2026-11-14'); assert.deepEqual(b, { start: '2026-11-10', end: '2026-11-14' });
    assert.deepEqual(pickRange(a, '2026-11-05'), { start: '2026-11-05', end: '2026-11-10' });
    assert.deepEqual(pickRange(b, '2026-11-20'), { start: '2026-11-20', end: '2026-11-20' });
  });
});

describe('dragging over a chart', () => {
  it('gives the first and last point, whichever way it was dragged, kept on the chart', () => {
    assert.deepEqual(dragSpan(10, 4, 48), { first: 4, last: 10 });
    assert.deepEqual(dragSpan(-3, 60, 48), { first: 0, last: 47 });
    assert.deepEqual(dragSpan(5, 5, 48), { first: 5, last: 5 });
    assert.equal(dragSpan(1, 2, 0), null); assert.equal(dragSpan(NaN, 2, 10), null);
  });
  it('turns slots into times and back', () => { assert.equal(slotTime(34), '08:30'); assert.equal(timeSlot('08:30'), 34); assert.equal(timeSlot('23:45'), 95); });
});

describe('what an adjustment will do, in words', () => {
  const base = { value: 10, from: '2026-11-12', to: '2026-11-12', short: true, tFrom: '08:00', tTo: '10:45', queue: '' };
  it('says it before it is applied', () => {
    assert.equal(adjustmentSentence({ ...base, mode: 'pct' }), 'Increase the forecast by 10% on 2026-11-12 between 08:00 and 10:45 for all queues.');
    assert.match(adjustmentSentence({ ...base, mode: 'pct', value: -5, queue: 'Sales' }), /^Decrease the forecast by 5% .* for Sales\.$/);
    assert.match(adjustmentSentence({ ...base, mode: 'add', value: 200, to: '2026-11-14', short: false }), /^Add 200 contacts on 2026-11-12 to 2026-11-14 for all queues, shared/);
    assert.match(adjustmentSentence({ ...base, mode: 'total', value: 1500 }), /^Set the total to 1,500 contacts/);
    assert.match(adjustmentSentence({ ...base, mode: 'zero' }), /^Expect no contacts on/);
    assert.match(adjustmentSentence({ ...base, mode: 'reset' }), /^Take off the adjustments on/);
  });
});
