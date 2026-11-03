import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const API = (process.env.QA_API ?? 'http://localhost:4000') + '/api/v1';
export const ADMIN_URL = process.env.QA_ADMIN_URL ?? 'http://localhost:3000';
export const PORTAL_URL = process.env.QA_PORTAL_URL ?? 'http://localhost:3001';
export const TENANT = process.env.QA_TENANT ?? 'ORG';
export const ADMIN_USER = process.env.QA_ADMIN_USER ?? 'admin';
export const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? '';
export const RUN = process.env.QA_RUN_ID ?? String(Date.now()).slice(-6);
// run-time output lives OUTSIDE the repo: the admin Vite dev server watches the project folder and crashes (EBUSY) on locked trace files
export const OUT_ROOT = process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa');
export const OUT = path.join(OUT_ROOT, 'data');
fs.mkdirSync(OUT, { recursive: true });

/** Test-only credentials generated for the QA run (see qa/test-data.json). */
export const testData: { agentPassword: string; rolePassword: string } = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../test-data.json'), 'utf8'));

export interface Res { status: number; body: any; ms: number; headers: Headers }
export async function call(token: string | null, method: string, p: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res> {
  const t0 = performance.now();
  const r = await fetch(p.startsWith('http') ? p : API + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extraHeaders },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const txt = await r.text();
  let j: any; try { j = JSON.parse(txt); } catch { j = txt; }
  return { status: r.status, body: j, ms: performance.now() - t0, headers: r.headers };
}

export async function login(username: string, password: string, tenant = TENANT) {
  const r = await call(null, 'POST', '/auth/login', { username, password, tenant });
  if (r.status !== 200) throw new Error(`login ${username} -> ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { token: string; mustChangePassword: boolean; user: any; permissions: string[] };
}

/** Log in, replacing a temporary password with `finalPassword` when required. */
export async function loginReady(username: string, tempPassword: string, finalPassword: string): Promise<string> {
  const first = await call(null, 'POST', '/auth/login', { username, password: finalPassword, tenant: TENANT });
  if (first.status === 200 && !first.body.mustChangePassword) return first.body.token;
  const s = await login(username, tempPassword);
  if (!s.mustChangePassword) return s.token;
  const c = await call(s.token, 'POST', '/auth/change-password', { currentPassword: tempPassword, newPassword: finalPassword });
  if (c.status !== 200) throw new Error(`change-password ${username} -> ${c.status} ${JSON.stringify(c.body)}`);
  return c.body.token;
}

let adminTok: string | undefined;
export const adminToken = async () => (adminTok ??= (await login(ADMIN_USER, ADMIN_PASSWORD)).token);

/** Append one finding/observation to reports/data/<file>.jsonl so the report generator can pick it up. */
export function record(file: string, row: Record<string, unknown>) {
  fs.appendFileSync(path.join(OUT, file + '.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
}

export const routes: { method: string; path: string; guard: string; perms: string[]; file: string }[] =
  JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../route-inventory.json'), 'utf8'));

/** The 60 admin screens, from src/components/layout/NavigationSidebar.tsx. */
export const ADMIN_SCREENS: Record<string, string[]> = {
  overview: [''],
  workforce: ['employees', 'teams', 'skills', 'availability', 'time-off', 'attendance', 'payroll'],
  forecasting: ['forecast-dashboard', 'all-forecasts', 'forecast-builder', 'adjustments', 'scenarios', 'capacity-plan', 'accuracy-heatmap', 'model-leaderboard'],
  scheduling: ['schedule-timeline', 'generate-schedule', 'year-plan', 'schedule-quality', 'shift-templates', 'all-schedules', 'multi-site', 'follow-the-sun', 'rotations', 'shift-swaps', 'vto-overtime', 'shift-bidding', 'schedule-compare', 'schedule-replay'],
  intraday: ['live-coverage', 'adherence', 'break-optimizer', 'ai-recommendations'],
  configuration: ['wfm-groups', 'activities', 'scheduling-rules', 'sites-skills', 'integration-station', 'compliance-packs', 'self-service-rules', 'rta-mapping', 'optimization-objectives'],
  'data-management': ['staged-imports', 'data-quality', 'scheduled-syncs'],
  audit: [''],
  administration: ['users', 'roles', 'api-access', 'alerts-reports'],
};
