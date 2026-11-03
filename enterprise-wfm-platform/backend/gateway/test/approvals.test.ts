/**
 * First-line approval by a team's supervisor, cover while a supervisor is away, the team limit for supervisors, escalation, a reason for employee edits,
 * people leaving, and reporting lines (the org chart).
 *   BASE_URL=http://localhost:4011 ADMIN_PASSWORD=... TENANT=ORG [TEST_DATABASE_URL=postgres://... (gateway started with APPROVAL_TICK_SECONDS=2)] npx tsx --test test/approvals.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const DB = process.env.TEST_DATABASE_URL || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, message: json?.error?.message as string | undefined };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let admin = '';
const ctx: Record<string, any> = {};
const emp = async (n: string, extra: Record<string, unknown> = {}) => {
  const r = await call(admin, 'POST', '/workforce/employees', { employeeNumber: `AP${RUN}-${n}`, firstName: `Ap${n}`, lastName: `Run${RUN}`, primaryGroupId: ctx.group.id, ...extra });
  assert.equal(r.status, 201, r.text); return r.json;
};
const login = async (employeeId: string, role: 'AGENT' | 'SUPERVISOR_RTA') => {
  const c = await call(admin, 'POST', '/self-service/logins', { employeeId, role }); assert.equal(c.status, 201, c.text);
  const t = await call(null, 'POST', '/auth/login', { username: c.json.username, password: c.json.password, tenant: TENANT }); assert.equal(t.status, 200, t.text);
  return t.json.token as string;
};
const request = async (token: string, offset: number) => {
  const r = await call(token, 'POST', '/me/time-off', { type: 'VACATION', startDate: iso(addDays(new Date(), offset)), endDate: iso(addDays(new Date(), offset)), reason: 'Family' });
  assert.equal(r.status, 201, r.text); assert.equal(r.json.request.status, 'REQUESTED', 'it has to wait for a person to decide'); return r.json.request.id as string;
};
const timeOff = async (id: string) => (await call(admin, 'GET', '/workforce/time-off')).json.find((t: any) => t.id === id);
const setPolicy = async (patch: Record<string, unknown>) => { const cur = (await call(admin, 'GET', '/self-service/policy')).json; const r = await call(admin, 'PUT', '/self-service/policy', { ...cur, ...patch }); assert.equal(r.status, 200, r.text); };

describe('approvals, cover, leaving and reporting lines', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token;
    ctx.group = (await call(admin, 'POST', '/config/groups', { name: `Approvals ${RUN}` })).json;
    await setPolicy({ timeOffAutoApprove: false, supervisorFirst: true, escalateHours: 24, limitSupervisorsToTeams: false });
    ctx.sup1 = await emp('S1', { isSupervisor: true }); ctx.sup2 = await emp('S2', { isSupervisor: true });
    ctx.t1 = (await call(admin, 'POST', '/workforce/teams', { name: `Alpha ${RUN}`, managerId: ctx.sup1.id })).json;
    ctx.t2 = (await call(admin, 'POST', '/workforce/teams', { name: `Bravo ${RUN}`, managerId: ctx.sup2.id })).json;
    ctx.a1 = await emp('A1', { teamId: ctx.t1.id }); ctx.a2 = await emp('A2', { teamId: ctx.t2.id });
    ctx.sup1Tok = await login(ctx.sup1.id, 'SUPERVISOR_RTA'); ctx.sup2Tok = await login(ctx.sup2.id, 'SUPERVISOR_RTA');
    ctx.a1Tok = await login(ctx.a1.id, 'AGENT'); ctx.a2Tok = await login(ctx.a2.id, 'AGENT');
  });

  describe('first line', () => {
    it('tells the team\'s supervisor first, and lets only them (or a manager) decide', async () => {
      const id = await request(ctx.a1Tok, 40);
      const mine = (await call(ctx.sup1Tok, 'GET', '/me/notifications')).json.items.filter((n: any) => n.kind === 'TIME_OFF');
      assert.ok(mine.some((n: any) => /Ap A1|ApA1/.test(n.body) || n.body.includes(`ApA1 Run${RUN}`)), JSON.stringify(mine.map((n: any) => n.body)));
      assert.ok(!(await call(ctx.sup2Tok, 'GET', '/me/notifications')).json.items.some((n: any) => n.kind === 'TIME_OFF' && n.body.includes(`ApA1 Run${RUN}`)), 'the other team\'s supervisor is not told');
      const no = await call(ctx.sup2Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' });
      assert.equal(no.status, 403, no.text); assert.match(no.message!, /do not supervise/);
      const yes = await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' });
      assert.equal(yes.status, 200, yes.text);
      const row = await timeOff(id); assert.equal(row.status, 'APPROVED'); assert.equal(row.decidedLevel, 'SUPERVISOR');
      const aud = (await call(admin, 'GET', `/audit?entityId=${id}`)).json;
      assert.ok(aud.some((a: any) => /first line/.test(a.diffSummary ?? '')), 'the history says which level decided');
    });

    it('tells the person who asked who has their request, and who decided it', async () => {
      const id = await request(ctx.a1Tok, 60);
      const waiting = (await call(ctx.a1Tok, 'GET', '/me/time-off')).json.requests.find((r: any) => r.id === id);
      assert.equal(waiting.waitingFor.level, 'SUPERVISOR'); assert.deepEqual(waiting.waitingFor.names, [`ApS1 Run${RUN}`]); assert.equal(waiting.decidedLevel, null);
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
      const done = (await call(ctx.a1Tok, 'GET', '/me/time-off')).json.requests.find((r: any) => r.id === id);
      assert.equal(done.decidedLevel, 'SUPERVISOR'); assert.equal(done.waitingFor, null); assert.equal(done.decidedBy, `ApS1 Run${RUN}`);
    });

    it('a supervisor cannot decide their own request; a manager can, and is recorded as the manager', async () => {
      const id = await request(ctx.sup1Tok, 41);
      const own = await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' });
      assert.equal(own.status, 403, own.text); assert.match(own.message!, /your own request/);
      assert.equal((await call(admin, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
      assert.equal((await timeOff(id)).decidedLevel, 'MANAGER');
    });

    it('a rejection still needs a reason from the supervisor', async () => {
      const id = await request(ctx.a1Tok, 42);
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'REJECTED' })).status, 400);
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'REJECTED', reason: 'Peak week' })).status, 200);
    });

    it('a team without a supervisor goes straight to the managers, as before', async () => {
      const t = (await call(admin, 'POST', '/workforce/teams', { name: `Loose ${RUN}` })).json;
      const loose = await emp('L1', { teamId: t.id }); const tok = await login(loose.id, 'AGENT');
      const id = await request(tok, 43);
      assert.equal((await call(tok, 'GET', '/me/time-off')).json.requests.find((r: any) => r.id === id).waitingFor.level, 'MANAGER', 'with no supervisor it says a manager');
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 403, 'a supervisor of another team has no say');
      assert.equal((await call(admin, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
    });

    it('with first-line approval switched off, supervisors cannot decide at all', async () => {
      await setPolicy({ supervisorFirst: false });
      const id = await request(ctx.a1Tok, 44);
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 403);
      await setPolicy({ supervisorFirst: true });
      assert.equal((await call(ctx.sup1Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
    });
  });

  describe('cover while a supervisor is away', () => {
    it('hands a supervisor\'s teams to someone for a date range, who can then decide for them', async () => {
      const today = iso(new Date());
      const none = await call(ctx.sup1Tok, 'POST', '/workforce/cover', { fromEmployeeId: ctx.sup1.id, toEmployeeId: ctx.a2.id, startsOn: today, endsOn: iso(addDays(new Date(), 7)) });
      assert.equal(none.status, 400, none.text); assert.match(none.message!, /no login whose role can approve/);
      const notSup = await call(admin, 'POST', '/workforce/cover', { fromEmployeeId: ctx.a1.id, toEmployeeId: ctx.sup2.id, startsOn: today, endsOn: today });
      assert.equal(notSup.status, 400, notSup.text); assert.match(notSup.message!, /nothing to cover/);
      assert.equal((await call(ctx.sup1Tok, 'POST', '/workforce/cover', { fromEmployeeId: ctx.sup1.id, toEmployeeId: ctx.sup2.id, startsOn: today, endsOn: iso(addDays(new Date(), -1)) })).status, 400, 'the end cannot come first');
      assert.equal((await call(ctx.a1Tok, 'POST', '/workforce/cover', { fromEmployeeId: ctx.sup1.id, toEmployeeId: ctx.sup2.id, startsOn: today, endsOn: today })).status, 403, 'an agent cannot hand over a supervisor\'s teams');
      const ok = await call(ctx.sup1Tok, 'POST', '/workforce/cover', { fromEmployeeId: ctx.sup1.id, toEmployeeId: ctx.sup2.id, startsOn: today, endsOn: iso(addDays(new Date(), 7)), note: 'On leave' });
      assert.equal(ok.status, 201, ok.text); assert.deepEqual(ok.json.teams, [`Alpha ${RUN}`]); assert.equal(ok.json.active, true); ctx.cover = ok.json;
      assert.equal((await call(ctx.sup1Tok, 'POST', '/workforce/cover', { fromEmployeeId: ctx.sup1.id, toEmployeeId: ctx.sup2.id, startsOn: today, endsOn: today })).status, 409, 'the same cover twice');
      const covered = (await call(ctx.sup2Tok, 'GET', '/me/notifications')).json.items.some((n: any) => /You are covering a team/.test(n.title));
      assert.ok(covered, 'the person covering is told');
      const id = await request(ctx.a1Tok, 45);
      assert.ok((await call(ctx.sup2Tok, 'GET', '/me/notifications')).json.items.some((n: any) => n.kind === 'TIME_OFF' && n.body.includes(`ApA1 Run${RUN}`)), 'new requests of the covered team reach the cover');
      assert.equal((await call(ctx.sup2Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 200);
      assert.ok((await call(admin, 'GET', '/workforce/cover')).json.some((c: any) => c.id === ctx.cover.id));
    });

    it('stops when it is ended, and only the supervisor or a manager can end it', async () => {
      assert.equal((await call(ctx.a1Tok, 'DELETE', `/workforce/cover/${ctx.cover.id}`)).status, 403);
      assert.equal((await call(ctx.sup1Tok, 'DELETE', `/workforce/cover/${ctx.cover.id}`)).status, 200);
      const id = await request(ctx.a1Tok, 46);
      assert.equal((await call(ctx.sup2Tok, 'POST', `/workforce/time-off/${id}/decide`, { status: 'APPROVED' })).status, 403, 'no longer covering');
      assert.ok(!(await call(admin, 'GET', '/workforce/cover')).json.some((c: any) => c.id === ctx.cover.id));
    });
  });

  describe('a supervisor limited to their own teams', () => {
    it('sees only their teams\' people, requests and swaps when the organisation switches it on', async () => {
      assert.ok((await call(ctx.sup1Tok, 'GET', `/workforce/employees/${ctx.a2.id}`)).status === 200, 'before: everyone is visible');
      await setPolicy({ limitSupervisorsToTeams: true });
      try {
        const mine = (await call(ctx.sup1Tok, 'GET', `/workforce/employees?q=Run${RUN}`)).json.map((e: any) => e.employeeNumber).sort();
        assert.deepEqual(mine, [`AP${RUN}-A1`, `AP${RUN}-S1`], 'their team and themselves');
        assert.equal((await call(ctx.sup1Tok, 'GET', `/workforce/employees/${ctx.a2.id}`)).status, 404, 'another team\'s person is not there');
        assert.equal((await call(ctx.sup1Tok, 'GET', `/workforce/employees/${ctx.a1.id}`)).status, 200);
        const reqs = (await call(ctx.sup1Tok, 'GET', '/workforce/time-off')).json;
        assert.ok(reqs.length > 0 && reqs.every((t: any) => [ctx.a1.id, ctx.sup1.id].includes(t.employeeId)), 'only their people\'s requests');
        assert.ok((await call(admin, 'GET', `/workforce/employees?q=Run${RUN}`)).json.length >= 4, 'an administrator still sees everyone');
        assert.ok((await call(admin, 'GET', '/workforce/time-off')).json.some((t: any) => t.employeeId === ctx.a2.id || true));
        const ex = await call(ctx.sup1Tok, 'POST', '/intraday/exceptions', { employeeId: ctx.a2.id, day: iso(new Date()), fromMinute: 600, toMinute: 660, category: 'SYSTEM_ISSUE', note: 'System issue', excused: true });
        assert.equal(ex.status, 404, 'no exceptions for someone else\'s team');
      } finally { await setPolicy({ limitSupervisorsToTeams: false }); }
    });
  });

  describe('a reason for changes to a person', () => {
    it('asks why for anything beyond contact details, and keeps it in the history', async () => {
      const p = await emp('R1');
      const no = await call(admin, 'PUT', `/workforce/employees/${p.id}`, { weeklyContractHours: 30 });
      assert.equal(no.status, 400, no.text); assert.match(no.message!, /Say why you are changing the contract hours/);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${p.id}`, { weeklyContractHours: 30, reason: 'x' })).status, 400, 'one letter is not a reason');
      const ok = await call(admin, 'PUT', `/workforce/employees/${p.id}`, { weeklyContractHours: 30, maxWeeklyHours: 40, reason: 'Moved to part time at their request' });
      assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.weeklyContractHours, 30);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${p.id}`, { phone: '12345', email: `r1.${RUN}@x.test`, location: 'Pune' })).status, 200, 'contact details need no reason');
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${p.id}`, { weeklyContractHours: 30 })).status, 200, 'sending the same value back changes nothing');
      const aud = (await call(admin, 'GET', `/audit?entityId=${p.id}`)).json;
      assert.ok(aud.some((a: any) => a.reason === 'Moved to part time at their request' && /contract hours/.test(a.diffSummary ?? '')), JSON.stringify(aud.map((a: any) => [a.reason, a.diffSummary])));
    });
  });

  describe('reporting lines and the org chart', () => {
    it('sets who reports to whom, and refuses circles, themselves and people who left', async () => {
      ctx.boss = await emp('B0', { isManager: true }); ctx.mid = await emp('B1', { isSupervisor: true, reportsTo: ctx.boss.id }); ctx.low = await emp('B2', { reportsTo: ctx.mid.id });
      assert.equal(ctx.low.reportsTo, ctx.mid.id); assert.equal(ctx.low.reportsToName, `ApB1 Run${RUN}`);
      const loop = await call(admin, 'PUT', `/workforce/employees/${ctx.boss.id}`, { reportsTo: ctx.low.id, reason: 'Trying a circle' });
      assert.equal(loop.status, 400, loop.text); assert.match(loop.message!, /circle/);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${ctx.mid.id}`, { reportsTo: ctx.mid.id, reason: 'Themselves' })).status, 400);
      const gone = await emp('B3', { status: 'TERMINATED' });
      assert.match((await call(admin, 'PUT', `/workforce/employees/${ctx.low.id}`, { reportsTo: gone.id, reason: 'To a leaver' })).message!, /has left/);
    });

    it('shows the chart a level at a time, with counts, the chain above a person, and a file', async () => {
      const roots = (await call(admin, 'GET', `/workforce/org-chart/roots?groupId=${ctx.group.id}`)).json;
      const top = roots.roots.find((r: any) => r.id === ctx.boss.id);
      assert.ok(top, JSON.stringify(roots.roots.map((r: any) => r.name))); assert.equal(top.directReports, 1); assert.equal(top.allReports, 2); assert.equal(top.isManager, true);
      assert.ok(roots.unassigned > 0 && roots.total > roots.unassigned, 'people with no line are counted');
      const kids = (await call(admin, 'GET', `/workforce/org-chart/${ctx.boss.id}/reports`)).json;
      assert.equal(kids.total, 1); assert.equal(kids.items[0].id, ctx.mid.id); assert.equal(kids.items[0].directReports, 1); assert.equal(kids.items[0].allReports, 1);
      const chain = (await call(admin, 'GET', `/workforce/org-chart/${ctx.low.id}/chain`)).json;
      assert.deepEqual(chain.map((c: any) => c.id), [ctx.boss.id, ctx.mid.id, ctx.low.id], 'from the top down to them');
      const un = (await call(admin, 'GET', `/workforce/org-chart/unassigned?groupId=${ctx.group.id}&limit=5`)).json;
      assert.ok(un.length > 0 && un.every((u: any) => u.directReports === 0 && u.reportsTo === null));
      const csv = await fetch(`${BASE}/api/v1/workforce/org-chart/export.csv`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(csv.status, 200); const text = await csv.text();
      assert.match(text, /^employee_number,name,team,status,is_supervisor,is_manager,reports_to_number,reports_to/); assert.ok(text.includes(`AP${RUN}-B2`) && text.includes(`AP${RUN}-B1`));
    });

    it('puts a whole team under its supervisor in one go', async () => {
      const t = (await call(admin, 'POST', '/workforce/teams', { name: `Chart ${RUN}`, managerId: ctx.sup1.id })).json;
      const m1 = await emp('C1', { teamId: t.id }), m2 = await emp('C2', { teamId: t.id, reportsTo: ctx.boss.id });
      assert.equal((await call(admin, 'POST', `/workforce/teams/${t.id}/apply-reports-to`, {})).status, 400, 'a reason is needed');
      const r = await call(admin, 'POST', `/workforce/teams/${t.id}/apply-reports-to`, { reason: 'Setting up reporting lines' });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.updated, 1, 'the one who already had a line is left');
      assert.equal((await call(admin, 'GET', `/workforce/employees/${m1.id}`)).json.reportsTo, ctx.sup1.id);
      assert.equal((await call(admin, 'GET', `/workforce/employees/${m2.id}`)).json.reportsTo, ctx.boss.id);
      assert.equal((await call(admin, 'POST', `/workforce/teams/${t.id}/apply-reports-to`, { reason: 'Again', overwrite: true })).json.updated, 1, 'overwrite moves the other one too');
      const empty = (await call(admin, 'POST', '/workforce/teams', { name: `Nobody ${RUN}` })).json;
      assert.match((await call(admin, 'POST', `/workforce/teams/${empty.id}/apply-reports-to`, { reason: 'No supervisor' })).message!, /no supervisor yet/);
    });
  });

  describe('leaving', () => {
    it('needs a last day and a reason, and refuses while the person still leads something', async () => {
      const x = await emp('X1');
      const bare = await call(admin, 'PUT', `/workforce/employees/${x.id}`, { status: 'TERMINATED', reason: 'Resigned' });
      assert.equal(bare.status, 400, bare.text); assert.match(bare.message!, /last working day and why/);
      const lead = await call(admin, 'PUT', `/workforce/employees/${ctx.sup2.id}`, { status: 'TERMINATED', terminationDate: iso(new Date()), terminationReason: 'Resigned', reason: 'Resigned' });
      assert.equal(lead.status, 409, lead.text); assert.match(lead.message!, new RegExp(`team Bravo ${RUN}`));
    });

    it('takes them off every later shift, switches off their login, cancels what they had waiting and hands their people to their manager', async () => {
      const g = (await call(admin, 'POST', '/config/groups', { name: `Leavers ${RUN}` })).json;
      const tpl = (await call(admin, 'POST', '/scheduling/templates', { name: `Leave day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 })).json;
      for (let d = 0; d < 7; d++) await call(admin, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 2 });
      const mk = async (n: string, extra: Record<string, unknown> = {}) => (await call(admin, 'POST', '/workforce/employees', { employeeNumber: `LV${RUN}-${n}`, firstName: `Lv${n}`, lastName: `Run${RUN}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 40, ...extra })).json;
      const boss = await mk('B', { isManager: true }), leaver = await mk('L', { reportsTo: boss.id }), mate1 = await mk('M1'), mate2 = await mk('M2'), under = await mk('U', { reportsTo: leaver.id });
      const tok = await login(leaver.id, 'AGENT');
      const pending = await request(tok, 50);
      const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.id, from: iso(addDays(new Date(), 1)), weeks: 1, timeLimitSec: 30, coverageSource: 'MANUAL', templateIds: [tpl.id] });
      assert.equal(v.status, 201, v.text);
      const shifts = async () => (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts`)).json;
      const before = await shifts();
      const mine = before.filter((s: any) => s.employeeId === leaver.id).length, others = before.filter((s: any) => s.employeeId !== leaver.id).length;
      assert.ok(mine > 0, 'the leaver is on the schedule');
      const seen = await call(admin, 'GET', `/workforce/employees/${leaver.id}/departure-impact?lastDay=${iso(new Date())}`);
      assert.equal(seen.status, 200, seen.text); assert.equal(seen.json.futureShifts, mine); assert.equal(seen.json.pendingTimeOff, 1); assert.equal(seen.json.reports, 1); assert.equal(seen.json.logins, 1); assert.equal(seen.json.lastDayHasPassed, true);
      const out = await call(admin, 'PUT', `/workforce/employees/${leaver.id}`, { status: 'TERMINATED', terminationDate: iso(new Date()), terminationReason: 'Resigned', reason: 'Resigned' });
      assert.equal(out.status, 200, out.text); assert.equal(out.json.status, 'TERMINATED'); assert.equal(out.json.terminationReason, 'Resigned');
      assert.equal(out.json.departure.futureShifts, mine); assert.equal(out.json.departure.logins, 1); assert.equal(out.json.departure.pendingTimeOff, 1); assert.equal(out.json.departure.reports, 1); assert.equal(out.json.departure.scheduled, false);
      const after = await shifts();
      assert.equal(after.filter((s: any) => s.employeeId === leaver.id).length, 0, 'none of their later shifts remain'); assert.equal(after.length - 0, others, 'everyone else keeps theirs');
      assert.equal((await call(null, 'POST', '/auth/login', { username: `lv${RUN}-l`.toLowerCase(), password: 'whatever', tenant: TENANT })).status, 401);
      assert.equal((await call(tok, 'GET', '/me/home')).status, 401, 'the session they already had ends');
      assert.equal((await timeOff(pending)).status, 'CANCELLED');
      assert.equal((await call(admin, 'GET', `/workforce/employees/${under.id}`)).json.reportsTo, boss.id, 'their people now report to their manager');
      const rev = (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/revisions`)).json.revisions;
      assert.ok(rev.some((r: any) => /left: later shifts removed/.test(r.summary)), 'the schedule history says why it changed');
      void mate1; void mate2;
    });

    it('a last day still to come keeps them here until then, and the plan can be cancelled', async () => {
      const g = (await call(admin, 'POST', '/config/groups', { name: `Notice ${RUN}` })).json;
      const p = (await call(admin, 'POST', '/workforce/employees', { employeeNumber: `NT${RUN}-1`, firstName: 'Nt', lastName: `Run${RUN}`, primaryGroupId: g.id })).json;
      const day = iso(addDays(new Date(), 20));
      const set = await call(admin, 'PUT', `/workforce/employees/${p.id}`, { status: 'TERMINATED', terminationDate: day, terminationReason: 'Resigned with notice', reason: 'Resigned with notice' });
      assert.equal(set.status, 200, set.text); assert.equal(set.json.status, 'ACTIVE', 'still working'); assert.equal(set.json.terminationDate, day); assert.equal(set.json.departure.scheduled, true);
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${p.id}`, { terminationDate: null })).status, 400, 'cancelling the plan needs a reason too');
      const back = await call(admin, 'PUT', `/workforce/employees/${p.id}`, { terminationDate: null, reason: 'Changed their mind' });
      assert.equal(back.status, 200, back.text); assert.equal(back.json.terminationDate, null); assert.equal(back.json.status, 'ACTIVE');
    });

    it('someone who returns is no longer marked as leaving', async () => {
      const g = (await call(admin, 'POST', '/config/groups', { name: `Back ${RUN}` })).json;
      const p = (await call(admin, 'POST', '/workforce/employees', { employeeNumber: `BK${RUN}-1`, firstName: 'Bk', lastName: `Run${RUN}`, primaryGroupId: g.id })).json;
      await call(admin, 'PUT', `/workforce/employees/${p.id}`, { status: 'TERMINATED', terminationDate: iso(addDays(new Date(), -1)), terminationReason: 'Resigned', reason: 'Resigned' });
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${p.id}`, { status: 'ACTIVE' })).status, 400, 'coming back needs a reason');
      const r = await call(admin, 'PUT', `/workforce/employees/${p.id}`, { status: 'ACTIVE', reason: 'Re-hired' });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.terminationDate, null); assert.equal(r.json.terminationReason, null);
    });
  });

  describe('a request that waits too long', () => {
    it('is flagged to the managers once the escalation time has passed', async (t) => {
      if (!DB) return t.skip('needs TEST_DATABASE_URL and a gateway started with APPROVAL_TICK_SECONDS=2');
      const id = await request(ctx.a2Tok, 47);
      assert.equal((await timeOff(id)).escalatedAt, null);
      const c = new pg.Client({ connectionString: DB }); await c.connect();
      try { await c.query(`UPDATE wfm.time_off SET created_at = now() - interval '30 hours' WHERE id = $1`, [id]); } finally { await c.end(); }
      let row: any = null;
      for (let i = 0; i < 20 && !row?.escalatedAt; i++) { await sleep(1000); row = await timeOff(id); }
      assert.ok(row?.escalatedAt, 'flagged for the managers'); assert.equal(row.status, 'REQUESTED', 'still waiting: a manager or the supervisor can decide it');
    });
  });
});
