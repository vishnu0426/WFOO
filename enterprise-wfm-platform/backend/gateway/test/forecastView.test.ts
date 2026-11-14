import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { advancedCount, covers, defaultView, isFlat, rangeForGrain, readStoredView, reconcileView, resolveWindow, writeStoredView, type ViewState } from '../../../src/services/forecastView.ts';

const W = { fromDay: '2026-11-09', toDay: '2027-03-14' };
const FUTURE = { fromDay: '2027-01-03', toDay: '2027-02-27' };
const base: ViewState = { range: 'Day', grain: '30', start: '2026-12-01', end: '2027-03-14', queueId: '' };

describe('opening view', () => {
  it('opens on today when the forecast covers it, otherwise on its first day', () => {
    assert.equal(defaultView(W, '2026-11-12').start, '2026-11-12');
    assert.equal(defaultView(FUTURE, '2026-11-12').start, '2027-01-03', 'a forecast that starts in the future opens on its first day');
    assert.equal(defaultView(W, '2027-06-01').start, '2026-11-09', 'one that has ended opens on its first day');
    assert.equal(defaultView(W, '2026-11-09').start, '2026-11-09', 'the first day counts as covered');
    assert.deepEqual([covers(W, '2027-03-14'), covers(W, '2027-03-15')], [true, false]);
  });
});

describe('carrying a selection to another forecast', () => {
  it('keeps the range, interval, dates and queue that still make sense', () => {
    const r = reconcileView({ ...base, range: 'Week', grain: '60', queueId: 'q1' }, W, ['q1', 'q2'], '2026-11-12');
    assert.deepEqual(r, { range: 'Week', grain: '60', start: '2026-12-01', end: '2027-03-14', queueId: 'q1' });
  });
  it('moves dates that fall outside the new forecast onto today or its first day, and drops a queue the group does not have', () => {
    const r = reconcileView({ ...base, queueId: 'gone', start: '2026-12-01', end: '2026-12-05' }, FUTURE, ['q1'], '2026-11-12');
    assert.equal(r.start, '2027-01-03'); assert.equal(r.end, '2027-02-27'); assert.equal(r.queueId, '');
    assert.equal(reconcileView({ ...base, start: '2025-01-01' }, W, [], '2026-11-12').start, '2026-11-12');
  });
  it('an end before the start is replaced by the forecast\'s last day', () => {
    assert.equal(reconcileView({ ...base, start: '2026-12-10', end: '2026-12-01' }, W, [], '2026-11-12').end, '2027-03-14');
  });
  it('starts from the defaults when nothing was remembered', () => assert.deepEqual(reconcileView(null, W, [], '2026-11-12'), defaultView(W, '2026-11-12')));
});

describe('the window asked of the server', () => {
  it('is one day, a week, the whole forecast or a custom range, clamped to the forecast', () => {
    assert.deepEqual(resolveWindow(base, W, 'SHORT'), { from: '2026-12-01', to: '2026-12-01', grain: '30' });
    assert.deepEqual(resolveWindow({ ...base, range: 'Week', grain: '60', start: '2027-03-12' }, W, 'SHORT'), { from: '2027-03-12', to: '2027-03-14', grain: '60' });
    assert.deepEqual(resolveWindow({ ...base, range: 'Month', grain: 'day' }, W, 'SHORT'), { from: '2026-11-09', to: '2027-03-14', grain: 'day' });
    assert.deepEqual(resolveWindow({ ...base, range: 'Custom Range', grain: '60', start: '2026-12-01', end: '2026-12-05' }, W, 'SHORT'), { from: '2026-12-01', to: '2026-12-05', grain: '60' });
    assert.equal(resolveWindow({ ...base, start: '2020-01-01' }, W, 'SHORT').from, '2026-11-09');
  });
  it('keeps to the limits the gateway enforces', () => {
    const wide = { ...base, range: 'Custom Range' as const, grain: '15' as const, start: '2026-11-09', end: '2026-12-31' };
    assert.equal(resolveWindow(wide, W, 'SHORT').grain, '60', '15-minute views span at most 14 days');
    assert.equal(resolveWindow({ ...wide, grain: '60' }, W, 'LONG').grain, 'day', 'a long-term forecast splits a day by time for at most 31 days');
    assert.equal(resolveWindow({ ...wide, end: '2026-11-20', grain: '60' }, W, 'LONG').grain, '60');
  });
  it('widens the range when days, weeks or months are asked for', () => {
    assert.equal(rangeForGrain('Day', 'day'), 'Month'); assert.equal(rangeForGrain('Week', 'week'), 'Month'); assert.equal(rangeForGrain('Week', 'day'), 'Week');
    assert.equal(rangeForGrain('Custom Range', 'month'), 'Custom Range'); assert.equal(rangeForGrain('Day', '60'), 'Day');
  });
  it('counts the advanced choices that are not the defaults', () => {
    assert.equal(advancedCount(base, '30'), 0); assert.equal(advancedCount(base, '60'), 1); assert.equal(advancedCount({ ...base, queueId: 'q' }, '60'), 2);
  });
});

describe('flat series', () => {
  it('a series that never moves is flat, one that does is not', () => {
    assert.equal(isFlat([180, 180, 180, 180]), true);
    assert.equal(isFlat([180, 181, 180, 180]), true, 'within a second of 180');
    assert.equal(isFlat([240, 260, 300, 320]), false);
    assert.equal(isFlat([1000, 1005, 1009]), true, 'within 1% of a large mean');
    assert.equal(isFlat([1000, 1030]), false);
  });
  it('needs at least two real values to call anything flat, and ignores gaps', () => {
    assert.equal(isFlat([]), false); assert.equal(isFlat([180]), false); assert.equal(isFlat([null, undefined, 180]), false);
    assert.equal(isFlat([180, null, 180, undefined]), true);
  });
});

describe('remembered between visits', () => {
  it('round-trips, and refuses anything that is not a view', () => {
    const raw = writeStoredView('g1', { ...base, queueId: 'q1' });
    assert.deepEqual(readStoredView(raw), { groupId: 'g1', ...base, queueId: 'q1' });
    assert.equal(readStoredView(null), null); assert.equal(readStoredView('not json'), null); assert.equal(readStoredView('{"groupId":1}'), null);
    assert.equal(readStoredView(JSON.stringify({ groupId: 'g', range: 'Year', grain: '30' })), null, 'an unknown range');
    assert.equal(readStoredView(JSON.stringify({ groupId: 'g', range: 'Day', grain: '30', start: 'yesterday', end: '' }))?.start, '', 'a bad date is dropped, not kept');
  });
});
