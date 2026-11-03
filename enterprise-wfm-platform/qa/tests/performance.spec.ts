/**
 * Performance baseline (dev servers, single machine — indicative, not a production benchmark):
 *  - API latency p50/p95 for hot read endpoints (sequential)
 *  - modest concurrency: 25 parallel requests x 4 waves per endpoint (no stress/DoS)
 *  - page load timing for key admin screens (navigation timing + time to settled)
 */
import { test, expect } from '@playwright/test';
import { ADMIN_URL, adminToken, call, record, testData, loginReady } from './helpers';

const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };

test('PERF-01 API latency of hot read endpoints', async () => {
  const A = await adminToken();
  // Needs no demo data: it measures the demo group when there is one, otherwise the smallest group with a published schedule, and signs in as an agent of that group
  // (an app login is created for one of its people, or its password is reset when one exists).
  const groups = (await call(A, 'GET', '/config/groups')).body as any[];
  const published = ((await call(A, 'GET', '/scheduling/versions')).body as any[]).filter((v) => v.status === 'PUBLISHED');
  expect(published.length, 'a published schedule to measure').toBeGreaterThan(0);
  const pub = published.find((v) => groups.find((g) => g.id === v.wfmGroupId)?.name === 'Demo Support') ?? [...published].sort((a, b) => (a.stats?.shifts ?? 0) - (b.stats?.shifts ?? 0))[0];
  const demo = groups.find((g) => g.id === pub.wfmGroupId)!;
  const person = ((await call(A, 'GET', `/workforce/employees?groupId=${demo.id}&status=ACTIVE&limit=1`)).body as any[])[0];
  expect(person, 'an active person in the measured group').toBeTruthy();
  let cred = await call(A, 'POST', '/self-service/logins', { employeeId: person.id });
  if (cred.status !== 201) {
    const mine = ((await call(A, 'GET', '/self-service/logins')).body as any[]).find((l) => l.employeeId === person.id);
    cred = await call(A, 'PUT', `/self-service/logins/${mine.userId}/reset-password`, {});
  }
  expect(cred.status, JSON.stringify(cred.body)).toBeLessThan(300);
  const agent = await loginReady(cred.body.username, cred.body.password, testData.agentPassword);
  const eps: [string, string][] = [
    [A, '/auth/me'], [A, '/config/groups'], [A, '/workforce/employees'], [A, '/scheduling/versions'], [A, `/scheduling/versions/${pub.id}/shifts`],
    [A, '/forecast/versions'], [A, `/intraday/coverage?groupId=${demo.id}`], [A, `/intraday/adherence?groupId=${demo.id}`], [A, '/audit'],
    [agent, '/me/home'], [agent, '/me/schedule'], [agent, '/me/time-off'],
  ];
  const rows: any[] = [];
  for (const [t, p] of eps) {
    const ms: number[] = []; let bytes = 0, status = 0;
    for (let i = 0; i < 15; i++) { const r = await call(t, 'GET', p); ms.push(r.ms); status = r.status; bytes = JSON.stringify(r.body).length; }
    rows.push({ endpoint: p.replace(pub.id, ':id').replace(demo.id, ':group'), status, p50: pct(ms, 50), p95: pct(ms, 95), max: Math.round(Math.max(...ms)), kb: Math.round(bytes / 1024) });
  }
  record('perf', { kind: 'api-latency', rows });
  for (const r of rows) expect.soft(r.p95, `${r.endpoint} p95`).toBeLessThan(1500);
});

test('PERF-02 concurrency: 25 parallel x 4 waves', async () => {
  const A = await adminToken();
  const rows: any[] = [];
  for (const p of ['/workforce/employees', '/config/groups', '/scheduling/versions']) {
    const ms: number[] = []; const codes: Record<number, number> = {}; const t0 = performance.now();
    for (let w = 0; w < 4; w++) {
      const res = await Promise.all(Array.from({ length: 25 }, () => call(A, 'GET', p)));
      for (const r of res) { ms.push(r.ms); codes[r.status] = (codes[r.status] ?? 0) + 1; }
    }
    const secs = (performance.now() - t0) / 1000;
    rows.push({ endpoint: p, requests: ms.length, rps: Math.round(ms.length / secs), p50: pct(ms, 50), p95: pct(ms, 95), max: Math.round(Math.max(...ms)), codes });
  }
  // concurrent sign-ins (bcrypt cost) — 10 at once
  const t0 = performance.now();
  const logins = await Promise.all(Array.from({ length: 10 }, () => call(null, 'POST', '/auth/login', { username: 'qa.analyst', password: testData.rolePassword, tenant: 'ORG' })));
  rows.push({ endpoint: 'POST /auth/login x10 concurrent', requests: 10, wallMs: Math.round(performance.now() - t0), p95: pct(logins.map((l) => l.ms), 95), codes: logins.reduce((m: any, l) => ((m[l.status] = (m[l.status] ?? 0) + 1), m), {}) });
  record('perf', { kind: 'concurrency', rows });
  for (const r of rows) expect.soft(Object.keys(r.codes).filter((c) => +c >= 500), `${r.endpoint} 5xx under load`).toEqual([]);
});

test('PERF-03 page load of key admin screens', async ({ page }) => {
  test.setTimeout(300_000);               // seven screens, each allowed to load and then settle: more than the 90 s every other test gets
  const rows: any[] = [];
  for (const u of ['/overview', '/workforce/employees', '/forecasting/forecast-dashboard', '/forecasting/forecast-builder', '/scheduling/schedule-timeline', '/intraday/live-coverage', '/forecasting/accuracy-heatmap']) {
    let api = 0, apiBytes = 0; const onResp = async (r: any) => { if (r.url().includes('/api/')) { api++; apiBytes += Number(r.headers()['content-length'] ?? 0); } };
    page.on('response', onResp);
    const t0 = Date.now();
    await page.goto(ADMIN_URL + u, { waitUntil: 'load' });
    const loadMs = Date.now() - t0;
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    const settledMs = Date.now() - t0;
    const nav = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming; return { domContentLoaded: Math.round(n.domContentLoadedEventEnd), transferKb: Math.round(performance.getEntriesByType('resource').reduce((s, r: any) => s + (r.transferSize || 0), 0) / 1024), resources: performance.getEntriesByType('resource').length }; });
    rows.push({ url: u, loadMs, settledMs, apiCalls: api, ...nav });
    page.off('response', onResp);
  }
  record('perf', { kind: 'page-load', rows, note: 'Vite dev server (unbundled ES modules) — production build will load far fewer resources' });
  for (const r of rows) expect.soft(r.settledMs, `${r.url} settles`).toBeLessThan(10_000);
});
