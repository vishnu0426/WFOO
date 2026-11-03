/**
 * Speed budgets for the calls every screen makes, the caching headers on them, and the group-size summary that replaced downloading whole groups.
 *   DATABASE_URL=... BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/performanceBudget.test.ts
 * Budgets are generous (a slow CI machine must not fail them) but small enough that a return to reading every interval or every person would.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const call = async (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, headers: r.headers };
};
const median = async (token: string, path: string, n = 5) => { const t: number[] = []; for (let i = 0; i < n; i++) { const t0 = performance.now(); const r = await call(token, 'GET', path); assert.equal(r.status, 200, `${path}: ${r.text.slice(0, 120)}`); t.push(performance.now() - t0); } return t.sort((a, b) => a - b)[Math.floor(n / 2)]; };

describe('performance budgets and caching', { skip: !process.env.ADMIN_PASSWORD }, () => {
  let admin = '';
  before(async () => { admin = (await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT })).json.token; });

  it('answers the lists every screen opens with inside the budget', async () => {
    for (const [path, ms] of [['/config/groups', 300], ['/config/queues', 300], ['/config/groups/summary', 500], ['/data/coverage', 500], ['/workforce/teams', 400]] as const) {
      const m = await median(admin, path); assert.ok(m < ms, `${path} took ${Math.round(m)} ms (median of 5), budget ${ms} ms`);
    }
  });

  it('lets the browser check for changes instead of downloading again', async () => {
    const first = await call(admin, 'GET', '/config/groups');
    assert.match(first.headers.get('cache-control') ?? '', /private/);
    assert.match(first.headers.get('cache-control') ?? '', /no-cache/);
    const etag = first.headers.get('etag'); assert.ok(etag, 'a list carries an ETag');
    // fetch() itself adds "Cache-Control: no-cache" to a conditional request (which forces a full answer), so ask the way a browser's cache does
    const again = await new Promise<{ status: number; body: string }>((resolve, reject) => http.get(`${BASE}/api/v1/config/groups`, { headers: { Authorization: `Bearer ${admin}`, 'If-None-Match': etag! } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode!, body: b })); }).on('error', reject));
    assert.equal(again.status, 304); assert.equal(again.body, '');
    assert.notEqual((await call(admin, 'POST', '/config/groups', {})).headers.get('cache-control'), 'private, no-cache', 'changes are never cached');
  });

  it('gives the size of a group without listing it', async () => {
    const g = (await call(admin, 'GET', '/config/groups')).json.find((x: any) => x.activeEmployees > 0) ?? (await call(admin, 'GET', '/config/groups')).json[0];
    const r = await call(admin, 'GET', `/workforce/employees/summary?groupId=${g.id}&status=ACTIVE`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.text.length < 20_000, 'a summary is small whatever the group size');
    const all = (await call(admin, 'GET', `/workforce/employees?groupId=${g.id}&status=ACTIVE&fields=ids`)).json.length;
    assert.equal(r.json.people, all, 'the summary counts the same people the list does');
    assert.equal(r.json.teams.reduce((n: number, t: any) => n + t.people, 0) <= r.json.people, true);
    const m = await median(admin, `/workforce/employees/summary?groupId=${g.id}&status=ACTIVE`); assert.ok(m < 400, `summary took ${Math.round(m)} ms`);
  });

  it('hands back a page of people quickly however many people there are, and a schedule list without the long reports', async () => {
    const m = await median(admin, '/workforce/employees?limit=100'); assert.ok(m < 300, `100 people took ${Math.round(m)} ms (median of 5)`);
    const list = (await call(admin, 'GET', '/scheduling/versions')).json as any[];
    for (const v of list) assert.ok(!('report' in (v.settings ?? {})), 'the list does not carry any schedule report');
  });

  it('checks many passwords at once without holding up other requests', async () => {
    const login = () => call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
    let worst = 0, stop = false;
    const probe = (async () => { while (!stop) { const t0 = performance.now(); await call(admin, 'GET', '/auth/me'); worst = Math.max(worst, performance.now() - t0); await new Promise((r) => setTimeout(r, 40)); } })();
    const t0 = performance.now();
    const rs = await Promise.all(Array.from({ length: 30 }, login));
    const sec = (performance.now() - t0) / 1000; stop = true; await probe;
    assert.ok(rs.every((r) => r.status === 200), 'every sign-in succeeded');
    assert.ok(worst < 1500, `a simple call waited ${Math.round(worst)} ms while 30 people signed in`);
    assert.ok(sec < 12, `30 sign-ins took ${sec.toFixed(1)} s`);
  });

  it('lists teams a page at a time, searchable, with a slim list for drop-downs', async () => {
    const page = await call(admin, 'GET', '/workforce/teams?limit=5');
    assert.equal(page.status, 200); assert.ok(page.json.length <= 5);
    assert.ok(Number(page.headers.get('x-total-count')) >= page.json.length, 'the total is reported');
    assert.equal(page.headers.get('x-page-limit'), '5');
    const total = Number(page.headers.get('x-total-count'));
    if (total > 5) assert.equal(page.json.length, 5, 'a full page when there are more');
    const slim = await call(admin, 'GET', '/workforce/teams?fields=pick');
    assert.ok(slim.json.length === 0 || (slim.json[0].id && slim.json[0].name && !('managerName' in slim.json[0]) && !('description' in slim.json[0])), 'the slim list carries only what a drop-down needs');
    const full = await call(admin, 'GET', '/workforce/teams?limit=200');
    if (slim.json.length >= 3 && full.json.length >= 3) assert.ok(slim.text.length / slim.json.length < (full.text.length / full.json.length) * 0.8, `and is smaller for each team (${Math.round(slim.text.length / slim.json.length)} against ${Math.round(full.text.length / full.json.length)} bytes)`);
    const counted = await call(admin, 'GET', '/workforce/teams?fields=pick&counts=1&limit=1');
    if (counted.json.length) assert.equal(typeof counted.json[0].memberCount, 'number');
    if (page.json.length) {
      const name = page.json[0].name as string;
      const found = await call(admin, 'GET', `/workforce/teams?q=${encodeURIComponent(name.slice(0, 6))}`);
      assert.ok(found.json.some((t: any) => t.id === page.json[0].id), 'search finds a team by part of its name');
    }
    const m = await median(admin, '/workforce/teams?limit=100'); assert.ok(m < 400, `100 teams took ${Math.round(m)} ms`);
  });

  it('lists schedules a page at a time, filtered by the server', async () => {
    const all = await call(admin, 'GET', '/scheduling/versions?limit=3');
    assert.equal(all.status, 200); assert.ok(all.json.length <= 3);
    const total = Number(all.headers.get('x-total-count')); assert.ok(total >= all.json.length);
    const pub = await call(admin, 'GET', '/scheduling/versions?status=PUBLISHED&limit=50');
    assert.ok(pub.json.every((v: any) => v.status === 'PUBLISHED'));
    const next = await call(admin, 'GET', '/scheduling/versions?limit=3&offset=3');
    const ids = new Set(all.json.map((v: any) => v.id));
    assert.ok(next.json.every((v: any) => !ids.has(v.id)), 'the next page does not repeat the first');
    if (all.json.length) {
      const g = all.json[0].wfmGroupId as string;
      const one = await call(admin, 'GET', `/scheduling/versions?groupIds=${g}`);
      assert.ok(one.json.length > 0 && one.json.every((v: any) => v.wfmGroupId === g));
    }
    assert.equal((await call(admin, 'GET', '/scheduling/versions?status=NOPE')).status, 400, 'an unknown status is refused');
  });

  it('answers the history-quality check at once and adds the slow part when it is ready', async () => {
    const groups = (await call(admin, 'GET', '/config/groups')).json as any[];
    const g = groups.find((x) => (x.queueIds ?? []).length > 0);
    if (!g) return;
    let r = await call(admin, 'GET', `/forecast/history-quality?groupId=${g.id}`);
    assert.equal(r.status, 200); assert.ok(Array.isArray(r.json.queues)); assert.ok(Array.isArray(r.json.pending));
    const t0 = performance.now();
    for (let i = 0; i < 20 && r.json.pending.length; i++) { await new Promise((x) => setTimeout(x, 1000)); r = await call(admin, 'GET', `/forecast/history-quality?groupId=${g.id}`); }
    assert.equal(r.json.pending.length, 0, `the odd-handle-time check finished (${Math.round(performance.now() - t0)} ms)`);
    const again = await median(admin, `/forecast/history-quality?groupId=${g.id}`, 3); assert.ok(again < 3000, `a ready answer took ${Math.round(again)} ms`);
  });

  it('serves many people using it at once without a single server error', async () => {
    const USERS = 40, ROUNDS = 2;
    const paths = ['/auth/me', '/config/groups', '/config/queues', '/workforce/teams?fields=pick', '/workforce/employees?limit=50', '/scheduling/versions?limit=20', '/data/coverage', '/config/groups/summary'];
    const t0 = performance.now(); let bad = 0, total = 0; const ms: number[] = [];
    await Promise.all(Array.from({ length: USERS }, async () => {
      const l = await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
      if (l.status !== 200) { bad++; return; }
      for (let r = 0; r < ROUNDS; r++) for (let k = 0; k < paths.length; k += 4) await Promise.all(paths.slice(k, k + 4).map(async (p) => { const a = performance.now(); const x = await call(l.json.token, 'GET', p); ms.push(performance.now() - a); total++; if (x.status >= 500) bad++; }));
    }));
    ms.sort((a, b) => a - b);
    assert.equal(bad, 0, `${bad} of ${total + USERS} calls failed`);
    const p95 = ms[Math.floor(ms.length * 0.95)];
    assert.ok(p95 < 20_000, `95% of calls finished within ${Math.round(p95)} ms (${total} calls by ${USERS} people in ${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  });
});
