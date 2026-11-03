/**
 * Very large groups: a sample of each kind of person is solved and everyone else takes the roster of one of their own kind (representatives.ts). Run here with a small
 * threshold so a 240-person group goes down that path. Checks that everyone is scheduled, no rule is broken, approved time off is respected for the people who copied a
 * roster, and cover is close to what solving every person gives.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/representativeSchedule.test.ts   (needs the engine running)
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addIso = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

async function waitJob(admin: string, id: string, until: string[], maxMs = 8 * 60_000) {
  const t0 = Date.now(); let last: any = null; const seen: number[] = [];
  while (Date.now() - t0 < maxMs) {
    const r = await call(admin, 'GET', `/scheduling/jobs/${id}`);
    assert.equal(r.status, 200, r.text);
    last = r.json; seen.push(last.progress?.done ?? 0);
    if (until.includes(last.status)) return { job: last, seen };
    await sleep(1500);
  }
  assert.fail(`job did not reach ${until.join('/')} in time: ${JSON.stringify(last)}`);
}

const FULL = 200, PART = 40;
describe('a large group is scheduled through representatives', { skip: !PASSWORD }, () => {
  let admin = '', group: any, from = '', tplId = '';
  const tag = `V${RUN}`;
  const timeOff: { id: string; day: string }[] = [];
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
    const g = await call(admin, 'POST', '/config/groups', { name: `Rep ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    group = g.json;
    const queue = `Rep Voice ${tag}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: group.id, ahtDefault: 300 })).status, 201);
    const csv = historyCsv(queue, 70).split(String.fromCharCode(10)).map((line, i) => { if (!i) return line; const f = line.split(','); f[3] = String(Math.round(Number(f[3]) * (FULL + PART) / 16)); return f.join(','); }).join(String.fromCharCode(10));
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const sf = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, kind: 'SHORT', weeks: 4, fromDay: from });
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${sf.json.id}/${step}`, {})).status, 200, step);
    for (let t = 0; t < 4; t++) assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Rep team ${tag} ${t}` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `Rep tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    tplId = tpl.json.id;
    const nl = String.fromCharCode(10);
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= FULL; i++) lines.push(`RP${tag}-${i},Agent${i},Rep${i},Rep team ${tag} ${i % 4},Rep ${tag},FULL_TIME,40,5`);
    for (let i = 1; i <= PART; i++) lines.push(`RQ${tag}-${i},Part${i},Rep${i},Rep team ${tag} ${i % 4},Rep ${tag},PART_TIME,20,5`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join(nl), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    // approved time off for ten full-timers on the second Wednesday after the start
    const emps = (await call(admin, 'GET', `/workforce/employees?groupId=${group.id}&status=ACTIVE&limit=1000`)).json as any[];
    const day = addIso(from, 2);
    for (const e of emps.filter((x) => x.employeeNumber.startsWith('RP')).slice(0, 10)) {
      assert.equal((await call(admin, 'POST', '/workforce/time-off', { employeeId: e.id, type: 'VACATION', startDate: day, endDate: day, approve: true })).status, 201);
      timeOff.push({ id: e.id, day });
    }
  });

  const build = async (extra: object) => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 20, ...extra });
    assert.equal(r.status, 201, r.text); return r.json;
  };

  it('schedules everyone, breaks no rule, honours time off, and covers about as well as solving every person', async () => {
    const whole = await build({});
    const viaReps = await build({ representativesAbove: 100, representativeCount: 60 });
    assert.equal(viaReps.stats.violations, 0, 'no rule is broken');
    assert.equal(viaReps.stats.people, FULL + PART, 'everyone is in the schedule');
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${viaReps.id}/shifts`)).json as any[];
    for (const t of timeOff) assert.ok(!shifts.some((s) => s.employeeId === t.id && s.day === t.day), 'someone on approved time off was not given a shift that day');
    const perPerson = new Map<string, number>(); shifts.forEach((s) => perPerson.set(s.employeeId, (perPerson.get(s.employeeId) ?? 0) + 1));
    assert.ok([...perPerson.values()].every((n) => n <= 5), 'nobody works more than their five days');
    assert.ok(perPerson.size >= (FULL + PART) * 0.97, `almost everyone has shifts (${perPerson.size} of ${FULL + PART})`);
    assert.ok(viaReps.stats.coverage.percent >= whole.stats.coverage.percent - 8, `cover ${viaReps.stats.coverage.percent}% against ${whole.stats.coverage.percent}% when every person is solved`);
    const rep = (await call(admin, 'GET', `/scheduling/versions/${viaReps.id}/report`)).json;
    assert.ok(JSON.stringify(rep).includes('REPRESENTATIVES'), 'the report says a sample was solved');
    assert.ok(!JSON.stringify((await call(admin, 'GET', `/scheduling/versions/${whole.id}/report`)).json).includes('REPRESENTATIVES'), 'a group under the threshold is solved person by person');
    for (const v of [whole, viaReps]) await call(admin, 'DELETE', `/scheduling/versions/${v.id}`);
  });
});
