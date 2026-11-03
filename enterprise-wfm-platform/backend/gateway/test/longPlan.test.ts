/**
 * Long plans: built in the background in windows, repeated as rotation lines past the solved weeks, published a window at a time, re-solved as
 * the weeks come closer, and cancellable. Also the solver choice and the readiness view for a long range.
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test   (needs the engine running)
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

describe('long plans', () => {
  let admin = '', group: any, from = '', tplId = '';
  const tag = `P${RUN}`;
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    from = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));        // a Monday in the future
    const g = await call(admin, 'POST', '/config/groups', { name: `Plan ${tag}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); group = g.json;
    const queue = `Plan Voice ${tag}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: group.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 70) });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const sf = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, kind: 'SHORT', weeks: 4, fromDay: from });
    assert.equal(sf.status, 201, sf.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${sf.json.id}/${step}`, {})).status, 200, step);
    const lf = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, kind: 'LONG', days: 400, fromDay: from });
    assert.equal(lf.status, 201, lf.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${lf.json.id}/${step}`, {})).status, 200, step);
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Plan team ${tag}` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `Plan tpl ${tag}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '07:00', latestStart: '09:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    assert.equal(tpl.status, 201, tpl.text);
    tplId = tpl.json.id;
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= 16; i++) lines.push(`PL${tag}-${i},Agent${i},Plan${i},Plan team ${tag},Plan ${tag},FULL_TIME,40,5`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
    assert.equal(imp.status, 200, imp.text); assert.equal(imp.json.committed, true);
  });

  it('the one-shot generate route still stops at four weeks', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 5 });
    assert.equal(r.status, 400, r.text);
  });

  it('readiness for a half-year says which forecast covers each week, how sure to be, and how long it will take', async () => {
    const r = await call(admin, 'GET', `/scheduling/readiness?groupId=${group.id}&from=${from}&weeks=26&timeLimitSec=30`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.horizon.length, 26);
    assert.equal(r.json.horizon[0].source, 'SHORT');
    assert.equal(r.json.horizon[10].source, 'LONG', 'past the 4-week short forecast the long-term forecast covers it');
    assert.ok(r.json.horizon.some((h: any) => h.confidence === 'LOW'), 'far weeks are marked low confidence');
    assert.ok(r.json.estimate.seconds > 0 && r.json.estimate.windows >= 1);
    assert.match(r.json.confidenceNote, /lower/i);
  });

  it('forces a chosen solver, and reports which one answered', async () => {
    const r = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 10, solver: 'HIGHS' });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.stats.solver.backend, 'highs');
    await call(admin, 'DELETE', `/scheduling/versions/${r.json.id}`);
    const a = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 10 });
    assert.equal(a.status, 201, a.text);
    assert.equal(a.json.stats.solver.backend, 'cpsat');
    await call(admin, 'DELETE', `/scheduling/versions/${a.json.id}`);
  });

  let planned: any;
  it('builds 13 weeks in the background: 8 solved, 5 repeated as rotation lines, no rule broken, progress shown on the way', async () => {
    const r = await call(admin, 'POST', '/scheduling/jobs', { groupId: group.id, templateIds: [tplId], from, weeks: 13, solveWeeks: 8, windowWeeks: 4, timeLimitSec: 10 });
    assert.equal(r.status, 202, r.text);
    const second = await call(admin, 'POST', '/scheduling/jobs', { groupId: group.id, templateIds: [tplId], from, weeks: 13, solveWeeks: 8, timeLimitSec: 10 });
    assert.equal(second.status, 409, 'one build at a time per group');
    const { job, seen } = await waitJob(admin, r.json.id, ['DONE', 'FAILED', 'CANCELLED']);
    assert.equal(job.status, 'DONE', job.error ?? JSON.stringify(job));
    assert.ok(seen.some((n) => n > 0 && n < job.progress.total), 'progress moved while it ran');
    assert.equal(job.progress.windows.filter((w: any) => w.kind === 'SOLVED').length, 2);
    assert.equal(job.progress.windows.at(-1).kind, 'PATTERN');
    const v = await call(admin, 'GET', `/scheduling/versions/${job.versionId}`);
    assert.equal(v.status, 200, v.text);
    assert.equal(v.json.periodEnd, addIso(from, 13 * 7 - 1));
    assert.equal(v.json.status, 'DRAFT');
    assert.equal(v.json.stats.violations, 0, JSON.stringify(v.json.violations?.slice(0, 3)));
    const shifts = await call(admin, 'GET', `/scheduling/versions/${job.versionId}/shifts`);
    const bySource = new Map<string, number>();
    for (const s of shifts.json) bySource.set(s.source, (bySource.get(s.source) ?? 0) + 1);
    assert.ok((bySource.get('SOLVER') ?? 0) > 100, 'solver shifts exist');
    assert.ok((bySource.get('PATTERN') ?? 0) > 50, 'repeated shifts exist');
    const firstPattern = addIso(from, 8 * 7);
    assert.ok(shifts.json.filter((s: any) => s.source === 'PATTERN').every((s: any) => s.day >= firstPattern), 'repeats start after the solved weeks');
    planned = v.json;
  });

  it('the year view has one row per week with coverage, source, forecast, confidence and lock state', async () => {
    const r = await call(admin, 'GET', `/scheduling/versions/${planned.id}/plan`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.weeks.length, 13);
    assert.equal(r.json.weeks[0].shiftSource, 'SOLVED');
    assert.equal(r.json.weeks[12].shiftSource, 'PATTERN');
    assert.equal(r.json.weeks[0].forecast, 'SHORT');
    assert.equal(r.json.weeks[12].forecast, 'LONG');
    assert.ok(r.json.weeks.every((w: any) => w.state === 'PLANNED'));
    // the same first week generated on its own: building it as part of a plan must not cost coverage
    const alone = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 10 });
    assert.equal(alone.status, 201, alone.text);
    const first = r.json.weeks[0].coveragePercent;
    assert.ok(first >= alone.json.stats.coverage.percent - 6, `plan week 1 ${first}% vs ${alone.json.stats.coverage.percent}% on its own`);
    await call(admin, 'DELETE', `/scheduling/versions/${alone.json.id}`);
  });

  it('describes the repeated weeks as rotation lines with the people on each', async () => {
    const r = await call(admin, 'GET', `/scheduling/versions/${planned.id}/lines`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.lines.length >= 1);
    assert.equal(r.json.peopleOnLines, r.json.lines.reduce((n: number, l: any) => n + l.size, 0));
    assert.ok(r.json.lines[0].summary.length > 0);
    assert.equal(r.json.lines[0].weeks[0].days.length, 7);
    assert.ok(r.json.lines[0].people[0].name);
  });

  it('publishes the first four weeks as locked: staff see only those, the rest stays planned', async () => {
    const through = addIso(from, 4 * 7 - 1);
    const r = await call(admin, 'POST', `/scheduling/versions/${planned.id}/publish-window`, { through, acknowledgeReason: 'plan test' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'PUBLISHED');
    assert.equal(r.json.publishThrough, through);
    const view = await call(admin, 'GET', `/scheduling/versions/${planned.id}/plan`);
    assert.ok(view.json.weeks.slice(0, 4).every((w: any) => w.state === 'LOCKED'));
    assert.ok(view.json.weeks.slice(4).every((w: any) => w.state === 'PLANNED'));
    const mine = await call(admin, 'GET', `/scheduling/my-shifts?from=${from}&to=${addIso(from, 90)}`);
    if (mine.status === 200 && Array.isArray(mine.json)) assert.ok(mine.json.every((s: any) => s.day <= through), 'nothing after the published date is shown to staff');
    const again = await call(admin, 'POST', `/scheduling/versions/${planned.id}/publish-window`, { through });
    assert.equal(again.status, 409, 'cannot publish the same window twice');
  });

  it('re-solves the planned weeks on the current forecast and leaves the locked weeks exactly as they were', async () => {
    const lockedEnd = addIso(from, 4 * 7 - 1);
    const before = (await call(admin, 'GET', `/scheduling/versions/${planned.id}/shifts?to=${lockedEnd}`)).json.map((s: any) => `${s.employeeId}|${s.day}|${s.startSlot}|${s.lengthSlots}`).sort();
    const j = await call(admin, 'POST', `/scheduling/versions/${planned.id}/resolve`, { weeks: 4, timeLimitSec: 10 });
    assert.equal(j.status, 202, j.text);
    const { job } = await waitJob(admin, j.json.id, ['DONE', 'FAILED', 'CANCELLED']);
    assert.equal(job.status, 'DONE', job.error ?? JSON.stringify(job));
    const after = (await call(admin, 'GET', `/scheduling/versions/${planned.id}/shifts?to=${lockedEnd}`)).json.map((s: any) => `${s.employeeId}|${s.day}|${s.startSlot}|${s.lengthSlots}`).sort();
    assert.deepEqual(after, before, 'locked weeks did not change');
    const resolved = job.progress.windows.find((w: any) => w.kind === 'SOLVED');
    assert.equal(resolved.from, addIso(from, 4 * 7), 're-solving starts the day after the locked window');
    const v = await call(admin, 'GET', `/scheduling/versions/${planned.id}`);
    assert.equal(v.json.stats.violations, 0);
    assert.equal(v.json.hasChanges, false, 're-solving planned weeks does not mark the published weeks as changed');
  });

  it('a schedule published in full cannot be re-solved', async () => {
    const full = await call(admin, 'POST', `/scheduling/versions/${planned.id}/publish-window`, { through: planned.periodEnd, acknowledgeReason: 'plan test' });
    assert.equal(full.status, 200, full.text);
    assert.equal(full.json.publishThrough, null);
    const j = await call(admin, 'POST', `/scheduling/versions/${planned.id}/resolve`, { weeks: 2 });
    assert.equal(j.status, 202, j.text);
    const { job } = await waitJob(admin, j.json.id, ['DONE', 'FAILED', 'CANCELLED']);
    assert.equal(job.status, 'FAILED');
    assert.match(job.error, /published in full/i);
  });

  it('stress-tests a schedule against random call arrivals: more absence means worse service, and bad days are worse than the average', async () => {
    const day = addIso(from, 1);
    const calm = await call(admin, 'POST', `/scheduling/versions/${planned.id}/simulate`, { from: day, days: 2, replications: 20, volumeCv: 0.1, absencePercent: 0, seed: 7 });
    assert.equal(calm.status, 200, calm.text);
    assert.equal(calm.json.days.length, 2);
    assert.equal(calm.json.intervals.length, 192);
    assert.ok(calm.json.overall.serviceLevel > 0 && calm.json.overall.serviceLevel <= 1);
    assert.ok(calm.json.days[0].badDayServiceLevel <= calm.json.days[0].serviceLevel, 'the 10th percentile is no better than the mean');
    assert.ok(calm.json.overall.offered > 0 && calm.json.intervals.some((i: any) => i.agents > 0));
    const sick = await call(admin, 'POST', `/scheduling/versions/${planned.id}/simulate`, { from: day, days: 2, replications: 20, volumeCv: 0.1, absencePercent: 35, seed: 7 });
    assert.equal(sick.status, 200, sick.text);
    assert.ok(sick.json.overall.serviceLevel < calm.json.overall.serviceLevel, `${sick.json.overall.serviceLevel} should be below ${calm.json.overall.serviceLevel}`);
    assert.ok(sick.json.overall.abandon >= calm.json.overall.abandon);
    const again = await call(admin, 'POST', `/scheduling/versions/${planned.id}/simulate`, { from: day, days: 2, replications: 20, volumeCv: 0.1, absencePercent: 0, seed: 7 });
    assert.equal(again.json.overall.serviceLevel, calm.json.overall.serviceLevel, 'same seed, same answer');
    const far = await call(admin, 'POST', `/scheduling/versions/${planned.id}/simulate`, { from: addIso(from, 80), days: 1 });
    assert.equal(far.status, 400, 'a day the short-term forecast does not reach cannot be simulated');
    assert.match(far.json.error?.message ?? far.text, /no call volume/i);
  });

  it('splits a group too big for one solve into parts that each get their share of the demand, with every rule still kept', async () => {
    const whole = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 15 });
    assert.equal(whole.status, 201, whole.text);
    const split = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, templateIds: [tplId], from, weeks: 1, timeLimitSec: 15, splitAbove: 500 });
    assert.equal(split.status, 201, split.text);
    const parts = split.json.stats.solver.parts as number[];
    assert.ok(parts && parts.length >= 2, `expected a split, got ${JSON.stringify(parts)}`);
    assert.equal(parts.reduce((a, b) => a + b, 0), split.json.stats.solver.people, 'every person is in exactly one part');
    assert.equal(whole.json.stats.solver.parts, null, 'a group that fits is solved whole');
    assert.equal(split.json.stats.violations, 0, JSON.stringify(split.json.violations?.slice(0, 2)));
    assert.ok(split.json.stats.coverage.percent >= whole.json.stats.coverage.percent - 15, `split ${split.json.stats.coverage.percent}% vs whole ${whole.json.stats.coverage.percent}%`);
    const rep = await call(admin, 'GET', `/scheduling/versions/${split.json.id}/report`);
    assert.ok(JSON.stringify(rep.json).includes('solved in parts'), 'the report says so');
    await call(admin, 'DELETE', `/scheduling/versions/${whole.json.id}`);
    await call(admin, 'DELETE', `/scheduling/versions/${split.json.id}`);
  });

  it('cancel stops a running build inside the engine and leaves no half-built schedule behind', async () => {
    const before = (await call(admin, 'GET', `/scheduling/versions?groupId=${group.id}`)).json.length;
    const r = await call(admin, 'POST', '/scheduling/jobs', { groupId: group.id, templateIds: [tplId], from: addIso(from, 140), weeks: 26, solveWeeks: 24, windowWeeks: 4, timeLimitSec: 60, name: `cancel me ${tag}` });
    assert.equal(r.status, 202, r.text);
    await waitJob(admin, r.json.id, ['RUNNING'], 60_000);
    await sleep(2500);
    const c = await call(admin, 'POST', `/scheduling/jobs/${r.json.id}/cancel`, {});
    assert.equal(c.status, 200, c.text);
    const { job } = await waitJob(admin, r.json.id, ['CANCELLED', 'DONE', 'FAILED'], 60_000);
    assert.equal(job.status, 'CANCELLED', job.error ?? JSON.stringify(job.progress));
    const after = (await call(admin, 'GET', `/scheduling/versions?groupId=${group.id}`)).json;
    assert.equal(after.length, before, 'no partial schedule is kept');
    assert.ok(!after.some((v: any) => v.name === `cancel me ${tag}`));
  });
});
