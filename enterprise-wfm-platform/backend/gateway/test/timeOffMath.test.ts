import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SPD, coveragePercent, shortBlocks, dayImpact, headline, passes, clock, type DayImpact } from '../src/modules/timeOffMath.ts';

const flat = (from: number, to: number, v: number) => { const a = new Array(SPD).fill(0); for (let i = from; i < to; i++) a[i] = v; return a; };
const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);

describe('coverage percent', () => {
  it('is staffed hours over needed hours, and overstaffing does not make up for a short slot', () => {
    assert.equal(coveragePercent([2, 2, 2, 2], [2, 2, 2, 2]), 100);
    assert.equal(coveragePercent([2, 2, 2, 2], [1, 1, 1, 1]), 50);
    assert.equal(coveragePercent([2, 2], [5, 0]), 50, 'the spare three in slot one do not cover slot two');
    assert.equal(coveragePercent([0, 0], [3, 3]), null, 'nothing needed: no percentage');
  });
});

describe('short blocks', () => {
  it('finds the stretch where the person works and the others fall short, with the share the others cover', () => {
    const required = flat(32, 48, 5);                       // 08:00-12:00 needs 5
    const others = flat(32, 48, 4);                         // four others
    const mine = flat(32, 48, 1);
    const b = shortBlocks(required, others, mine);
    assert.equal(b.length, 1);
    assert.deepEqual([b[0].startSlot, b[0].endSlot, b[0].percent, b[0].short], [32, 48, 80, 1]);
  });
  it('ignores hours where the others already cover the need, or the person is not working', () => {
    const required = flat(32, 48, 3);
    assert.deepEqual(shortBlocks(required, flat(32, 48, 3), flat(32, 48, 1)), [], 'the others cover it without them');
    assert.deepEqual(shortBlocks(required, flat(32, 48, 1), flat(0, 10, 1)), [], 'they are not working then');
  });
  it('splits into separate blocks when cover recovers in between', () => {
    const required = flat(32, 60, 4);
    const others = add(flat(32, 40, 3), add(flat(40, 50, 4), flat(50, 60, 2)));
    const b = shortBlocks(required, others, flat(32, 60, 1));
    assert.deepEqual(b.map((x) => [x.startSlot, x.endSlot]), [[32, 40], [50, 60]]);
  });
});

describe('day impact', () => {
  const required = flat(36, 68, 10);                         // 09:00-17:00 needs 10
  it('gives coverage with and without the person, and the worst stretch', () => {
    const others = flat(36, 68, 8), mine = flat(36, 68, 1);
    const d = dayImpact({ day: '2030-03-05', required, others, mine, published: true });
    assert.equal(d.scheduled, true); assert.equal(d.judged, true);
    assert.equal(d.beforePercent, 90); assert.equal(d.afterPercent, 80);
    assert.equal(d.worst?.percent, 80);
  });
  it('a day they are not working changes nothing', () => {
    const d = dayImpact({ day: '2030-03-06', required, others: flat(36, 68, 10), mine: new Array(SPD).fill(0), published: true });
    assert.equal(d.scheduled, false); assert.equal(d.beforePercent, d.afterPercent); assert.equal(d.worst, null);
  });
  it('a day with no requirement is not judged', () => {
    const d = dayImpact({ day: '2030-03-07', required: null, others: flat(36, 68, 3), mine: flat(36, 68, 1), published: true });
    assert.equal(d.judged, false); assert.equal(d.afterPercent, null);
  });
  it('does not judge a day nobody is rostered on yet: 0% there would say nothing about the leave', () => {
    const d = dayImpact({ day: '2030-03-09', required, others: new Array(SPD).fill(0), mine: new Array(SPD).fill(0), published: false });
    assert.equal(d.judged, false); assert.equal(d.beforePercent, null); assert.equal(d.afterPercent, null);
  });
  it('picks the lowest-coverage stretch as the worst', () => {
    const req = add(flat(0, 10, 4), flat(20, 30, 4));
    const others = add(flat(0, 10, 3), flat(20, 30, 1));
    const d = dayImpact({ day: '2030-03-08', required: req, others, mine: flat(0, 40, 1), published: true });
    assert.equal(d.worst?.percent, 25, 'the second stretch has one of the four needed');
    assert.equal(d.worst?.startSlot, 20);
  });
});

describe('headline', () => {
  const day = (over: Partial<DayImpact>): DayImpact => ({ day: '2030-03-05', scheduled: true, published: true, judged: true, beforePercent: 100, afterPercent: 100, worst: null, ...over });
  it('says what approving leaves, in the words a manager uses', () => {
    const h = headline([day({ afterPercent: 82, worst: { startSlot: 40, endSlot: 48, percent: 82, short: 1 } })], 90);
    assert.equal(h.text, 'Approving leaves Tue 03-05 10:00–12:00 at 82% coverage.');
    assert.equal(h.tone, 'bad');
  });
  it('is a warning, not a failure, when the day stays above target', () => {
    assert.equal(headline([day({ afterPercent: 95, worst: { startSlot: 40, endSlot: 48, percent: 90, short: 1 } })], 90).tone, 'warn');
  });
  it('says so when they are not working or cover cannot be judged', () => {
    assert.match(headline([day({ scheduled: false })], 90).text, /not scheduled/);
    const u = headline([day({ judged: false, afterPercent: null })], 90);
    assert.equal(u.tone, 'unknown'); assert.match(u.text, /cannot be shown/);
  });
  it('says no schedule is published when there is none for any of the days', () => {
    assert.match(headline([day({ scheduled: false, published: false, judged: false, afterPercent: null })], 90).text, /No schedule is published/);
  });
  it('is good news when every day stays covered', () => {
    assert.equal(headline([day({})], 90).tone, 'good');
  });
});

describe('passes', () => {
  const ok: DayImpact = { day: '2030-03-05', scheduled: true, published: true, judged: true, beforePercent: 100, afterPercent: 95, worst: null };
  const base = { blockers: [], reasons: [], balanceAfter: 3, capBreach: null, days: [ok], target: 90, status: 'REQUESTED' };
  it('passes when the rules, balance, team limit and cover are all fine', () => assert.deepEqual(passes(base), { ok: true, why: [] }));
  it('fails with the reason for each thing wrong', () => {
    const r = passes({ ...base, reasons: ['Blackout week.'], balanceAfter: -2, capBreach: { day: '2030-03-05', off: 3, cap: 3 }, days: [{ ...ok, afterPercent: 70 }] });
    assert.equal(r.ok, false);
    assert.equal(r.why.length, 4);
    assert.match(r.why.join(' '), /Blackout week/); assert.match(r.why.join(' '), /2 more days/); assert.match(r.why.join(' '), /Too many colleagues/); assert.match(r.why.join(' '), /fall to 70%/);
  });
  it('does not pass a working day it could not judge, but ignores days they are off', () => {
    assert.equal(passes({ ...base, days: [{ ...ok, judged: false, afterPercent: null }] }).ok, false);
    assert.equal(passes({ ...base, days: [{ ...ok, scheduled: false, judged: false, afterPercent: null }] }).ok, true);
  });
  it('does not pass something that is not waiting', () => {
    assert.equal(passes({ ...base, status: 'APPROVED' }).ok, false);
    assert.equal(passes({ ...base, balanceAfter: null }).ok, true, 'no entitlement set for the type: nothing to run out of');
  });
  it('clock formats quarter hours', () => assert.equal(clock(41), '10:15'));
});
