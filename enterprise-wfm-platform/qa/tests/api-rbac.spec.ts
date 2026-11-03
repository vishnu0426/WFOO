/**
 * Role-based access control across EVERY guarded gateway route (from qa/route-inventory.json).
 * For each role a qa.<role> user is created. Each role calls each route:
 *  - lacking the permission  -> must be 403 (any method; the guard runs before the handler, so nothing is changed)
 *  - holding the permission  -> GET must not be 401/403 (checked for GETs only, to avoid side effects)
 * Unauthenticated -> 401 on every authenticated route.
 */
import { test, expect } from '@playwright/test';
import { adminToken, call, loginReady, record, routes, testData, RUN } from './helpers';

const ROLES = ['WFM_MANAGER', 'FORECAST_PLANNER', 'SCHEDULER', 'SUPERVISOR_RTA', 'ANALYST', 'AGENT'] as const;
const FAKE = '00000000-0000-4000-8000-000000000000';
const fill = (p: string) => p.replace(/^\/api\/v1/, '').replace(/:(\w+)/g, (_m, k) => (/id$/i.test(k) ? FAKE : /day|date|from|to/i.test(k) ? '2026-11-02' : 'x'));
const authed = routes.filter((r) => r.path.startsWith('/api/v1') && r.guard !== 'none');

let matrix: Record<string, string[]>;
const tokens: Record<string, string> = {};

test.beforeAll(async () => {
  const a = await adminToken();
  matrix = (await call(a, 'GET', '/rbac/matrix')).body.matrix;
  const users = (await call(a, 'GET', '/users')).body as any[];
  for (const role of ROLES) {
    const username = `qa.${role.toLowerCase()}`;
    const temp = 'Tmp-' + testData.rolePassword;
    if (!users.some((u) => u.username === username)) {
      const c = await call(a, 'POST', '/users', { username, displayName: `QA ${role}`, role, password: temp });
      expect(c.status, `create ${username}: ${JSON.stringify(c.body)}`).toBe(201);
    }
    tokens[role] = await loginReady(username, temp, testData.rolePassword);
  }
});

test('route inventory is non-trivial', () => { expect(authed.length).toBeGreaterThan(250); });

test('unauthenticated requests are rejected on every guarded route', async () => {
  const leaks: string[] = [];
  for (const r of authed) {
    const res = await call(null, r.method, fill(r.path), r.method === 'GET' ? undefined : {});
    if (res.status !== 401) leaks.push(`${r.method} ${r.path} -> ${res.status}`);
  }
  record('rbac', { check: 'unauthenticated', tested: authed.length, leaks });
  expect(leaks).toEqual([]);
});

for (const role of ROLES) {
  test(`role ${role}: denied where it lacks permission, allowed where it has it`, async () => {
    const have = new Set(matrix[role]);
    const leaks: string[] = [], wrongDeny: string[] = [], errors5xx: string[] = [];
    let tested = 0;
    for (const r of authed) {
      const allowed = r.guard === 'any' ? r.perms.some((p) => have.has(p)) : r.perms.every((p) => have.has(p));
      if (!allowed) {
        const res = await call(tokens[role], r.method, fill(r.path), r.method === 'GET' ? undefined : {});
        tested++;
        if (res.status !== 403) leaks.push(`${r.method} ${r.path} [needs ${r.perms.join(r.guard === 'any' ? '|' : '+')}] -> ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      } else if (r.method === 'GET') {
        const res = await call(tokens[role], 'GET', fill(r.path));
        tested++;
        if (res.status === 401 || res.status === 403) wrongDeny.push(`${r.path} -> ${res.status} ${res.body?.error?.message ?? ''}`);
        if (res.status >= 500) errors5xx.push(`GET ${r.path} -> ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
      }
    }
    record('rbac', { check: 'role', role, tested, leaks, wrongDeny, errors5xx });
    expect.soft(leaks, 'privilege escalation: route answered without the permission').toEqual([]);
    expect.soft(wrongDeny, 'role blocked from a route its permissions allow').toEqual([]);
    expect.soft(errors5xx, 'server errors on GET with placeholder ids').toEqual([]);
  });
}

test('AGENT cannot read another employee via self-service endpoints (IDOR)', async () => {
  const a = await adminToken();
  const emps = (await call(a, 'GET', '/workforce/employees')).body as any[];
  const other = emps.find((e) => e.employeeNumber?.startsWith('D0'));
  const agent = tokens.AGENT;
  const probes = [`/me/schedule?employeeId=${other.id}`, `/me/profile?employeeId=${other.id}`, `/me/time-off?employeeId=${other.id}`, `/workforce/employees/${other.id}`];
  const out: string[] = [];
  for (const p of probes) { const r = await call(agent, 'GET', p); out.push(`${p} -> ${r.status}`); if (r.status === 200) expect.soft(JSON.stringify(r.body)).not.toContain(other.id); }
  record('rbac', { check: 'idor', run: RUN, out });
});
