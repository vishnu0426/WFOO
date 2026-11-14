// Looks at the Today page in a real browser, against a test stack, and compares what is on screen with what the API says:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node today-check.mjs
import { chromium } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import AxeBuilder from '@axe-core/playwright';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-today-check');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (token, p) => { const r = await fetch(API + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} }); return r.json(); };
const login = await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: PASS, tenant: 'ORG' }) });
const token = (await login.json()).token;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.getByRole('heading', { name: 'Today' }).waitFor({ timeout: 30000 }).catch(() => {});
await page.waitForTimeout(3500);
let t = await text();
await page.screenshot({ path: path.join(SHOTS, 'today.png') });

note(/Today/.test(t) && !/Nothing needs action right now/.test(t) || /Nothing needs action\. Everything was checked/.test(t), 'the page is called Today and never prints the old unconditional "Nothing needs action right now."');
const groups = await call(token, '/config/groups');
const active = groups.find((g) => t.includes(g.name)) ?? groups.at(-1);
const api = await call(token, `/overview/today?groupId=${active.id}`);
note(!!api.verdict, `the API answers for the group on screen (${active.name})`);
note(t.includes(api.verdict.text), 'the verdict line on screen is the API\'s', api.verdict.text);
note(/Checked:/.test(t), 'it says what was checked');
note(api.verdict.status !== 'OK' ? !/On track/.test(t) : /On track/.test(t), `the badge agrees with the verdict (${api.verdict.status})`);
for (const k of api.kpis) note(t.toLowerCase().includes(k.label.toLowerCase()), `KPI tile "${k.label}" is shown`);
note((t.match(/Target \d/g) ?? []).length >= api.kpis.filter((k) => k.target !== null).length, 'tiles with a target show it');
note(/no trend yet|steady|since yesterday|vs the week before|vs 4 weeks ago/.test(t), 'tiles show a trend, or say there is none yet');
for (const i of api.attention.slice(0, 8)) note(t.includes(i.title), `attention item shown: ${i.title}`);
const actionable = api.attention.find((i) => i.action?.allowed);
if (actionable) {
  const btn = page.getByRole('button', { name: new RegExp(actionable.action.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first();
  note(await btn.isVisible().catch(() => false), `the fix button "${actionable.action.label}" is there`);
  await btn.click(); await page.waitForTimeout(1500);
  note(!(await page.getByRole('heading', { name: 'Today' }).isVisible().catch(() => false)), 'clicking it opens the screen that fixes it');
  await page.goBack().catch(() => {}); await page.goto(URL + '/'); await page.waitForTimeout(3000);
}
t = await text();
note(!/\bLogin\b[^.]{0,60}(admin|Administrator)/i.test(t.split('Recent changes')[1] ?? ''), 'recent changes leave sign-ins out by default');
const box = page.getByLabel(/Show sign-ins/i);
if (await box.isVisible().catch(() => false)) { await box.check(); await page.waitForTimeout(1500); note(/login/i.test((await text()).split('Recent changes')[1] ?? ''), 'ticking "Show sign-ins" brings them back'); }
note(await page.locator('[aria-label="WFM group"]').count() === 0, 'the page has no second WFM group selector (the header has it)');
await page.goto(URL + '/'); await page.waitForTimeout(3500);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations on Today', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshot in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
