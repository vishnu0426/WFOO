/**
 * Adherence for big groups: summary, paged list with server-side filters, one person's timeline, CSV, "my teams", history, supervisor alerts, saved views.
 *   DATABASE_URL=... BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG ADHERENCE_WATCH_SEC=5 npx tsx --test test/adherenceScale.test.ts
 * Needs a running gateway started with ADHERENCE_WATCH_SEC=5 (the alert test waits for the watcher) and DATABASE_URL to seed people, a schedule and events directly.
 * Everyone is on shift all day (00:00 to 24:00 UTC) so the result does not depend on when the suite runs, except just after midnight (it then skips the ones that need time to pass).
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, total: r.headers.get('X-Total-Count') };
};

describe('adherence at scale', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = ''; let groupId = ''; let tenantId = ''; let adminUserId = '';
  const db = () => new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' });
  const sql = async (text: string, params: unknown[] = []) => { const c = db(); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };
  const TX = `MF X ${RUN}`, TY = `MF Y ${RUN}`, TZ = `MF Z ${RUN}`;
  const TAG: Record<string, string> = { [TX]: 'X', [TY]: 'Y', [TZ]: 'Z', '': 'N' };      // what each team's people are numbered with
  let today = '', yesterday = '', minuteNow = 0;
  const qs = (o: Record<string, string | string[] | number | undefined>) => Object.entries(o).filter(([, v]) => v !== undefined).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => `${k}=${encodeURIComponent(x)}`) : [`${k}=${encodeURIComponent(String(v))}`])).join('&');
  const agents = (o: Record<string, any> = {}) => call(admin, 'GET', `/intraday/adherence/agents?${qs({ groupId, ...o })}`);

  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT })).json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Adh ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text); groupId = g.json.id;
    const mk = async (name: string, category: string, countsAsWork: boolean) => (await call(admin, 'POST', '/config/activities', { name: `${name} ${RUN}`, category, countsAsWork, paid: true, shrinkage: false, color: '#DCEBFA' })).json;
    const work = await mk('Work', 'WORK', true), brk = await mk('Break', 'BREAK', false);
    const AV = `Available ${RUN}`, NR = `Not Ready ${RUN}`, ODD = `Odd ${RUN}`;
    assert.equal((await call(admin, 'POST', '/intraday/state-map', { state: AV, reason: '', activityId: work.id })).status, 201);
    assert.equal((await call(admin, 'POST', '/intraday/state-map', { state: NR, reason: '', activityId: brk.id })).status, 201);
    const d = (await sql(`SELECT (now() AT TIME ZONE 'UTC')::date::text AS today, ((now() AT TIME ZONE 'UTC')::date - 1)::text AS yesterday, (extract(hour FROM now() AT TIME ZONE 'UTC') * 60 + extract(minute FROM now() AT TIME ZONE 'UTC'))::int AS m`))[0];
    today = d.today; yesterday = d.yesterday; minuteNow = d.m;
    tenantId = (await sql('SELECT id FROM tenants LIMIT 1'))[0].id;
    await sql('DELETE FROM adherence_settings WHERE tenant_id = $1', [tenantId]);          // a repeated run starts from the defaults
    adminUserId = (await sql(`SELECT id FROM users WHERE username = $1 AND tenant_id = $2`, [process.env.ADMIN_USER || 'admin', tenantId]))[0].id;
    // 3 teams: X all fine, Y on a break (out of adherence), Z in a state nobody mapped; and 5 people with no team
    await sql('UPDATE users SET employee_id = NULL WHERE id = $1', [adminUserId]);          // and manages no team
    await sql("DELETE FROM notifications WHERE user_id = $1 AND title LIKE '%out of adherence%'", [adminUserId]);     // earlier runs' messages
    for (const n of [TX, TY, TZ]) await sql('INSERT INTO teams (tenant_id, name, code) VALUES ($1, $2, $3)', [tenantId, n, n.replace(/\W/g, '').slice(0, 25)]);
    const plan: [string, number, string][] = [[TX, 10, AV], [TY, 10, NR], [TZ, 5, ODD], ['', 5, AV]];
    for (const [team, n, state] of plan) {
      await sql(`INSERT INTO employees (tenant_id, employee_number, first_name, last_name, primary_group_id, eligible_group_ids, team_id)
        SELECT $1, 'A${RUN}-' || $2 || '-' || i, $2 || i, 'Adh${RUN}', $3, ARRAY[$3]::uuid[], (SELECT id FROM teams WHERE tenant_id = $1 AND name = $4) FROM generate_series(1, $5) i`, [tenantId, TAG[team], groupId, team || null, n]);
      const tag = TAG[team];
      for (const day of [today, yesterday]) {
        // a state at five past midnight, and (for today) another a minute ago so the watcher sees live data
        await sql(`INSERT INTO agent_state_events (tenant_id, employee_id, state, reason, at) SELECT $1, e.id, $3, '', ($2::date::timestamp AT TIME ZONE 'UTC') + interval '5 minutes' FROM employees e WHERE e.employee_number LIKE 'A${RUN}-' || $4 || '-%'`, [tenantId, day, state, tag]);
      }
      await sql(`INSERT INTO agent_state_events (tenant_id, employee_id, state, reason, at) SELECT $1, e.id, $2, '', now() - interval '1 minute' FROM employees e WHERE e.employee_number LIKE 'A${RUN}-' || $3 || '-%'`, [tenantId, state, tag]);
    }
    const v = (await sql(`INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, status, period_start, period_end) VALUES ($1, $2, 1, 'adh', 'DRAFT', $3::date, $4::date) RETURNING id`, [tenantId, groupId, yesterday, today]))[0].id;
    for (const day of [today, yesterday]) await sql(`INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, start_slot, length_slots) SELECT $1, $2, e.id, $3::date, 0, 96 FROM employees e WHERE e.primary_group_id = $4`, [tenantId, v, day, groupId]);
    // published only now that everything is in place: the alert watcher judges any group with a published schedule, and must not see it half-built
    await sql("UPDATE schedule_versions SET status = 'PUBLISHED' WHERE id = $1", [v]);
  });

  const ready = () => minuteNow >= 25;          // people must have been out for longer than the grace period

  it('summarises the group: totals, teams worst first, the unmapped state, the staffing chart', { skip: false }, async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const s = await call(admin, 'GET', `/intraday/adherence/summary?${qs({ groupId })}`);
    assert.equal(s.status, 200, s.text);
    assert.equal(s.json.summary.total, 30); assert.equal(s.json.summary.outOfAdherence, 10); assert.equal(s.json.summary.inAdherence, 15); assert.equal(s.json.summary.unknown, 5);
    assert.equal(s.json.teams[0].team, TY, 'the team with people out comes first'); assert.equal(s.json.teams[0].outOfAdherence, 10);
    assert.deepEqual(s.json.teams.map((x: any) => x.team).sort((a: any, b: any) => String(a).localeCompare(String(b))), [null, TX, TY, TZ].sort((a, b) => String(a).localeCompare(String(b))));
    assert.ok(s.json.unmappedStates.some((u: any) => u.state === `Odd ${RUN}` && u.agents === 5));
    assert.equal(s.json.staffing.length, 96); assert.equal(s.json.agents, undefined, 'a summary carries no people');
    assert.deepEqual(s.json.myTeams, []);
  });

  it('pages the people, with the people who need attention first', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const p1 = await agents({ limit: 12 });
    assert.equal(p1.status, 200, p1.text); assert.equal(p1.total, '30'); assert.equal(p1.json.length, 12);
    assert.ok(p1.json.slice(0, 10).every((r: any) => r.status === 'OUT'), 'the ten out of adherence are first');
    assert.equal(p1.json[0].timeline, undefined, 'a list row carries no timeline');
    const p2 = await agents({ limit: 12, offset: 12 });
    assert.equal(p2.json.length, 12); assert.equal(new Set([...p1.json, ...p2.json].map((r: any) => r.employeeId)).size, 24, 'pages do not overlap');
    assert.equal((await agents({ limit: 12, offset: 24 })).json.length, 6);
    assert.equal((await agents({ limit: 501 })).status, 400);
  });

  it('filters by status, team and search on the server, and counts what is left', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    assert.equal((await agents({ status: 'OUT' })).total, '10');
    assert.equal((await agents({ status: 'OUT,UNKNOWN' })).total, '15');
    assert.equal((await agents({ team: TY })).total, '10');
    assert.equal((await agents({ team: [TX, TZ] })).total, '15', 'several teams, repeated');
    assert.equal((await agents({ team: '~none' })).total, '5', 'people with no team');
    assert.equal((await agents({ team: TY, status: 'IN' })).total, '0', 'filters combine');
    const one = await agents({ q: `A${RUN}-X-3` });
    assert.equal(one.json.length, 1);
    assert.equal((await agents({ status: 'NOPE' })).status, 400);
  });

  it('sorts on the server in either direction', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const asc = (await agents({ sort: 'name', dir: 'asc', limit: 500 })).json.map((r: any) => r.name), desc = (await agents({ sort: 'name', dir: 'desc', limit: 500 })).json.map((r: any) => r.name);
    const lower = (l: string[]) => l.map((x) => x.toLowerCase());
    assert.deepEqual(lower(asc), [...lower(asc)].sort(), 'ascending'); assert.deepEqual(lower(desc), [...lower(desc)].sort().reverse(), 'descending');
    assert.equal(asc.length, 30);
    assert.equal((await agents({ sort: 'banana' })).status, 400);
  });

  it('opens one person with their timeline, and says when there is nobody', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const first = (await agents({ status: 'OUT', limit: 1 })).json[0];
    const d = await call(admin, 'GET', `/intraday/adherence/agents/${first.employeeId}?${qs({ groupId })}`);
    assert.equal(d.status, 200, d.text); assert.equal(d.json.employeeId, first.employeeId); assert.equal(d.json.status, 'OUT');
    assert.ok(d.json.timeline.schedule.length >= 1 && d.json.timeline.actual.length >= 1); assert.deepEqual(d.json.exceptions, []);
    assert.equal((await call(admin, 'GET', `/intraday/adherence/agents/00000000-0000-4000-8000-000000000000?${qs({ groupId })}`)).status, 404);
  });

  it('gives a page of people with their timelines, in the same order as the list', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const list = (await agents({ status: 'OUT,UNKNOWN', limit: 12 })).json.map((r: any) => r.employeeId);
    const tl = await call(admin, 'GET', `/intraday/adherence/timelines?${qs({ groupId, status: 'OUT,UNKNOWN', limit: 12 })}`);
    assert.equal(tl.status, 200, tl.text); assert.equal(tl.total, '15'); assert.equal(tl.json.total, 15); assert.equal(tl.json.people.length, 12);
    assert.deepEqual(tl.json.people.map((p: any) => p.employeeId), list, 'the same people in the same order');
    const out = tl.json.people.find((p: any) => p.status === 'OUT');
    assert.ok(out.timeline.schedule.length >= 1 && out.timeline.actual.some((r: any) => r.status === 'OUT'), 'each has its scheduled and actual stretches');
    assert.ok(Array.isArray(out.exceptions)); assert.match(tl.json.asOf, /^\d\d:\d\d$/);
    const next = await call(admin, 'GET', `/intraday/adherence/timelines?${qs({ groupId, status: 'OUT,UNKNOWN', limit: 12, offset: 12 })}`);
    assert.equal(next.json.people.length, 3);
    assert.equal((await call(admin, 'GET', `/intraday/adherence/timelines?${qs({ groupId, limit: 101 })}`)).status, 400, 'at most 100 at a time');
  });

  it('exports what the filters show as a file', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const r = await fetch(`${BASE}/api/v1/intraday/adherence/export.csv?${qs({ groupId, status: 'OUT' })}`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(r.status, 200); assert.match(r.headers.get('content-disposition') ?? '', /adherence-\d{4}-\d{2}-\d{2}\.csv/);
    const lines = (await r.text()).replace(/^﻿/, '').trim().split(/\r?\n/);
    assert.equal(lines.length, 11, 'a heading and the ten people out'); assert.match(lines[0], /^Date,Employee number,Name,Team/);
  });

  it('"my teams" shows only the teams the person manages', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    assert.equal((await agents({ scope: 'mine' })).total, '0', 'a person who manages no team sees nobody under "my teams"');
    const mgr = (await sql(`SELECT id FROM employees WHERE tenant_id = $1 AND employee_number LIKE $2 ORDER BY employee_number LIMIT 1`, [tenantId, `A${RUN}-Y-%`]))[0].id;
    await sql('UPDATE teams SET manager_id = $1 WHERE tenant_id = $2 AND name = $3', [mgr, tenantId, TY]);
    await sql('UPDATE users SET employee_id = $1 WHERE id = $2', [mgr, adminUserId]);
    ctxMgr = mgr;
    const mine = await agents({ scope: 'mine' });
    assert.equal(mine.total, '10'); assert.ok(mine.json.every((r: any) => r.team === TY));
    const s = (await call(admin, 'GET', `/intraday/adherence/summary?${qs({ groupId, scope: 'mine' })}`)).json;
    assert.equal(s.summary.total, 10); assert.deepEqual(s.myTeams, [TY]); assert.equal(s.teams.length, 1);
  });

  it('an explanation added by a supervisor shows at once, not after the cache expires', async (t) => {
    if (!ready()) return t.skip('too soon after midnight');
    const one = (await agents({ team: TY, limit: 1 })).json[0];
    const before = (await call(admin, 'GET', `/intraday/adherence/summary?${qs({ groupId })}`)).json.summary.outOfAdherence;
    const x = await call(admin, 'POST', '/intraday/exceptions', { employeeId: one.employeeId, day: today, fromMinute: 0, toMinute: 1440, category: 'SYSTEM_ISSUE', note: 'headset fault', excused: true });
    assert.equal(x.status, 201, x.text);
    const after = (await call(admin, 'GET', `/intraday/adherence/summary?${qs({ groupId })}`)).json.summary.outOfAdherence;
    assert.equal(after, before - 1, 'the person is out of adherence no more');
    assert.equal((await call(admin, 'DELETE', `/intraday/exceptions/${x.json.id}`)).status, 200);
    assert.equal((await call(admin, 'GET', `/intraday/adherence/summary?${qs({ groupId })}`)).json.summary.outOfAdherence, before);
  });

  it('keeps finished days and reports adherence over a period, by person and by team', async () => {
    const h = await call(admin, 'GET', `/intraday/adherence/history?${qs({ groupId, from: yesterday, to: yesterday, by: 'team' })}`);
    assert.equal(h.status, 200, h.text); assert.equal(h.json.building, 0);
    const byName = Object.fromEntries(h.json.rows.map((r: any) => [r.name, r]));
    assert.equal(byName[TX].percent, 100); assert.equal(byName[TX].people, 10);
    assert.ok(byName[TY].percent < 5, 'people out of adherence all day');
    assert.equal(byName[TZ], undefined, 'people in a state nobody mapped have no scored time');
    assert.deepEqual(h.json.series.map((s: any) => s.day), [yesterday]);
    const people = await call(admin, 'GET', `/intraday/adherence/history?${qs({ groupId, from: yesterday, to: yesterday, by: 'agent', limit: 5 })}`);
    assert.equal(people.json.rows.length, 5); assert.equal(people.total, '25', 'the people with scored time: teams X and Y and the five with no team');
    assert.ok(people.json.rows[0].percent <= people.json.rows[4].percent, 'worst first');
    const filtered = await call(admin, 'GET', `/intraday/adherence/history?${qs({ groupId, from: yesterday, to: yesterday, by: 'agent', team: TX })}`);
    assert.equal(filtered.total, '10');
    assert.equal((await call(admin, 'GET', `/intraday/adherence/history?${qs({ groupId, from: today, to: yesterday })}`)).status, 400);
    assert.equal((await call(admin, 'GET', `/intraday/adherence/history?${qs({ groupId, from: '2020-01-01', to: yesterday })}`)).status, 400, 'at most 93 days');
  });

  it('keeps the alert settings, with a default of ten minutes', async () => {
    assert.deepEqual((await call(admin, 'GET', '/intraday/adherence/alert-settings')).json, { alertAfterMin: 10, enabled: true });
    assert.equal((await call(admin, 'PUT', '/intraday/adherence/alert-settings', { alertAfterMin: 0, enabled: true })).status, 400);
    assert.equal((await call(admin, 'PUT', '/intraday/adherence/alert-settings', { alertAfterMin: 5, enabled: true })).status, 200);
    assert.equal((await call(admin, 'GET', '/intraday/adherence/alert-settings')).json.alertAfterMin, 5);
  });

  it('tells the team manager once when people stay out of adherence', async (t) => {
    if (!ready() || minuteNow < 40) return t.skip('too soon after midnight');
    // the watcher may already have noticed these people before the manager above was linked to the team; start it afresh so this checks what a manager is told
    await sql('DELETE FROM adherence_alerts WHERE employee_id IN (SELECT id FROM employees WHERE primary_group_id = $1)', [groupId]);
    await sql("DELETE FROM notifications WHERE user_id = $1 AND title LIKE '%out of adherence%'", [adminUserId]);
    let alerted = 0;
    for (let i = 0; i < 20 && !alerted; i++) { await new Promise((ok) => setTimeout(ok, 1500)); alerted = (await sql(`SELECT count(*)::int AS n FROM adherence_alerts a JOIN employees e ON e.id = a.employee_id WHERE e.primary_group_id = $1 AND a.day = $2::date`, [groupId, today]))[0].n; }
    assert.equal(alerted, 10, 'the ten people out of adherence, not the others');
    const notes = await sql(`SELECT title, body FROM notifications WHERE user_id = $1 AND title LIKE '%out of adherence%' ORDER BY created_at DESC`, [adminUserId]);
    assert.equal(notes.length, 1, 'one message for the manager, not one per person'); assert.match(notes[0].title, /^10 people have been out of adherence for over \d+ minutes/);
    await new Promise((ok) => setTimeout(ok, 7000));            // another round of the watcher
    assert.equal((await sql(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%out of adherence%'`, [adminUserId]))[0].n, 1, 'a person who stays out is not reported again');
    assert.equal((await sql(`SELECT count(*)::int AS n FROM adherence_alerts a JOIN employees e ON e.id = a.employee_id WHERE e.primary_group_id = $1 AND a.day = $2::date`, [groupId, today]))[0].n, 10);
  });

  it('keeps a person\'s saved views to themselves, and a name replaces the last one with it', async () => {
    const a = await call(admin, 'POST', '/views', { screen: 'adherence', name: 'Night team', filters: { status: ['OUT'], team: [TY] } });
    assert.equal(a.status, 201, a.text);
    const again = await call(admin, 'POST', '/views', { screen: 'adherence', name: 'Night team', filters: { status: ['IN'] } });
    assert.equal(again.json.id, a.json.id); assert.deepEqual(again.json.filters, { status: ['IN'] });
    const list = (await call(admin, 'GET', '/views?screen=adherence')).json;
    assert.equal(list.filter((v: any) => v.name === 'Night team').length, 1);
    assert.deepEqual((await call(admin, 'GET', '/views?screen=employees')).json.filter((v: any) => v.name === 'Night team'), []);
    assert.equal((await call(admin, 'POST', '/views', { screen: 'Bad Screen!', name: 'x', filters: {} })).status, 400);
    assert.equal((await call(admin, 'DELETE', `/views/${a.json.id}`)).status, 200);
    assert.equal((await call(admin, 'DELETE', `/views/${a.json.id}`)).status, 404);
    assert.equal((await call(null, 'GET', '/views?screen=adherence')).status, 401);
  });
});
let ctxMgr = '';
