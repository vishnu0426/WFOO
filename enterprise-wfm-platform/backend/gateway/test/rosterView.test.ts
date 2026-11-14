import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, cellText, matchRoster, paidHours, rosterItems, sortRoster, type RosterShift } from '../../../src/services/rosterView.ts';

const sh = (id: string, name: string, day: string, over: Partial<RosterShift> = {}): RosterShift => ({ employeeId: id, employeeName: name, employeeNumber: `E-${id}`, teamName: 'A', day, startTime: '08:00', endTime: '16:30', startSlot: 32, lengthSlots: 34, activities: [{ type: 'MEAL', slots: 2 }, { type: 'BREAK', slots: 1 }], ...over });

describe('the roster', () => {
  it('works out paid hours: the length less the unpaid meal', () => assert.equal(paidHours(sh('1', 'x', 'd')), 8));
  it('is one row per person with a cell per day, hours and violations', () => {
    const rows = buildRoster([sh('1', 'First1', '2026-11-13'), sh('1', 'First1', '2026-11-14'), sh('2', 'First2', '2026-11-13')], new Set(['1|2026-11-14']));
    assert.equal(rows.length, 2);
    const a = rows.find((r) => r.id === '1')!;
    assert.deepEqual([a.hours, a.violations, a.shifts, a.cells['2026-11-13'].times, a.cells['2026-11-14'].bad, a.cells['2026-11-13'].bad], [16, 1, 2, '08:00–16:30', true, false]);
    assert.equal(rows.find((r) => r.id === '2')!.violations, 0);
  });
  it('puts a person with no team under "No team"', () => assert.equal(buildRoster([sh('1', 'x', 'd', { teamName: null })], new Set())[0].team, 'No team'));
});

describe('ordering', () => {
  const rows = buildRoster([sh('1', 'First10', 'd', { teamName: 'B' }), sh('2', 'First2', 'd', { teamName: 'A', lengthSlots: 20 }), sh('3', 'First100', 'd', { teamName: 'A' }), sh('4', 'First1', 'd', { teamName: 'B' })], new Set(['3|d']));
  it('by name in natural order', () => assert.deepEqual(sortRoster(rows, 'name', false).map((r) => r.name), ['First1', 'First2', 'First10', 'First100']));
  it('by paid hours, most first, ties by name', () => assert.deepEqual(sortRoster(rows, 'hours', false).map((r) => r.name), ['First1', 'First10', 'First100', 'First2']));
  it('with violations first', () => assert.equal(sortRoster(rows, 'violations', false)[0].name, 'First100'));
  it('grouped by team, teams in order, people in order within each', () => assert.deepEqual(sortRoster(rows, 'name', true).map((r) => `${r.team}:${r.name}`), ['A:First2', 'A:First100', 'B:First1', 'B:First10']));
});

describe('the list as drawn', () => {
  const rows = sortRoster(buildRoster([sh('1', 'a', 'd', { teamName: 'A' }), sh('2', 'b', 'd', { teamName: 'B' }), sh('3', 'c', 'd', { teamName: 'B' })], new Set()), 'name', true);
  it('has a heading per team when grouped', () => assert.deepEqual(rosterItems(rows, true).map((i) => (i.kind === 'group' ? `#${i.team}(${i.count})` : i.row.name)), ['#A(1)', 'a', '#B(2)', 'b', 'c']));
  it('hides the people of a folded team but keeps its heading', () => assert.deepEqual(rosterItems(rows, true, new Set(['B'])).map((i) => (i.kind === 'group' ? `#${i.team}` : i.row.name)), ['#A', 'a', '#B']));
  it('is just the people when not grouped', () => assert.equal(rosterItems(rows, false).length, 3));
});

describe('cells and search', () => {
  it('says the times, the hours or a dot', () => {
    const c = { times: '08:00–16:30', hours: 8, bad: false, startSlot: 32 };
    assert.equal(cellText(c, 'times'), '08:00–16:30'); assert.equal(cellText(c, 'hours'), '8 h'); assert.equal(cellText(undefined, 'times'), '·');
  });
  it('finds people by name or number', () => {
    const rows = buildRoster([sh('1', 'Amy Lee', 'd'), sh('2', 'Bob Ray', 'd')], new Set());
    assert.deepEqual(matchRoster(rows, 'amy').map((r) => r.name), ['Amy Lee']); assert.deepEqual(matchRoster(rows, 'e-2').map((r) => r.name), ['Bob Ray']); assert.equal(matchRoster(rows, '').length, 2);
  });
});
