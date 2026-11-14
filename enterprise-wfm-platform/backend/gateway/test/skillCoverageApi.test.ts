/**
 * Skill coverage through the API: who can really be scheduled, how they are spread over levels, which groups need the skill, and the risk flag. Needs a running gateway:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/skillCoverageApi.test.ts
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

describe('skill coverage', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any;
  const skill: Record<string, any> = {};
  const list = async (thin = 3) => ((await call(admin, 'GET', `/workforce/skills?thin=${thin}`)).json as any[]);
  const row = async (k: string, thin = 3) => (await list(thin)).find((s) => s.id === skill[k].id);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Skl ${RUN}` })).json;
    assert.ok(group.id, JSON.stringify(group));
    for (const k of ['french', 'billing', 'unused']) { const r = await call(admin, 'POST', '/workforce/skills', { name: `${k} ${RUN}` }); assert.equal(r.status, 201, r.text); skill[k] = r.json; }
    const person = async (i: number, skills: { skillId: string; proficiency: number }[], status = 'ACTIVE') => {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `SK${RUN}-${i}`, firstName: `Sk${i}`, lastName: 'Person', primaryGroupId: group.id, eligibleGroupIds: [group.id], weeklyContractHours: 40, maxWeeklyHours: 48, status });
      assert.equal(r.status, 201, r.text);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${r.json.id}/skills`, { skills })).status, 200);       // skills are set on their own endpoint, not at creation
      return r.json;
    };
    // French: one active person (level 4) and one who is no longer active (level 5). Billing: five active people at levels 1, 2, 3, 3, 5.
    await person(1, [{ skillId: skill.french.id, proficiency: 4 }]);
    const gone = await person(2, [{ skillId: skill.french.id, proficiency: 5 }]);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${gone.id}`, { status: 'SUSPENDED', reason: 'test: not active' })).status, 200);
    for (const [i, lvl] of [[3, 1], [4, 2], [5, 3], [6, 3], [7, 5]]) await person(i, [{ skillId: skill.billing.id, proficiency: lvl }]);
    assert.equal((await call(admin, 'PUT', `/config/groups/${group.id}/skills`, { skills: [{ skillId: skill.french.id, minProficiency: 5 }] })).status, 200);   // the group needs French at level 5
  });

  it('counts only people who can be scheduled, and says how many more are on record', async () => {
    const f = await row('french');
    assert.equal(f.holders, 2);
    assert.equal(f.activeHolders, 1, 'the suspended person cannot take a shift');
    assert.deepEqual(f.levels, [0, 0, 0, 1, 0], 'the one active person is level 4 (the suspended level 5 is not counted)');
  });

  it('spreads the people who hold a skill over its levels', async () => {
    const b = await row('billing');
    assert.equal(b.activeHolders, 5);
    assert.deepEqual(b.levels, [1, 1, 2, 0, 1]);
    assert.equal(b.risk.level, 'OK');
  });

  it('flags a skill a group requires when nobody active is qualified for it, and names the group', async () => {
    const f = await row('french');
    assert.deepEqual(f.requiredBy.map((g: any) => [g.groupName, g.minProficiency, g.qualified]), [[group.name, 5, 0]], 'level 5 is needed and the only level 5 person is suspended');
    assert.equal(f.risk.level, 'NONE');
    assert.match(f.risk.reason, /1 person in .* has it, but below level 5, which .* requires/, 'the one active French speaker is in the group but only level 4');
    assert.equal(f.risk.fixGroupId, group.id);
  });

  it('flags a skill held by fewer people than the threshold as thin, and the threshold is the caller\'s', async () => {
    assert.equal((await row('billing', 6)).risk.level, 'THIN', 'five people is thin when the bar is six');
    assert.match((await row('billing', 6)).risk.reason, /Only 5 people can work it/);
    assert.equal((await row('billing', 5)).risk.level, 'OK');
  });

  it('says nobody holds a skill that nobody has, without raising an alarm about a group', async () => {
    const u = await row('unused');
    assert.equal(u.activeHolders, 0);
    assert.equal(u.risk.level, 'NONE');
    assert.match(u.risk.reason, /No group requires it/);
    assert.equal(u.risk.requiredByGroups, 0);
  });

  it('opens exactly these people in the employee list: active ones who hold the skill', async () => {
    const r = await call(admin, 'GET', `/workforce/employees?skillIds=${skill.billing.id}&statuses=ACTIVE&limit=50`);
    const rows = Array.isArray(r.json) ? r.json : r.json.rows ?? [];
    assert.equal(rows.length, 5);
  });
});

describe('fixing a shortfall', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', home: any, other: any, skillId = '';
  const ids: Record<string, string> = {};
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    home = (await call(admin, 'POST', '/config/groups', { name: `FixHome ${RUN}` })).json;
    other = (await call(admin, 'POST', '/config/groups', { name: `FixOther ${RUN}` })).json;
    skillId = (await call(admin, 'POST', '/workforce/skills', { name: `Amharic ${RUN}` })).json.id;
    const mk = async (key: string, group: any, level: number | null) => {
      const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `FX${RUN}-${key}`, firstName: key, lastName: 'Person', primaryGroupId: group.id, eligibleGroupIds: [group.id], weeklyContractHours: 40, maxWeeklyHours: 48 });
      assert.equal(r.status, 201, r.text); ids[key] = r.json.id;
      if (level) assert.equal((await call(admin, 'PUT', `/workforce/employees/${r.json.id}/skills`, { skills: [{ skillId, proficiency: level }] })).status, 200);
    };
    await mk('speaker5', other, 5);       // has it at level 5 but only in the other group
    await mk('speaker3', other, 3);
    await mk('low', home, 1);             // in the group, has it below the level asked for
    await mk('none', home, null);         // in the group, does not have it
    assert.equal((await call(admin, 'PUT', `/config/groups/${home.id}/skills`, { skills: [{ skillId, minProficiency: 3 }] })).status, 200);
  });
  const skillRow = async () => ((await call(admin, 'GET', '/workforce/skills?thin=1')).json as any[]).find((s) => s.id === skillId);

  it('explains why nobody is qualified, in terms of who could be added or given the skill', async () => {
    const s = await skillRow();
    assert.equal(s.holders, 3);
    assert.equal(s.risk.level, 'NONE');
    assert.match(s.risk.reason, /2 people have it at level 3 or higher but are not eligible for FixHome/, 'two speakers exist, in another group');
    assert.equal(s.risk.fixGroupId, home.id);
  });

  it('lists who could be added to the group and who in the group could be given the skill', async () => {
    const f = (await call(admin, 'GET', `/workforce/skills/${skillId}/fix?groupId=${home.id}`)).json;
    assert.equal(f.group.minProficiency, 3);
    assert.deepEqual(f.addToGroup.people.map((p: any) => [p.name, p.level, p.homeGroup]), [['speaker5 Person', 5, other.name], ['speaker3 Person', 3, other.name]]);
    assert.deepEqual(f.giveSkill.people.map((p: any) => [p.name, p.level]).sort(), [['low Person', 1], ['none Person', null]]);
    assert.equal((await call(admin, 'GET', `/workforce/skills/${skillId}/fix?groupId=${other.id}`)).status, 400, 'a group that does not require the skill has nothing to fix');
  });

  it('adds only the people who really qualify, needs a reason, and then the group has cover', async () => {
    const body = { groupId: home.id, employeeIds: [ids.speaker5, ids.speaker3, ids.low, ids.none] };
    assert.equal((await call(admin, 'POST', `/workforce/skills/${skillId}/add-to-group`, body)).status, 400, 'a reason is needed');
    const r = await call(admin, 'POST', `/workforce/skills/${skillId}/add-to-group`, { ...body, reason: 'QA: they speak it' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.updated, 2, 'the two speakers; not the one below the level, not the one without the skill');
    assert.equal(r.json.skipped, 2);
    const e = (await call(admin, 'GET', `/workforce/employees/${ids.speaker5}`)).json;
    assert.ok(e.eligibleGroupIds.includes(home.id) && e.eligibleGroupIds.includes(other.id), 'they keep their own group and gain this one');
    const s = await skillRow();
    assert.equal(s.requiredBy[0].qualified, 2);
    assert.equal(s.risk.level, 'OK', 'with a threshold of one, two qualified people is enough');
    assert.equal((await call(admin, 'POST', `/workforce/skills/${skillId}/add-to-group`, { ...body, reason: 'QA: again' })).json.updated, 0, 'doing it again changes nothing');
  });
});
