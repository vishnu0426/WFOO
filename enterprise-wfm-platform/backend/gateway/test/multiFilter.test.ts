/**
 * Several values in one filter: groups, teams, statuses and skills on the employee list, statuses on time off.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/multiFilter.test.ts
 * Needs a running gateway. Every name carries a run id, so the suite can be repeated against the same database.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, total: r.headers.get('X-Total-Count') };
};

describe('multi-value filters', { skip: !process.env.ADMIN_PASSWORD }, () => {
  let admin = '';
  const ids: Record<string, string> = {};
  const group: Record<string, string> = {}, team: Record<string, string> = {}, skill: Record<string, string> = {};
  const names = async (qs: string) => (await call(admin, 'GET', `/workforce/employees?${qs}`)).json.map((e: any) => e.employeeNumber).filter((n: string) => n.startsWith(`M${RUN}`)).sort();

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT })).json.token;
    for (const g of ['A', 'B', 'C']) {
      const r = await call(admin, 'POST', '/config/groups', { name: `MF ${g} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
      assert.equal(r.status, 201, r.text); group[g] = r.json.id;
    }
    for (const t of ['X', 'Y']) { const r = await call(admin, 'POST', '/workforce/teams', { name: `MF team ${t} ${RUN}` }); assert.equal(r.status, 201, r.text); team[t] = r.json.id; }
    for (const k of ['English', 'French']) { const r = await call(admin, 'POST', '/workforce/skills', { name: `MF ${k} ${RUN}` }); assert.equal(r.status, 201, r.text); skill[k] = r.json.id; }
    // person -> group, team, status, skills
    const people: [string, string, string, string, string[]][] = [
      ['1', 'A', 'X', 'ACTIVE', ['English']], ['2', 'A', 'Y', 'ACTIVE', ['English', 'French']], ['3', 'B', 'X', 'LEAVE', ['French']],
      ['4', 'B', 'Y', 'ACTIVE', []], ['5', 'C', 'X', 'TERMINATED', ['English']],
    ];
    for (const [n, g, t, st, sk] of people) {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `M${RUN}-${n}`, firstName: `Pat${n}`, lastName: `Multi${RUN}`, primaryGroupId: group[g], teamId: team[t], status: st });
      assert.equal(r.status, 201, r.text); ids[n] = r.json.id;
      if (sk.length) assert.equal((await call(admin, 'PUT', `/workforce/employees/${r.json.id}/skills`, { skills: sk.map((k) => ({ skillId: skill[k], proficiency: 3 })) })).status, 200);
    }
  });

  const gs = (...g: string[]) => `groupIds=${g.map((x) => group[x]).join(',')}`;
  const ts = (...t: string[]) => `teamIds=${t.map((x) => team[x]).join(',')}`;
  const n = (...k: string[]) => k.map((x) => `M${RUN}-${x}`);

  it('keeps the single-value filters working as before', async () => {
    assert.deepEqual(await names(`groupId=${group.A}`), n('1', '2'));
    assert.deepEqual(await names(`teamId=${team.Y}`), n('2', '4'));
    assert.deepEqual(await names('status=LEAVE'), n('3'));
  });

  it('a person matches any of several groups', async () => {
    assert.deepEqual(await names(gs('A', 'B')), n('1', '2', '3', '4'));
    assert.deepEqual(await names(gs('C')), n('5'));
  });

  it('a person matches any of several teams', async () => {
    assert.deepEqual(await names(ts('X', 'Y')), n('1', '2', '3', '4', '5'));
    assert.deepEqual(await names(ts('X')), n('1', '3', '5'));
  });

  it('a person matches any of several statuses', async () => {
    assert.deepEqual(await names(`${gs('A', 'B', 'C')}&statuses=LEAVE,TERMINATED`), n('3', '5'));
    assert.deepEqual(await names(`${gs('A', 'B', 'C')}&statuses=ACTIVE`), n('1', '2', '4'));
  });

  it('different filters combine: all of them must hold', async () => {
    assert.deepEqual(await names(`${gs('A', 'B')}&${ts('X')}&statuses=ACTIVE,LEAVE`), n('1', '3'));
    assert.deepEqual(await names(`${gs('A', 'B')}&${ts('Y')}&statuses=LEAVE`), []);
  });

  it('several skills mean the person has every one of them', async () => {
    assert.deepEqual(await names(`${gs('A', 'B', 'C')}&skillIds=${skill.English}`), n('1', '2', '5'));
    assert.deepEqual(await names(`${gs('A', 'B', 'C')}&skillIds=${skill.English},${skill.French}`), n('2'));
  });

  it('counts and pages use the same filter', async () => {
    const r = await call(admin, 'GET', `/workforce/employees?${gs('A', 'B')}&statuses=ACTIVE&limit=2&offset=0`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.length, 2); assert.equal(r.total, '3');
    const ids2 = await call(admin, 'GET', `/workforce/employees?${gs('A', 'B')}&statuses=ACTIVE&fields=ids`);
    assert.equal(ids2.json.length, 3);
  });

  it('refuses a value that is not what the filter takes', async () => {
    assert.equal((await call(admin, 'GET', '/workforce/employees?groupIds=not-a-uuid')).status, 400);
    assert.equal((await call(admin, 'GET', '/workforce/employees?statuses=ACTIVE,NOPE')).status, 400);
    assert.equal((await call(admin, 'GET', `/workforce/employees?groupIds=${new Array(60).fill(group.A).join(',')}`)).status, 400, 'at most 50 values');
  });

  it('time off can be filtered by several statuses', async () => {
    const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
    const a = (await call(admin, 'POST', '/workforce/time-off', { employeeId: ids['1'], type: 'VACATION', startDate: day(30), endDate: day(31) })).json;
    const b = (await call(admin, 'POST', '/workforce/time-off', { employeeId: ids['2'], type: 'SICK', startDate: day(30), endDate: day(31) })).json;
    const c = (await call(admin, 'POST', '/workforce/time-off', { employeeId: ids['4'], type: 'PERSONAL', startDate: day(30), endDate: day(31) })).json;
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${b.id}/decide`, { status: 'APPROVED' })).status, 200);
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${c.id}/decide`, { status: 'REJECTED', reason: 'busy week' })).status, 200);
    const mine = new Set([a.id, b.id, c.id]);
    const got = async (qs: string) => (await call(admin, 'GET', `/workforce/time-off${qs}`)).json.filter((x: any) => mine.has(x.id)).map((x: any) => x.status).sort();
    assert.deepEqual(await got(''), ['APPROVED', 'REJECTED', 'REQUESTED']);
    assert.deepEqual(await got('?statuses=APPROVED,REJECTED'), ['APPROVED', 'REJECTED']);
    assert.deepEqual(await got('?statuses=REQUESTED'), ['REQUESTED']);
    assert.deepEqual(await got('?status=APPROVED'), ['APPROVED'], 'the single-value form still works');
    assert.equal((await call(admin, 'GET', '/workforce/time-off?statuses=BOGUS')).status, 400);
  });
});
