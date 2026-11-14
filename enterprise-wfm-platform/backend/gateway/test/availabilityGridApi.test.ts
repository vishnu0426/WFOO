/**
 * The team-week availability grid through the API: many people in one call, windows with dates left alone, nothing half-saved. Needs a running gateway:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/availabilityGridApi.test.ts
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
const win = (dayOfWeek: number, startTime: string, endTime: string, kind: string) => ({ dayOfWeek, startTime, endTime, kind });

describe('availability grid', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', team: any, other: any, analyst = '';
  const ids: string[] = [];
  const grid = async (q = '') => (await call(admin, 'GET', `/workforce/availability/grid?teamId=${team.id}${q}`)).json;

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const group = (await call(admin, 'POST', '/config/groups', { name: `AvG ${RUN}` })).json;
    team = (await call(admin, 'POST', '/workforce/teams', { name: `Av Team ${RUN}` })).json;
    other = (await call(admin, 'POST', '/workforce/teams', { name: `Av Other ${RUN}` })).json;
    for (let i = 1; i <= 6; i++) {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `AV${RUN}-${i}`, firstName: `Av${i}`, lastName: 'Person', primaryGroupId: group.id, teamId: team.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(r.status, 201, r.text); ids.push(r.json.id);
    }
    await call(admin, 'POST', '/users', { username: `avview${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `avview${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
  });

  it('lists the people of a team with their recurring week, and none for a team nobody is in', async () => {
    const g = await grid();
    assert.equal(g.total, 6);
    assert.equal(g.people.length, 6);
    assert.deepEqual(g.people[0].windows, []);
    assert.equal(g.people[0].teamName, team.name);
    assert.equal((await call(admin, 'GET', `/workforce/availability/grid?teamId=${other.id}`)).json.total, 0);
    assert.equal((await grid('&limit=2&offset=4')).people.length, 2, 'pages');
    assert.equal((await grid('&q=Av3')).total, 1, 'searches by name or number');
  });

  it('sets the week of many people in one call, replacing what they had', async () => {
    const week = [win(0, '09:00', '17:00', 'AVAILABLE'), win(1, '09:00', '17:00', 'AVAILABLE'), win(5, '00:00', '24:00', 'UNAVAILABLE'), win(6, '00:00', '24:00', 'UNAVAILABLE')];
    const r = await call(admin, 'PUT', '/workforce/availability/bulk', { people: ids.slice(0, 5).map((employeeId) => ({ employeeId, windows: week })) });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, 5);
    const g = await grid();
    const set = g.people.filter((p: any) => p.windows.length === 4);
    assert.equal(set.length, 5, 'five people have the week, one still has none');
    assert.deepEqual(set[0].windows.map((w: any) => [w.dayOfWeek, w.startTime, w.endTime, w.kind]), [[0, '09:00', '17:00', 'AVAILABLE'], [1, '09:00', '17:00', 'AVAILABLE'], [5, '00:00', '24:00', 'UNAVAILABLE'], [6, '00:00', '24:00', 'UNAVAILABLE']]);
    // the same call again with a different week replaces, it does not add
    await call(admin, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[0], windows: [win(2, '12:00', '14:00', 'UNAVAILABLE')] }] });
    const one = (await grid()).people.find((p: any) => p.id === ids[0]);
    assert.deepEqual(one.windows.map((w: any) => w.dayOfWeek), [2]);
  });

  it('leaves windows that apply only between two dates alone, and counts them', async () => {
    const put = await call(admin, 'PUT', `/workforce/employees/${ids[5]}/availability`, { windows: [{ ...win(3, '10:00', '12:00', 'UNAVAILABLE'), effectiveFrom: '2030-01-01', effectiveTo: '2030-01-31' }] });
    assert.equal(put.status, 200, put.text);
    await call(admin, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[5], windows: [win(0, '08:00', '16:00', 'PREFERRED')] }] });
    const p = (await grid()).people.find((x: any) => x.id === ids[5]);
    assert.equal(p.dated, 1, 'the dated rule is still there');
    assert.deepEqual(p.windows.map((w: any) => [w.dayOfWeek, w.kind]), [[0, 'PREFERRED']]);
    const full = (await call(admin, 'GET', `/workforce/employees/${ids[5]}/availability`)).json;
    assert.equal(full.length, 2);
  });

  it('refuses a bad window or a person who is not there, and saves nothing', async () => {
    const before = JSON.stringify((await grid()).people.map((p: any) => p.windows));
    const bad = await call(admin, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[1], windows: [win(0, '17:00', '09:00', 'AVAILABLE')] }] });
    assert.equal(bad.status, 400);
    assert.match(bad.text, /the end must be after the start/);
    const ghost = await call(admin, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[1], windows: [win(4, '09:00', '12:00', 'AVAILABLE')] }, { employeeId: '00000000-0000-4000-8000-000000000000', windows: [] }] });
    assert.equal(ghost.status, 404);
    assert.equal(JSON.stringify((await grid()).people.map((p: any) => p.windows)), before, 'the good person in the same call was not changed either');
    assert.equal((await call(admin, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[1], windows: [{ ...win(0, '09:00', '10:00', 'AVAILABLE'), effectiveFrom: '2030-01-01' }] }] })).status, 400, 'dated windows are not part of the grid');
  });

  it('can be read by someone who cannot change it, and only changed by someone who can', async () => {
    assert.equal((await call(analyst, 'GET', `/workforce/availability/grid?teamId=${team.id}`)).status, 200);
    assert.equal((await call(analyst, 'PUT', '/workforce/availability/bulk', { people: [{ employeeId: ids[0], windows: [] }] })).status, 403);
  });
});
