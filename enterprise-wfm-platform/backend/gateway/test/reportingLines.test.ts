/**
 * The rules of bulk reporting lines, checked without a database:
 *   npx tsx --test --test-force-exit test/reportingLines.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseLines, planAssignments } from '../src/modules/reportingLines.ts';

describe('which proposed lines can be applied', () => {
  const none = (...ids: string[]) => new Map<string, string | null>(ids.map((i) => [i, null]));

  it('applies lines to people who have none, and counts the ones already in place as unchanged', () => {
    const cur = none('a', 'b', 'boss'); cur.set('b', 'boss');
    const r = planAssignments(cur, [{ id: 'a', boss: 'boss' }, { id: 'b', boss: 'boss' }]);
    assert.deepEqual(r.accepted, [{ id: 'a', boss: 'boss' }]);
    assert.equal(r.unchanged, 1);
    assert.equal(r.rejected.length, 0);
  });

  it('refuses a person reporting to themselves', () => {
    const r = planAssignments(none('a'), [{ id: 'a', boss: 'a' }]);
    assert.deepEqual(r.rejected.map((x) => x.why), ['SELF']);
    assert.equal(r.accepted.length, 0);
  });

  it('refuses a line that would loop back on itself, through any number of levels', () => {
    // c reports to b, b reports to a: making a report to c closes the loop a > c > b > a
    const cur = none('a', 'b', 'c'); cur.set('b', 'a'); cur.set('c', 'b');
    const r = planAssignments(cur, [{ id: 'a', boss: 'c' }]);
    assert.deepEqual(r.rejected.map((x) => x.why), ['CYCLE']);
  });

  it('counts each line against the ones already accepted, so two lines that loop together are not both applied', () => {
    const r = planAssignments(none('x', 'y'), [{ id: 'x', boss: 'y' }, { id: 'y', boss: 'x' }]);
    assert.deepEqual(r.accepted, [{ id: 'x', boss: 'y' }]);
    assert.deepEqual(r.rejected.map((q) => q.proposal.id), ['y']);
  });

  it('puts a whole team under its lead, including a lead who is himself in another team (no loop unless the other team is under him)', () => {
    // team A led by p1; team B led by p2; p1 sits in team B (so reports to p2); everyone in A reports to p1; p2 is in no team
    const cur = none('p1', 'p2', 'a1', 'a2', 'b1');
    const r = planAssignments(cur, [{ id: 'a1', boss: 'p1' }, { id: 'a2', boss: 'p1' }, { id: 'p1', boss: 'p2' }, { id: 'b1', boss: 'p2' }]);
    assert.equal(r.accepted.length, 4);
    // now the reverse: p2 is in team A, so a line p2 > p1 would loop with p1 > p2
    const r2 = planAssignments(cur, [{ id: 'p1', boss: 'p2' }, { id: 'p2', boss: 'p1' }]);
    assert.equal(r2.accepted.length, 1);
    assert.equal(r2.rejected[0].why, 'CYCLE');
  });
});

describe('the reporting-lines file', () => {
  it('reads the file the org chart exports, using the manager number and not the manager name', () => {
    const m = [['employee_number', 'name', 'team', 'status', 'is_supervisor', 'is_manager', 'reports_to_number', 'reports_to'], ['E1', 'Asha K', 'A', 'ACTIVE', 'false', 'false', 'S1', 'Sunita L'], ['E2', 'Ben', 'A', 'ACTIVE', 'false', 'false', '', '']];
    const p = parseLines(m);
    assert.equal(p.error, null);
    assert.deepEqual(p.rows, [{ line: 2, employee: 'E1', boss: 'S1' }]);
    assert.equal(p.blank, 1, 'a row with no manager is left alone, not treated as "remove the line"');
  });

  it('finds the columns by common names, whatever the case, spacing or byte order mark', () => {
    const p = parseLines([['﻿Employee Number', 'Manager'], ['E7', 'M1'], ['', ''], ['E8', 'M1']]);
    assert.deepEqual(p.rows.map((r) => r.employee), ['E7', 'E8']);
    assert.equal(p.blank, 0);
  });

  it('says plainly what is missing when the columns are not there', () => {
    const p = parseLines([['name', 'team'], ['Asha', 'A']]);
    assert.match(p.error ?? '', /employee_number/);
    assert.match(p.error ?? '', /reports_to_number/);
    assert.match(p.error ?? '', /Found: name, team/);
  });
});
