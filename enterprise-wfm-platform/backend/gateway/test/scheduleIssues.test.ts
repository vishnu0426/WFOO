import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fitPx, gapLabel, gapMinutes, gapWindows, issueLabel, labelEvery, layoutRows, naturalCompare, orderIssues, peopleLine, violationsNote, windowOf } from '../../../src/services/scheduleIssues.ts';

describe('sorting people', () => {
  it('puts Agent 2 before Agent 10, and First10 before First100', () => {
    assert.deepEqual(['First100', 'First10', 'First1', 'First2'].sort(naturalCompare), ['First1', 'First2', 'First10', 'First100']);
    assert.deepEqual(['Agent 10', 'Agent 2'].sort(naturalCompare), ['Agent 2', 'Agent 10']);
  });
  it('ignores case and accents', () => { assert.equal(naturalCompare('anna', 'Anna'), 0); assert.ok(naturalCompare('Émile', 'Zoe') < 0); });
});

describe('fitting the day to the screen', () => {
  it('uses the width left of the names, within a readable range', () => {
    assert.equal(fitPx(1000, 224, 56), 13); assert.equal(fitPx(1600, 224, 24), 40, 'a short day is not stretched past the maximum'); assert.equal(fitPx(300, 224, 96), 4);
    assert.equal(fitPx(0, 224, 56), 20); assert.equal(fitPx(1000, 224, 0), 20);
  });
  it('draws labels every hour, two hours or four hours so they never crowd', () => {
    assert.equal(labelEvery(20), 4); assert.equal(labelEvery(13), 4); assert.equal(labelEvery(12), 8); assert.equal(labelEvery(7), 8); assert.equal(labelEvery(6), 16); assert.equal(labelEvery(5), 16);
  });
});

describe('which rows are on screen', () => {
  const heights = Array.from({ length: 1000 }, (_, i) => (i % 10 === 0 ? 28 : 52));
  const layout = layoutRows(heights);
  it('lays out rows of different heights', () => { assert.equal(layout.tops[0], 0); assert.equal(layout.tops[1], 28); assert.equal(layout.tops[2], 80); assert.equal(layout.total, heights.reduce((a, b) => a + b, 0)); });
  it('windows a long list to the rows in view plus a margin', () => {
    const [a, b] = windowOf(layout, heights, 5000, 5600, 4);
    assert.ok(a <= 5000 / 50 && b - a < 40, `${a}..${b}`);
    for (const i of [Math.floor(a + 4), Math.floor(b - 5)]) assert.ok(layout.tops[i] + heights[i] > 4000 && layout.tops[i] < 6600);
  });
  it('works at the top, the end and for nothing', () => {
    assert.deepEqual(windowOf(layout, heights, 0, 300, 0).slice(0, 1), [0]); assert.equal(windowOf(layout, heights, layout.total + 100, layout.total + 500, 3)[1], 1000);
    assert.deepEqual(windowOf(layoutRows([]), [], 0, 100), [0, 0]);
  });
});

describe('where cover is short', () => {
  it('merges short quarter-hours into windows with the biggest shortfall', () => {
    const slots = [0, 0, -1, -3, -2, 0, 0, -1, 2].map((delta) => ({ delta }));
    const g = gapWindows(slots);
    assert.deepEqual(g, [{ from: 2, to: 5, need: 3 }, { from: 7, to: 8, need: 1 }]);
    assert.equal(gapLabel(g[0]), '00:30–01:15'); assert.equal(gapMinutes(g[0]), 45);
  });
  it('can be limited to the hours on screen', () => assert.deepEqual(gapWindows([-1, -1, 0, -1].map((delta) => ({ delta })), 2, 4), [{ from: 3, to: 4, need: 1 }]));
});

describe('the issues list', () => {
  const v = (name: string, day: string, type = 'MAX_HOURS') => ({ type, employeeId: name, employeeName: name, day, message: 'm' });
  it('lists this day first, then the rest by date, people in natural order', () => {
    const o = orderIssues([v('Agent 10', '2026-11-12'), v('Agent 2', '2026-11-12'), v('Zed', '2026-11-13'), v('Amy', '2026-11-11')], '2026-11-12');
    assert.deepEqual(o.map((x) => x.employeeName), ['Agent 2', 'Agent 10', 'Amy', 'Zed']);
  });
  it('reads rule names as words', () => { assert.equal(issueLabel('LAW_WEEKLY_REST'), 'law: weekly rest'); assert.equal(issueLabel('MAX_CONSECUTIVE_DAYS'), 'max consecutive days'); assert.equal(issueLabel('LAW_WEEKLY_REST', false), 'weekly rest'); });
});

describe('the words around the violations', () => {
  it('says "before publishing" only for a draft', () => {
    assert.equal(violationsNote('DRAFT', 3), 'These must be fixed before this schedule can be published.');
    assert.match(violationsNote('PUBLISHED', 3), /3 rules are broken in the published schedule\. Fix them, then republish\./);
    assert.match(violationsNote('PUBLISHED', 1), /1 rule is broken.*Fix it, then republish/);
    assert.match(violationsNote('ARCHIVED', 2), /archived/);
    assert.equal(violationsNote('DRAFT', 0), '');
  });
  it('keeps the two head counts apart', () => assert.equal(peopleLine(351, 129), '351 people in this schedule · 129 on shift this day'));
});

import { nowIn, nowRowIndex, pickOpenDay, tzLabel } from '../../../src/services/scheduleIssues.ts';

describe('the actual time', () => {
  it('reads the date and time on the group\'s own clock, not the computer\'s', () => {
    const at = Date.UTC(2026, 10, 13, 22, 0);           // 22:00 UTC on 13 Nov
    assert.deepEqual(nowIn('UTC', at), { day: '2026-11-13', slot: 88 });
    assert.deepEqual(nowIn('Asia/Kolkata', at), { day: '2026-11-14', slot: 14 });         // 03:30 the next day
    assert.deepEqual(nowIn('America/New_York', at), { day: '2026-11-13', slot: 68 });     // 17:00
    assert.deepEqual(nowIn('Pacific/Kiritimati', at), { day: '2026-11-14', slot: 48 });    // 12:00, UTC+14
  });
  it('counts a fraction of a slot for the minutes, and midnight as slot 0', () => {
    assert.equal(nowIn('UTC', Date.UTC(2026, 0, 1, 9, 7)).slot, 36.46666666666667); assert.deepEqual(nowIn('UTC', Date.UTC(2026, 0, 1, 0, 0)), { day: '2026-01-01', slot: 0 });
  });
  it('falls back to UTC for a zone it does not know', () => assert.equal(nowIn('Nowhere/Land', Date.UTC(2026, 0, 1, 1, 0)).slot, 4));
  it('names the clock', () => { assert.equal(tzLabel('Asia/Kolkata', Date.UTC(2026, 10, 13)), 'UTC+5:30'); assert.equal(tzLabel('UTC'), 'UTC'); });
});

describe('where a schedule opens', () => {
  const period = { start: '2026-11-01', end: '2026-11-07' };
  it('on today when it is inside the schedule', () => assert.equal(pickOpenDay(period, '2026-11-04'), '2026-11-04'));
  it('on the first day when today is outside it', () => { assert.equal(pickOpenDay(period, '2026-12-01'), '2026-11-01'); assert.equal(pickOpenDay(period, '2026-10-01'), '2026-11-01'); });
  it('on the day a link asked for, ahead of today', () => { assert.equal(pickOpenDay(period, '2026-11-04', '2026-11-06'), '2026-11-06'); assert.equal(pickOpenDay(period, '2026-11-04', '2026-12-30'), '2026-11-04', 'a requested day outside the schedule is ignored'); });
});

describe('which row shows at the current time', () => {
  const rows = [{ startSlot: 28, lengthSlots: 32 }, { startSlot: 32, lengthSlots: 32 }, { startSlot: 60, lengthSlots: 32 }];
  it('the first person on shift', () => assert.equal(nowRowIndex(rows, 40), 0));
  it('after the first has finished, the first still working', () => assert.equal(nowRowIndex(rows, 62), 1));
  it('before anyone starts, the first to start; after everyone is done, the top', () => { assert.equal(nowRowIndex(rows, 10), 0); assert.equal(nowRowIndex([{ startSlot: 40, lengthSlots: 8 }, { startSlot: 60, lengthSlots: 8 }], 50), 1); assert.equal(nowRowIndex(rows, 95), 0); assert.equal(nowRowIndex([], 40), 0); });
});
