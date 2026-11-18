import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summariseEmployees, type SummaryRow } from '../src/modules/employeeSummary.ts';

// rows as the database layer (db.ts camelize) returns them: team_id arrives as teamId
const fromDb = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()), v])) as unknown as SummaryRow;

describe('employee summary', () => {
  it('lists the teams people belong to, with their headcount and hours', () => {
    const s = summariseEmployees([
      fromDb({ team_id: 't-blue', team_name: 'Blue Team', people: 200, hours: '8000' }),
      fromDb({ team_id: 't-red', team_name: 'Red Team', people: 107, hours: '4280' }),
    ]);
    assert.equal(s.people, 307);
    assert.equal(s.weeklyHours, 12280);
    assert.deepEqual(s.teams.map((t) => [t.id, t.name, t.people, t.weeklyHours]), [['t-blue', 'Blue Team', 200, 8000], ['t-red', 'Red Team', 107, 4280]]);
  });
  it('counts people without a team but does not list them as a team', () => {
    const s = summariseEmployees([fromDb({ team_id: null, team_name: null, people: 5, hours: '200' }), fromDb({ team_id: 't1', team_name: 'A', people: 3, hours: '120' })]);
    assert.equal(s.people, 8);
    assert.deepEqual(s.teams.map((t) => t.id), ['t1']);
  });
});
