/**
 * 'Days off together', end to end: the company-wide setting, a person's own setting and bulk edit are saved and read back; a generated two-week schedule gives
 * everyone two days off side by side in each week with no rule broken; a hand edit that splits the days off is reported.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test-force-exit --test test/daysOffTogetherApi.test.ts   (needs the engine running)
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addIso = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));

function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

const PEOPLE = 12, LIMIT = 8;
describe('days off together, end to end', { skip: !PASSWORD }, () => {
  let admin = '', group: any, from = '', tplId = '', versionId = '';
  const tag = `D${RUN}`;
  const people: any[] = [];
  const policy = async (minDaysOffTogether: number | null | undefined) => {
    const cur = (await call(admin, 'GET', '/config/scheduling-policy')).json;
    const { minDaysOffTogether: _drop, ...rest } = cur;
    return call(admin, 'PUT', '/config/scheduling-policy', minDaysOffTogether === undefined ? rest : { ...rest, minDaysOffTogether });
  };
  const shiftsOf = async () => (await call(admin, 'GET', `/scheduling/versions/${versionId}/shifts?from=${from}&to=${addIso(from, 13)}`)).json as any[];

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
    const g = await call(admin, 'POST', '/config/groups', { name: `Off ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); group = g.json;
    const queue = `Off Voice ${tag}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: group.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    for (const body of [{ kind: 'SHORT', weeks: 8, fromDay: from }, { kind: 'LONG', days: 120, fromDay: from }]) {
      const f = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, ...body });
      assert.equal(f.status, 201, f.text);
      for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${step}`, {})).status, 200, step);
    }
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Off team ${tag}` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `Off tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    assert.equal(tpl.status, 201, tpl.text); tplId = tpl.json.id;
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= PEOPLE; i++) lines.push(`OG${tag}-${i},Agent${i},Off${i},Off team ${tag},Off ${tag},FULL_TIME,40,5`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(String.fromCharCode(10)), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    const all = (await call(admin, 'GET', `/workforce/employees?groupId=${group.id}&limit=500`)).json;
    for (const e of (all.items ?? all.employees ?? all)) if (String(e.employeeNumber).startsWith(`OG${tag}-`)) people.push(e);
    assert.equal(people.length, PEOPLE);
  });

  it('a person starts with no rule, and the setting can be changed and read back', async () => {
    assert.equal(people[0].minDaysOffTogether ?? 0, 0);
    const u = await call(admin, 'PUT', `/workforce/employees/${people[0].id}`, { minDaysOffTogether: 2, reason: 'Two days together' });
    assert.equal(u.status, 200, u.text); assert.equal(u.json.minDaysOffTogether, 2);
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${people[0].id}`, { minDaysOffTogether: 4, reason: 'Too many' })).status, 400, 'a week cannot hold more than 3 as a rule');
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${people[0].id}`, { minDaysOffTogether: 0, reason: 'Back to none' })).json.minDaysOffTogether, 0);
  });

  it('bulk edit sets it for many people at once', async () => {
    const ids = people.slice(0, 3).map((p) => p.id);
    const b = await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { minDaysOffTogether: 2 }, reason: 'Weekend rule' });
    assert.equal(b.status, 200, b.text);
    for (const id of ids) assert.equal((await call(admin, 'GET', `/workforce/employees/${id}`)).json.minDaysOffTogether, 2);
    await call(admin, 'POST', '/workforce/employees/bulk', { ids, changes: { minDaysOffTogether: 0 }, reason: 'Undo' });
  });

  it('the company-wide setting is saved, can be cleared, and an older client that leaves it out changes nothing', async () => {
    assert.equal((await policy(2)).json.minDaysOffTogether, 2);
    assert.equal((await call(admin, 'GET', '/config/scheduling-policy')).json.minDaysOffTogether, 2);
    assert.equal((await policy(undefined)).json.minDaysOffTogether, 2, 'left out: kept');
    assert.equal((await policy(4)).status, 400);
    assert.equal((await policy(null)).json.minDaysOffTogether, null, 'cleared');
  });

  it('a generated two-week schedule gives everyone two days off side by side in each week, and breaks no rule', async () => {
    assert.equal((await policy(2)).status, 200);
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 2, timeLimitSec: LIMIT });
    assert.equal(r.status, 201, r.text); versionId = r.json.id;
    const v = (await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json;
    assert.equal(v.stats.violations, 0, JSON.stringify((v.violations ?? []).slice(0, 3)));
    assert.ok(v.stats.shifts >= PEOPLE * 8, `people still work: ${v.stats.shifts} shifts`);
    const byPerson = new Map<string, Set<string>>();
    for (const s of await shiftsOf()) byPerson.set(s.employeeId, (byPerson.get(s.employeeId) ?? new Set()).add(s.day));
    assert.equal(byPerson.size, PEOPLE);
    for (const [id, worked] of byPerson) for (const w of [0, 1]) {
      let best = 0, run = 0;
      for (let k = 0; k < 7; k++) { run = worked.has(addIso(from, w * 7 + k)) ? 0 : run + 1; best = Math.max(best, run); }
      assert.ok(best >= 2, `${id} week ${w + 1}: longest run of days off is ${best}`);
    }
  });

  it('a hand edit that splits the days off is reported', async () => {
    const shifts = await shiftsOf();
    const who = people[0].id;
    const mine = shifts.filter((s) => s.employeeId === who);
    const have = new Set(mine.map((s) => s.day));
    const wed = addIso(from, 2);
    const template = mine[0];
    // work every day of the first week except the Wednesday, so the days off are never side by side
    for (let k = 0; k < 7; k++) {
      const d = addIso(from, k);
      if (d === wed || have.has(d)) continue;
      const a = await call(admin, 'POST', `/scheduling/versions/${versionId}/shifts`, { employeeId: who, day: d, templateId: template.templateId, startTime: `${String(Math.floor(template.startSlot / 4)).padStart(2, '0')}:${String((template.startSlot % 4) * 15).padStart(2, '0')}`, reason: 'Test: work the whole week' });
      assert.ok([200, 201].includes(a.status), `${d}: ${a.text}`);
    }
    const onWed = mine.find((s) => s.day === wed);
    if (onWed) assert.equal((await call(admin, 'DELETE', `/scheduling/versions/${versionId}/shifts/${onWed.id}?reason=Test%20day%20off`)).status < 300, true);
    const v = (await call(admin, 'GET', `/scheduling/versions/${versionId}`)).json;
    const text = JSON.stringify(v.violations ?? []);
    assert.match(text, /DAYS_OFF_TOGETHER/, `the split week is reported: ${text.slice(0, 300)}`);
  });

  it('clears the setting afterwards so other tests start from no rule', async () => {
    assert.equal((await policy(null)).json.minDaysOffTogether, null);
    if (versionId) await call(admin, 'DELETE', `/scheduling/versions/${versionId}`);
  });
});
