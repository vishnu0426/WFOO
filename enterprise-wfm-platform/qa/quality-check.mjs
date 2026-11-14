// Looks at Forecast quality (the Accuracy and Models tabs), the shared look-back periods and the Forget dialog in a real browser at 1280 px wide, against a test stack. It creates its own group;
// a published forecast is dated back in the test database (QA_DB is its address):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... QA_DB=postgres://postgres:admin@localhost:5432/wfm_p3_test node quality-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(path.resolve(process.cwd(), '../backend/gateway/package.json'));
const pg = require('pg');
const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const DB = process.env.QA_DB || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-quality-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
if (!DB) { console.log('Set QA_DB to the test database address.'); process.exit(2); }
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
function historyCsv(queue, days) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 5 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}
const groups = {};
async function group(key, ago) {
  const g = (await call(token, 'POST', '/config/groups', { name: `ACC${key} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 })).json;
  groups[key] = g;
  const q = (await call(token, 'POST', '/config/queues', { name: `ACC${key} Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  if (ago === null) return;
  const v = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 4, fromDay: iso(addDays(today, -ago)) })).json;
  for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v.id}/${s}`, {});
  const c = new pg.Client({ connectionString: DB }); await c.connect();
  try { await c.query('UPDATE wfm.forecast_versions SET created_at = $2::timestamptz WHERE id = $1', [v.id, addDays(today, -ago - 1).toISOString()]); } finally { await c.end(); }
}
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
let ctx = null, page = null;
const open = async (g, url) => {
  if (ctx) await ctx.close();
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); } }, g.id);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('response', (r) => { if (r.status() === 429) limited.push(r.url().split('/api/v1').pop()); });
  page.on('console', (m) => { if (m.type() === 'error' && !(/429/.test(m.text()) && limited.every((u) => u.startsWith('/auth/login-options')))) errors.push(m.text()); });
  await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.getByLabel(/^Username/i).waitFor();
  const org = page.getByLabel(/Organisation code/i);
  if (await org.isVisible().catch(() => false)) await org.fill('ORG');
  await page.getByLabel(/^Username/i).fill('admin');
  await page.getByLabel(/^Password/i).fill(PASS);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
  await page.goto(URL + url, { waitUntil: 'domcontentloaded' });
};
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

await group('FULL', 27);
const gid = groups.FULL.id;
// the system learns from the forecast that was wrong about the past days
const learned = await call(token, 'POST', '/forecast/learning/run', { groupId: gid });
const factors = async () => ((await call(token, 'GET', `/forecast/learning?groupId=${gid}`)).json.factors ?? []).filter((f) => Math.abs(f.factor - 1) > 0.005).length;
const before = await factors();
note(before > 0, 'set-up: the group has learned corrections to forget', `${before} corrections; ${String(learned.json.note).slice(0, 60)}`);

await open(groups.FULL, '/forecasting/accuracy-heatmap');
await page.getByRole('tablist', { name: 'Forecast quality' }).waitFor({ timeout: 90000 });

// 1. one page, two tabs
note(/Forecasting\s*\/\s*Forecast quality/.test(await text(page.locator('header nav'))), 'one page: Forecasting / Forecast quality');
const tabs = await page.getByRole('tab').allInnerTexts();
note(tabs.join(',') === 'Accuracy,Models', 'with two tabs: Accuracy and Models', tabs.join(','));
note((await page.getByRole('tab', { name: 'Accuracy' }).getAttribute('aria-selected')) === 'true', 'Accuracy is the one open');
const nav = await text(page.locator('nav[aria-label], aside').first());
const sidebar = page.locator('aside, nav').filter({ hasText: 'Forecast Dashboard' }).first();
note((await sidebar.getByRole('button', { name: 'Forecast quality' }).count()) === 1 && (await sidebar.getByRole('button', { name: /^Models$/ }).count()) === 0 && (await sidebar.getByRole('button', { name: /^Accuracy$/ }).count()) === 0, 'the sidebar has one "Forecast quality" entry instead of Accuracy and Models');
await page.getByTestId('accuracy-hero').waitFor({ timeout: 90000 });
note((await page.getByTestId('accuracy-hero').count()) === 1, 'the Accuracy tab still opens on the headline');
await page.getByRole('tab', { name: 'Models' }).click();
await page.waitForURL(/model-leaderboard/, { timeout: 15000 });
note((await page.getByRole('tab', { name: 'Models' }).getAttribute('aria-selected')) === 'true' && /Forecast quality/.test(await text(page.locator('header nav'))), 'the Models tab keeps its own address and the same header', page.url().replace(URL, ''));
note((await sidebar.getByRole('button', { name: 'Forecast quality' }).getAttribute('aria-current')) === 'page', 'and the sidebar entry stays marked while on Models');
await page.getByRole('tab', { name: 'Models' }).focus();
await page.keyboard.press('ArrowLeft');
await page.waitForURL(/accuracy-heatmap/, { timeout: 15000 });
note((await page.getByRole('tab', { name: 'Accuracy' }).getAttribute('aria-selected')) === 'true', 'the arrow keys move between the tabs');

// 2. the same look-back choices on both tabs
const trendCard = () => page.locator('div, section').filter({ hasText: 'Accuracy over time' }).last();
await page.getByText('Accuracy over time').first().waitFor({ timeout: 90000 });
const seg = async () => (await page.getByRole('button', { name: /^\d+ weeks$/ }).allInnerTexts()).join(',');
note((await seg()) === '8 weeks,12 weeks,26 weeks,52 weeks', 'the Accuracy trend offers 8, 12, 26 and 52 weeks', await seg());
note(await page.getByRole('button', { name: '12 weeks' }).evaluate((el) => el.className.includes('bg-') || el.getAttribute('aria-pressed') === 'true'), '12 weeks is the default');
await page.getByRole('button', { name: '26 weeks' }).click();
await page.getByRole('tab', { name: 'Models' }).click();
await page.getByText('Accuracy trend').first().waitFor({ timeout: 90000 });
const models = await text(page.locator('body'));
note((await seg()) === '8 weeks,12 weeks,26 weeks,52 weeks' && !/1 month|3 months|6 months|1 year/.test(models), 'the Models trend offers the same four, not 1 month / 3 months / 6 months / 1 year', await seg());
const stored = await page.evaluate(() => localStorage.getItem('wfm_quality_weeks'));
note(stored === '26', 'and the choice made on the Accuracy tab (26 weeks) carried over', 'stored ' + stored);
await page.getByRole('button', { name: '52 weeks' }).click();
await page.getByRole('tab', { name: 'Accuracy' }).click();
await page.getByText('Accuracy over time').first().waitFor({ timeout: 90000 });
note((await page.evaluate(() => localStorage.getItem('wfm_quality_weeks'))) === '52', 'a choice made on Models carries back to Accuracy');
await page.getByRole('tab', { name: 'Models' }).click();

// 3. forgetting is not next to Learn now
await page.getByRole('button', { name: 'Learn now' }).waitFor({ timeout: 90000 });
note((await page.getByRole('button', { name: /Forget/ }).count()) === 0, '"Forget what was learned" is not a button beside "Learn now"');
const more = page.getByRole('button', { name: 'More actions' });
note((await more.count()) === 1, 'it is behind a "More actions" menu');
await more.click();
const item = page.getByRole('menuitem', { name: /Forget what was learned/ });
note(await item.isVisible() && (await item.evaluate((el) => getComputedStyle(el).color)) !== (await page.getByRole('button', { name: 'Learn now' }).evaluate((el) => getComputedStyle(el).color)), 'where it is a red menu item', await item.evaluate((el) => getComputedStyle(el).color));
await item.click();
const dlg = page.getByRole('dialog', { name: /Forget what was learned for/ });
await dlg.waitFor();
const dt = await text(dlg);
note(/\d+ weekday corrections? across \d+ queues? will be deleted/.test(dt), 'a dialog says how many corrections will be deleted', dt.slice(0, 120));
note(/plain model output/.test(dt) && /already made keep their numbers/.test(dt) && /cannot be undone/.test(dt) && /switch Learning off instead/.test(dt), 'and the consequences: back to plain output, existing forecasts keep their numbers, cannot be undone, and the safer alternative');
const go = dlg.getByRole('button', { name: 'Forget corrections' });
note(await go.isDisabled(), 'the button is off until a reason is given');
await dlg.getByLabel(/Why/).fill('ab');
note(await go.isDisabled(), 'and two letters are not a reason');
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'hidden' });
note((await factors()) === before, 'Escape closes it and nothing is deleted');
await more.click(); await item.click(); await dlg.waitFor();
await dlg.getByRole('button', { name: 'Cancel' }).click();
await dlg.waitFor({ state: 'hidden' });
note((await factors()) === before, 'Cancel deletes nothing either');

// 4. confirming
await more.click(); await item.click(); await dlg.waitFor();
await dlg.getByLabel(/Why/).fill('The business changed in October');
await go.click();
await dlg.waitFor({ state: 'hidden', timeout: 30000 });
note((await factors()) === 0, 'with a reason it deletes them');
await page.waitForFunction(() => !document.querySelector('button[aria-label="More actions"]'), null, { timeout: 30000 });
note((await page.getByRole('button', { name: 'More actions' }).count()) === 0, 'and the menu goes away: there is nothing left to forget');
const audit = (await call(token, 'GET', `/audit?entityType=FORECAST_LEARNING&limit=5`)).json;
const rows = Array.isArray(audit) ? audit : (audit.items ?? audit.rows ?? []);
note(rows.some((r) => /business changed in October/.test(r.reason ?? '')), 'the reason is on the audit trail', JSON.stringify(rows.slice(0, 1)).slice(0, 80));

// 5. layout, accessibility, console
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
