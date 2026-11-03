#!/usr/bin/env node
/**
 * What 50,000 people does to the rest of the product: API sizes and latencies, a burst of live agent states,
 * the heaviest admin screens in Chrome, and the employee portal for one of the 50,000.
 *   $env:QA_ADMIN_PASSWORD='...'; node qa/scale/probe-50k.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { SCENARIOS } from './scenarios.mjs';

const BASE = 'http://localhost:4000', ADMIN = 'http://localhost:3000', PORTAL = 'http://localhost:3001';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale');
fs.mkdirSync(path.join(OUT, 'screens'), { recursive: true });
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 500)); };
async function call(t, m, p, b) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/v1${p}`, { method: m, signal: AbortSignal.timeout(300_000), headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const txt = await r.text(); let j; try { j = JSON.parse(txt); } catch { j = txt; }
  return { s: r.status, j, ms: Math.round(performance.now() - t0), kb: Math.round(txt.length / 1024) };
}
const P = process.env.QA_ADMIN_PASSWORD;
const A = (await call(null, 'POST', '/auth/login', { username: 'admin', password: P, tenant: 'ORG' })).j.token;
const groups = Object.fromEntries((await call(A, 'GET', '/config/groups')).j.map((g) => [g.name, g]));
const G = (k) => groups[`SCALE ${k} ${SCENARIOS.find((s) => s.key === k).name}`];
const pickV = (list, k) => (Array.isArray(list) ? list : []).filter((x) => x.name?.startsWith(`SCALE ${k} ${process.env.QA_SCHED_TAG ?? 'schedule'}`)).sort((a, b) => String(b.createdAt ?? b.created_at ?? '').localeCompare(String(a.createdAt ?? a.created_at ?? '')))[0];
const vOf = async (k) => pickV((await call(A, 'GET', `/scheduling/versions?groupId=${G(k).id}`)).j, k);
const s01 = G('S01'), v01 = await vOf('S01');

const PORTAL_ONLY = process.env.PORTAL_ONLY === '1';
// ---- 1. API at 50k
const api = [];
if (!PORTAL_ONLY) {
for (const [name, p] of [
  ['employees (unfiltered)', '/workforce/employees'], ['employees of a 6,000 group', `/workforce/employees?groupId=${s01.id}`], ['time off (all)', '/workforce/time-off'], ['availability (all)', '/workforce/availability'],
  ['schedule versions', '/scheduling/versions'], ['shifts of a 6,000 group (1 wk)', v01 ? `/scheduling/versions/${v01.id}/shifts` : null], ['schedule plan view', v01 ? `/scheduling/versions/${v01.id}/plan` : null],
  ['live coverage (6,000 group)', `/intraday/coverage?groupId=${s01.id}`], ['adherence (6,000 group)', `/intraday/adherence?groupId=${s01.id}`], ['rollup by site', '/scheduling/rollup/?from=2026-11-02&to=2026-11-08'],
  ['forecast versions', '/forecast/versions'], ['audit log', '/audit'], ['attendance summary', '/attendance/summary?from=2026-10-01&to=2026-10-31'], ['users', '/users'], ['self-service logins', '/self-service/logins'],
]) { if (!p) continue; const r = await call(A, 'GET', p); api.push({ name, status: r.s, ms: r.ms, kb: r.kb, rows: Array.isArray(r.j) ? r.j.length : undefined }); }
log({ phase: 'probe-api', rows: api });
}

// ---- 2. live agent states for 6,000 people (batches of 2,000 = the API maximum)
const s01people = []; for (let k = 0; k <= 6; k++) s01people.push(...(await call(A, 'GET', `/workforce/employees?q=S01-0${k}`)).j);
const now = new Date(Date.now() - 60_000).toISOString();
if (!PORTAL_ONLY) {
const batches = []; const t0 = Date.now();
for (let i = 0; i < s01people.length; i += 2000) {
  const r = await call(A, 'POST', '/intraday/events', { events: s01people.slice(i, i + 2000).map((e, j) => ({ employeeNumber: e.employeeNumber, state: j % 7 === 0 ? 'Break' : 'Available', reason: '', at: now })) });
  batches.push({ n: Math.min(2000, s01people.length - i), status: r.s, ms: r.ms, accepted: r.j?.accepted, errors: r.j?.errors?.length });
}
const over = await call(A, 'POST', '/intraday/events', { events: Array.from({ length: 2001 }, (_, i) => ({ employeeNumber: s01people[i % s01people.length].employeeNumber, state: 'Available', at: now })) });
const adh = await call(A, 'GET', `/intraday/adherence?groupId=${s01.id}`);
log({ phase: 'probe-intraday', people: s01people.length, totalMs: Date.now() - t0, batches, over2000: { status: over.s, msg: over.j?.error?.message?.slice(0, 120) }, adherenceAfter: { ms: adh.ms, kb: adh.kb, status: adh.s } });
}

// ---- 3. admin screens in Chrome
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const ui = [];
if (!PORTAL_ONLY) {
await page.goto(ADMIN + '/');
await page.getByLabel(/^Username/).fill('admin'); await page.getByLabel(/^Password/).fill(P);
await page.getByRole('button', { name: /^Sign in$/ }).click(); await page.getByRole('button', { name: 'Account menu' }).waitFor({ timeout: 30000 });
const heap = () => page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));
for (const [name, url, sel] of [
  ['Employees list', '/workforce/employees', null], ['Overview', '/overview', null], ['Schedule timeline', '/scheduling/schedule-timeline', s01.name], ['All schedules', '/scheduling/all-schedules', null],
  ['Live coverage', '/intraday/live-coverage', s01.name], ['Adherence', '/intraday/adherence', s01.name], ['Time off', '/workforce/time-off', null], ['Year plan', '/scheduling/year-plan', null], ['Schedule quality', '/scheduling/schedule-quality', s01.name],
]) {
  const errors = []; const onErr = (e) => errors.push(e.message.slice(0, 160)); page.on('pageerror', onErr);
  const t = Date.now();
  await page.goto(ADMIN + url).catch((e) => errors.push(e.message));
  if (sel) { const box = page.locator('main select').first(); await box.selectOption({ label: sel }).catch(() => {}); }
  await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => errors.push('not idle after 120 s'));
  const ms = Date.now() - t;
  const txt = await page.locator('main').innerText().catch(() => '');
  const crashed = /This screen hit a problem/.test(txt);
  await page.screenshot({ path: path.join(OUT, 'screens', `${name.replace(/\W+/g, '-').toLowerCase()}.png`) });
  ui.push({ name, ms, heapMb: await heap(), crashed, errors, mentions: (txt.match(/\b\d{1,3}(,\d{3})+\b|\b\d{4,6}\b/g) ?? []).slice(0, 6) });
  page.off('pageerror', onErr);
}
log({ phase: 'probe-ui', rows: ui });
}

// ---- 4. the portal for one of the 50,000
const e1 = s01people.find((e) => e.employeeNumber === 'S01-00001');
const login = await call(A, 'POST', '/self-service/logins', { employeeId: e1.id, username: 'scale.s01.00001', password: 'Tmp-Scale-Pass-9!' });
let t1 = (await call(null, 'POST', '/auth/login', { username: 'scale.s01.00001', password: 'Tmp-Scale-Pass-9!', tenant: 'ORG' })).j;
if (t1?.mustChangePassword) t1 = (await call(t1.token, 'POST', '/auth/change-password', { currentPassword: 'Tmp-Scale-Pass-9!', newPassword: 'Scale-Agent-4417#' })).j;
const tok1 = t1?.token ?? (await call(null, 'POST', '/auth/login', { username: 'scale.s01.00001', password: 'Scale-Agent-4417#', tenant: 'ORG' })).j.token;
const portalApi = [];
for (const p of ['/me/home', '/me/schedule', '/me/time-off', '/me/swaps', '/me/offers', '/me/notifications']) { const r = await call(tok1, 'GET', p); portalApi.push({ p, status: r.s, ms: r.ms, kb: r.kb }); }
const sched = (await call(tok1, 'GET', '/me/schedule')).j;
const shiftDays = (sched.days ?? []).filter((d) => d.shift).map((d) => `${d.day} ${d.shift.startTime}-${d.shift.endTime}`);
const pp = await (await b.newContext({ viewport: { width: 1366, height: 860 } })).newPage();
const tp = Date.now();
await pp.goto(PORTAL + '/'); await pp.getByLabel(/^Username/).fill('scale.s01.00001'); await pp.getByLabel(/^Password/).fill('Scale-Agent-4417#');
await pp.getByRole('button', { name: 'Sign in' }).click(); const homeOk = await pp.getByText(/^Hi, /).waitFor({ timeout: 30000 }).then(() => true, () => false);
const homeMs = Date.now() - tp;
await pp.getByRole('button', { name: 'Schedule', exact: true }).click(); await pp.waitForTimeout(1500);
await pp.screenshot({ path: path.join(OUT, 'screens', 'portal-s01-schedule.png') });
log({ phase: 'probe-portal', loginCreate: login.s, portalApi, shiftsThisPeriod: shiftDays.length, sampleShifts: shiftDays.slice(0, 5), uiHomeMs: homeMs, uiHomeOk: homeOk });
await b.close();
