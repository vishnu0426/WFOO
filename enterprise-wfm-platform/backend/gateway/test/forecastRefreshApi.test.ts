/**
 * Scheduled forecast refresh through the API: settings, run now, the accuracy report and the comparison with the live forecast, skipping on stale data, replacing untouched drafts, the
 * scheduler picking up what is due, and who may do what. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/forecastRefreshApi.test.ts
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
const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
/** `days` of history ending `endDaysAgo` days before today (1 = yesterday). */
function historyCsv(queue: string, days: number, endDaysAgo = 1) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 5 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days + endDaysAgo - 1; n >= endDaysAgo; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}

describe('scheduled forecast refresh', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', analyst = '', A: any, B: any, live: any;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const step = (id: string, s: string) => call(admin, 'POST', `/forecast/versions/${id}/${s}`, {});
  const settings = (over: any = {}) => ({ enabled: true, frequency: 'WEEKLY', dayOfWeek: 0, hour: 6, horizonWeeks: null, horizonDays: null, staleAfterDays: 3, archiveOldDrafts: true, ...over });
  const versions = async (g: any) => (await call(admin, 'GET', `/forecast/versions?groupId=${g.id}`)).json as any[];
  const runs = async (g: any) => (await call(admin, 'GET', `/forecast/refresh/${g.id}/SHORT/runs`)).json as any[];
  /** Wait for the run that was just started to finish (the engine takes a few seconds). */
  async function finished(g: any, runId: string, ms = 150_000) {
    const end = Date.now() + ms;
    for (;;) {
      const r = (await runs(g)).find((x) => x.id === runId);
      if (r && r.status !== 'RUNNING') return r;
      if (Date.now() > end) throw new Error(`run ${runId} did not finish: ${r?.status}`);
      await new Promise((ok) => setTimeout(ok, 1000));
    }
  }
  const runNow = async (g: any) => { const r = await call(admin, 'POST', `/forecast/refresh/${g.id}/SHORT/run`); assert.equal(r.status, 202, r.text); return finished(g, r.json.runId); };

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    const mk = async (name: string, endDaysAgo: number) => {
      const g = (await call(admin, 'POST', '/config/groups', { name: `${name} ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
      const q = (await call(admin, 'POST', '/config/queues', { name: `${name} Q ${RUN}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56, endDaysAgo) });
      assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
      return g;
    };
    A = await mk('RFA', 1); B = await mk('RFB', 20);                              // B's newest data is 20 days old
    // A's live forecast started ten days ago, so there are finished days to measure it on
    live = (await call(admin, 'POST', '/forecast/versions', { groupId: A.id, kind: 'SHORT', weeks: 3, fromDay: iso(addDays(today, -10)) })).json;
    for (const s of ['submit', 'approve', 'publish']) assert.equal((await step(live.id, s)).status, 200, s);
    await call(admin, 'POST', '/users', { username: `rfview${RUN}`, displayName: 'Viewer', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
    analyst = (await call(null, 'POST', '/auth/login', { username: `rfview${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
  });

  it('starts with sensible defaults (off), the live forecast, and nothing run yet', async () => {
    const r = (await call(admin, 'GET', `/forecast/refresh?groupId=${A.id}`)).json;
    const s = r.items.find((x: any) => x.kind === 'SHORT'), l = r.items.find((x: any) => x.kind === 'LONG');
    assert.deepEqual([s.enabled, s.saved, s.frequency, s.dayOfWeek, s.hour, s.staleAfterDays, s.archiveOldDrafts], [false, false, 'WEEKLY', 0, 6, 3, true]);
    assert.equal(s.live.id, live.id); assert.equal(s.lastRun, null); assert.equal(s.nextRun, null, 'nothing is due while it is off'); assert.equal(l.live, null);
  });

  it('saves a schedule and says in words when it runs; refuses nonsense; only people who can create forecasts may change it', async () => {
    const r = await call(admin, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings());
    assert.equal(r.status, 200, r.text); assert.equal(r.json.description, 'every Monday at 06:00'); assert.equal(r.json.saved, true); assert.ok(r.json.nextRun.text);
    assert.equal((await call(admin, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings({ hour: 25 }))).status, 400);
    assert.equal((await call(admin, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings({ frequency: 'MONTHLY' }))).status, 400);
    assert.equal((await call(admin, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings({ horizonWeeks: 40 }))).status, 400);
    assert.equal((await call(admin, 'PUT', '/forecast/refresh/00000000-0000-4000-8000-000000000000/SHORT', settings())).status, 404);
    assert.equal((await call(analyst, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings())).status, 403);
    assert.equal((await call(analyst, 'POST', `/forecast/refresh/${A.id}/SHORT/run`)).status, 403);
    assert.equal((await call(analyst, 'GET', `/forecast/refresh?groupId=${A.id}`)).status, 200, 'anyone who can read forecasts can see the schedule');
    const all = (await call(admin, 'GET', '/forecast/refresh')).json.schedules;
    assert.ok(all.some((x: any) => x.groupId === A.id && x.kind === 'SHORT' && x.enabled), 'and it shows in the list of schedules');
  });

  let firstDraft: any;
  it('a run makes a draft, measures how the live forecast did, compares them, and tells the approvers', async () => {
    const run = await runNow(A);
    assert.equal(run.status, 'CREATED', JSON.stringify(run));
    assert.equal(run.trigger, 'MANUAL'); assert.ok(run.versionId);
    const rep = run.report;
    assert.equal(rep.freshness.ok, true); assert.equal(rep.live.id, live.id);
    assert.ok(rep.accuracy && rep.accuracy.latestWeek && typeof rep.accuracy.latestWeek.wapeDaily === 'number', `accuracy: ${JSON.stringify(rep.accuracy)}`);
    assert.ok(['GOOD', 'CHECK', 'POOR'].includes(rep.accuracy.status));
    assert.equal(rep.compare.baseVersion, `v${live.seq}`); assert.ok(rep.compare.days > 0); assert.equal(typeof rep.compare.deltaPct, 'number');
    assert.ok(rep.notified >= 1, 'the people who approve forecasts were told');
    firstDraft = (await versions(A)).find((v) => v.id === run.versionId);
    assert.equal(firstDraft.status, 'DRAFT'); assert.equal(firstDraft.createdBy, 'Auto-refresh'); assert.match(firstDraft.name, /auto refresh/);
    assert.equal((await versions(A)).find((v) => v.id === live.id).status, 'PUBLISHED', 'the live forecast is untouched: a person publishes the draft');
    const days = (Date.parse(firstDraft.toDay) - Date.parse(firstDraft.fromDay)) / 864e5 + 1;
    assert.equal(days, 21, 'it is as long as the live forecast (three weeks)');
  });

  it('the next run replaces an earlier automatic draft nobody touched, and reports against the run before', async () => {
    const run = await runNow(A);
    assert.equal(run.status, 'CREATED', JSON.stringify(run));
    assert.equal(run.report.archivedDrafts, 1);
    const vs = await versions(A);
    assert.equal(vs.find((v) => v.id === firstDraft.id).status, 'ARCHIVED'); assert.equal(vs.find((v) => v.id === run.versionId).status, 'DRAFT');
    assert.equal(typeof run.report.previousWape, 'number', 'the report can say whether the accuracy improved');
  });

  it('never archives a draft somebody has worked on', async () => {
    const mine = (await versions(A)).find((v) => v.createdBy === 'Auto-refresh' && v.status === 'DRAFT');
    const adj = await call(admin, 'PATCH', `/forecast/versions/${mine.id}/adjustments`, { mode: 'pct', value: 10, from: iso(today), to: iso(today), reason: 'campaign' });
    assert.equal(adj.status, 200, adj.text);
    const run = await runNow(A);
    assert.equal(run.status, 'CREATED'); assert.equal(run.report.archivedDrafts, 0);
    assert.equal((await versions(A)).find((v) => v.id === mine.id).status, 'DRAFT', 'the adjusted draft is still there');
  });

  it('skips, and says why, when the newest data is too old; nothing is made and the approvers are told', async () => {
    await call(admin, 'PUT', `/forecast/refresh/${B.id}/SHORT`, settings());
    const before = (await versions(B)).length;
    const run = await runNow(B);
    assert.equal(run.status, 'SKIPPED'); assert.match(run.reason, /20 days old.*more than the 3 allowed.*data feed/);
    assert.equal(run.report.freshness.ok, false); assert.equal(run.report.freshness.ageDays, 20); assert.ok(run.report.notified >= 1);
    assert.equal((await versions(B)).length, before, 'no draft was made');
    await call(admin, 'PUT', `/forecast/refresh/${B.id}/SHORT`, settings({ staleAfterDays: 30 }));          // with a looser limit it is fresh enough
    const again = await runNow(B);
    assert.equal(again.status, 'CREATED', JSON.stringify(again)); assert.equal(again.report.live, null, 'a forecast with nothing live yet still gets a first draft');
    assert.equal(again.report.compare, null);
  });

  it('refuses a second run while one is going', async () => {
    const [a, b] = await Promise.all([call(admin, 'POST', `/forecast/refresh/${A.id}/SHORT/run`), call(admin, 'POST', `/forecast/refresh/${A.id}/SHORT/run`)]);
    const codes = [a.status, b.status].sort();
    assert.deepEqual(codes, [202, 409], `${a.text} / ${b.text}`);
    await finished(A, (a.status === 202 ? a : b).json.runId);
  });

  it('the scheduler starts what is due, once per occasion, and leaves a switched-off schedule alone', async () => {
    const dow = (new Date().getUTCDay() + 6) % 7;
    await call(admin, 'PUT', `/forecast/refresh/${A.id}/SHORT`, settings({ frequency: 'WEEKLY', dayOfWeek: dow, hour: 0 }));      // today, from midnight: due now
    await call(admin, 'PUT', `/forecast/refresh/${B.id}/SHORT`, settings({ enabled: false }));
    const first = await call(admin, 'POST', '/forecast/refresh/run-due');
    assert.equal(first.status, 202); assert.equal(first.json.due, 1, 'A is due, B is off');
    let scheduled: any;
    for (const end = Date.now() + 150_000; Date.now() < end;) { scheduled = (await runs(A)).find((r) => r.trigger === 'SCHEDULE'); if (scheduled && scheduled.status !== 'RUNNING') break; await new Promise((ok) => setTimeout(ok, 1000)); }
    assert.equal(scheduled.status, 'CREATED', JSON.stringify(scheduled)); assert.equal(scheduled.startedBy, 'Auto-refresh');
    assert.equal((await call(admin, 'POST', '/forecast/refresh/run-due')).json.due, 0, 'it ran today, so it is not due again');
    const s = (await call(admin, 'GET', `/forecast/refresh?groupId=${A.id}`)).json.items.find((x: any) => x.kind === 'SHORT');
    assert.equal(s.lastRun.status, 'CREATED'); assert.match(s.nextRun.text, /at 00:00/);
  });

  it('keeps the history of runs, newest first, with their reports', async () => {
    const list = await runs(A);
    assert.ok(list.length >= 4); assert.ok(list.every((r, i) => i === 0 || list[i - 1].startedAt >= r.startedAt));
    assert.ok(list.some((r) => r.status === 'CREATED' && r.report.compare) && list.every((r) => r.status !== 'RUNNING'));
    assert.equal((await call(analyst, 'GET', `/forecast/refresh/${A.id}/SHORT/runs`)).status, 200);
  });
});
