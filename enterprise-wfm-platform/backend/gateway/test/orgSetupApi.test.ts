/**
 * Setting reporting lines up in bulk through the API: a whole company from its teams in one step, and from a file. Needs a running gateway:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/orgSetupApi.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}

describe('reporting lines in bulk', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any;
  const teams: Record<string, any> = {}, emp: Record<string, any> = {};
  const mk = async (key: string, extra: object = {}) => {
    const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `OR${RUN}-${key}`, firstName: key, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48, ...extra });
    assert.equal(r.status, 201, r.text); emp[key] = r.json; return r.json;
  };
  const line = async (key: string) => (await call(admin, 'GET', `/workforce/employees/${emp[key].id}`)).json.reportsTo as string | null;
  const setup = async () => (await call(admin, 'GET', `/workforce/org-chart/setup?groupId=${group.id}`)).json;

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Org ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
    for (const k of ['A', 'B', 'C']) teams[k] = (await call(admin, 'POST', '/workforce/teams', { name: `Team ${k} ${RUN}` })).json;
    await mk('leadA', { isSupervisor: true }); await mk('leadB', { isSupervisor: true });
    assert.equal((await call(admin, 'PUT', `/workforce/teams/${teams.A.id}`, { name: teams.A.name, managerId: emp.leadA.id })).status, 200);
    assert.equal((await call(admin, 'PUT', `/workforce/teams/${teams.B.id}`, { name: teams.B.name, managerId: emp.leadB.id })).status, 200);
    for (let i = 1; i <= 6; i++) await mk(`a${i}`, { teamId: teams.A.id });
    for (let i = 1; i <= 4; i++) await mk(`b${i}`, { teamId: teams.B.id });
    for (let i = 1; i <= 3; i++) await mk(`c${i}`, { teamId: teams.C.id });                 // a team with no lead
    await mk('loose1'); await mk('loose2');                                              // in no team
  });

  it('says what making each team lead the manager of their team would do, before doing it', async () => {
    const s = await setup();
    assert.equal(s.withLead.teams, 2);
    assert.equal(s.withLead.wouldSet, 10, 'six in team A and four in team B');
    assert.equal(s.withoutLead.teams, 1);
    assert.equal(s.withoutLead.people, 3, 'team C cannot be set until it has a lead');
    assert.ok(s.noTeam >= 2);
    assert.deepEqual(s.teams.find((t: any) => t.id === teams.A.id), { id: teams.A.id, name: teams.A.name, leadName: 'leadA Person', people: 6, wouldSet: 6, wouldChange: 0 });
  });

  it('needs a reason, then puts everyone under their team lead, leaving people who already have a line alone', async () => {
    assert.equal((await call(admin, 'POST', '/workforce/org-chart/apply-teams', { groupId: group.id })).status, 400);
    // a3 already reports to leadB: left alone unless asked
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${emp.a3.id}`, { reportsTo: emp.leadB.id, reason: 'test: already has a manager' })).status, 200);
    const r = await call(admin, 'POST', '/workforce/org-chart/apply-teams', { groupId: group.id, reason: 'QA: set from teams' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, 9, '5 of team A (not a3) and 4 of team B');
    assert.equal(await line('a1'), emp.leadA.id); assert.equal(await line('b2'), emp.leadB.id);
    assert.equal(await line('a3'), emp.leadB.id, 'who already had a manager keeps them');
    assert.equal(await line('leadA'), null, 'a lead is not put under themselves');
    assert.equal(await line('c1'), null, 'team C has no lead');
    const again = await call(admin, 'POST', '/workforce/org-chart/apply-teams', { groupId: group.id, reason: 'QA: again' });
    assert.equal(again.json.updated, 0, 'doing it twice changes nothing');
    const over = await call(admin, 'POST', '/workforce/org-chart/apply-teams', { groupId: group.id, overwrite: true, reason: 'QA: overwrite' });
    assert.equal(over.json.updated, 1);
    assert.equal(await line('a3'), emp.leadA.id, 'asked to, a3 now reports to their team lead');
  });

  it('refuses to make a loop when a lead sits in the team of the person they lead', async () => {
    // leadA is placed in team B; leadB is placed in team A: B-team people report to leadB, A-team people to leadA, and leadA/leadB would then lead each other
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${emp.leadA.id}`, { teamId: teams.B.id, reason: 'test: loop' })).status, 200);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${emp.leadB.id}`, { teamId: teams.A.id, reason: 'test: loop' })).status, 200);
    const r = await call(admin, 'POST', '/workforce/org-chart/apply-teams', { groupId: group.id, reason: 'QA: loop' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated + r.json.skipped, 2, 'the two leads: one gets its line, the other would close the loop and is skipped');
    assert.equal(r.json.skipped, 1);
    assert.match(r.json.skippedPeople[0].why, /loop/);
    const a = await line('leadA'), b = await line('leadB');
    assert.ok(!(a === emp.leadB.id && b === emp.leadA.id), 'they do not report to each other');
  });

  it('reads a file, checks it first and lists the rows it cannot use', async () => {
    const n = (k: string) => emp[k].employeeNumber;
    const csv = ['employee_number,reports_to_number', `${n('c1')},${n('leadA')}`, `${n('c2')},${n('leadA')}`, `${n('c3')},`, `NOPE-1,${n('leadA')}`, `${n('c1')},NOPE-2`, `${n('loose1')},${n('loose1')}`].join('\n');
    const dry = await call(admin, 'POST', '/workforce/org-chart/import', { csv, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.willChange, 2);
    assert.equal(dry.json.blank, 1, 'a row with no manager is left alone');
    assert.equal(dry.json.problemCount, 3);
    assert.ok(dry.json.problems.some((p: any) => /No employee has the number "NOPE-1"/.test(p.message) && p.line === 5));
    assert.ok(dry.json.problems.some((p: any) => /themselves/.test(p.message)));
    assert.equal(await line('c2'), null, 'checking changes nothing');
    assert.equal((await call(admin, 'POST', '/workforce/org-chart/import', { csv, dryRun: false })).status, 400, 'applying needs a reason');
    const done = await call(admin, 'POST', '/workforce/org-chart/import', { csv, dryRun: false, reason: 'QA: from a file' });
    assert.equal(done.json.applied, 2);
    assert.equal(await line('c2'), emp.leadA.id);
  });

  it('takes back the file the chart exports, unchanged, as nothing to do', async () => {
    const r = await fetch(`${BASE}/api/v1/workforce/org-chart/export.csv`, { headers: { Authorization: `Bearer ${admin}` } });
    const csv = await r.text();
    assert.match(csv.split('\n')[0], /employee_number,name,team,status,is_supervisor,is_manager,reports_to_number,reports_to/);
    const dry = await call(admin, 'POST', '/workforce/org-chart/import', { csv, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.willChange, 0, 'every line in the file is already how it is');
    assert.equal(dry.json.problemCount, 0);
  });

  it('says plainly what is wrong with a file that has no usable columns', async () => {
    const r = await call(admin, 'POST', '/workforce/org-chart/import', { csv: 'name,team\nAsha,A', dryRun: true });
    assert.equal(r.status, 400);
    assert.match(r.text, /employee_number/);
  });
});
