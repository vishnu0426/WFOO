// Looks at how forecast accuracy is shown on the Overview, Dashboard, Accuracy and Models screens in a real browser at 1280 px wide, against a test stack. It creates its own groups; a published
// forecast is dated back in the test database so its days count as already forecast (needs QA_DB, the test database's address):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... QA_DB=postgres://postgres:admin@localhost:5432/wfm_p3_test node accuracy-check.mjs
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
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-accuracy-check');
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
await group('FULL', 27); await group('THIN', 6); await group('NONE', null);
const head = async (k) => (await call(token, 'GET', `/forecast/accuracy-headline?groupId=${groups[k].id}`)).json;
const hFull = await head('FULL'), hThin = await head('THIN');
note(hFull.state === 'OK' && hThin.state === 'SPARSE', 'set-up: one group with a full 28 days of comparison, one with under two weeks', `${hFull.days} days / ${hThin.days} days`);
const pctText = (h) => `${h.accuracyPct.toFixed(1)}%`;

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

// 1. the Accuracy page: same frame as its siblings, and the headline first
await open(groups.FULL, '/forecasting/accuracy-heatmap');
const hero = page.getByTestId('accuracy-hero');
await hero.waitFor({ timeout: 90000 });
await page.waitForFunction(() => !/…/.test(document.querySelector('[data-testid=accuracy-value]')?.textContent || ''), null, { timeout: 60000 });
note(/Forecasting\s*\/\s*Forecast quality/.test(await text(page.locator('header nav'))), 'the page has a breadcrumb: Forecasting / Forecast quality');
note((await page.getByLabel('Group', { exact: true }).count()) === 1 && (await page.getByLabel('WFM group').count()) === 0, 'and the same Group box as the other forecasting pages, not a different selector');
note((await hero.getAttribute('data-state')) === 'OK' && (await text(page.getByTestId('accuracy-value'))) === pctText(hFull), 'the headline is Forecast accuracy, the same figure the API gives', await text(page.getByTestId('accuracy-value')));
note(/Last 28 days · missed by [\d.]+% a day/.test(await text(page.getByTestId('accuracy-sub'))), 'with what it means: last 28 days, missed by x% a day', await text(page.getByTestId('accuracy-sub')));
const tip = await hero.getByRole('button', { name: /How this is measured/ }).getAttribute('title');
note(/100% − WAPE/.test(tip) && /last 28 days/.test(tip), 'and a definition on hover and for screen readers', tip.slice(0, 90));
await page.getByText(/Test miss · 15 min/i).first().waitFor({ timeout: 120000 }).catch(() => undefined);
const whole = await text(page.locator('body'));
note(!/Avg\. miss/i.test(whole) && /Test on recent history/i.test(whole) && /Test miss · 15 min/i.test(whole), 'the other figures are named for what they are: "Test miss", from a "Test on recent history" card; no unlabelled "Avg. miss"');
note(/Daily miss, latest week/i.test(whole), 'and the weekly one says it is the latest week');
note((await page.getByTestId('trend-sparse').count()) === 0 && (await page.locator('text=Accuracy over time').count()) >= 1, 'with several weeks the trend is a chart');
await page.screenshot({ path: path.join(SHOTS, '1-accuracy.png') });

// 2. a sparse group
await open(groups.THIN, '/forecasting/accuracy-heatmap');
await page.getByTestId('accuracy-hero').waitFor({ timeout: 90000 });
await page.waitForFunction(() => !/…/.test(document.querySelector('[data-testid=accuracy-value]')?.textContent || ''), null, { timeout: 60000 });
note((await page.getByTestId('accuracy-hero').getAttribute('data-state')) === 'SPARSE' && /Needs 2\+ completed weeks of data \(\d+ days? so far\)\./.test(await text(page.getByTestId('accuracy-sub'))), 'with under two weeks the headline carries "Needs 2+ completed weeks of data (n days so far)"', await text(page.getByTestId('accuracy-sub')));
await page.getByTestId('trend-sparse').waitFor({ timeout: 60000 }).catch(() => undefined);
note(/Needs 2\+ completed weeks/.test(await text(page.getByTestId('trend-sparse'))) && !/Average miss/.test(await text(page.locator('svg[role=img], .recharts-wrapper').first()).catch(() => '')), 'and the one-point trend chart is replaced by the same note');
// 3. nothing compared at all
await open(groups.NONE, '/forecasting/accuracy-heatmap');
await page.getByTestId('accuracy-hero').waitFor({ timeout: 90000 });
await page.waitForFunction(() => !/…/.test(document.querySelector('[data-testid=accuracy-value]')?.textContent || ''), null, { timeout: 60000 });
note((await text(page.getByTestId('accuracy-value'))) === '–' && /Needs a published forecast compared with actuals/.test(await text(page.getByTestId('accuracy-sub'))), 'with nothing compared it shows a dash and what is needed');

// 4. the same number on the other screens
await open(groups.FULL, '/overview');
await page.waitForFunction(() => /Forecast accuracy/i.test(document.body.innerText), null, { timeout: 90000 });
const ov = await text(page.locator('body'));
note(/Forecast accuracy/i.test(ov) && ov.includes(pctText(hFull)), 'the Overview shows the same figure', pctText(hFull));
note(/Last 28 days: published forecasts missed by/i.test(ov), 'and says it is the last 28 days');
await page.goto(URL + '/forecasting/forecast-dashboard', { waitUntil: 'domcontentloaded' });
await page.waitForFunction((v) => document.body.innerText.includes(v), pctText(hFull), { timeout: 90000 });
const db = await text(page.locator('body'));
note(/Forecast accuracy/i.test(db) && db.includes(pctText(hFull)) && !/\bWAPE\b/.test(db.replace(/Test miss/gi, '')), 'the Dashboard shows the same figure and no longer a bare "WAPE"');
note(/Miss in this view|Test miss/i.test(db), 'its own range figure is named: "Miss in this view" or "Test miss"');
await page.goto(URL + '/forecasting/model-leaderboard', { waitUntil: 'domcontentloaded' });
await page.waitForFunction((v) => document.body.innerText.includes(v), pctText(hFull), { timeout: 90000 });
const md = await text(page.locator('body'));
note(/Forecast accuracy/i.test(md) && md.includes(pctText(hFull)) && !/Average miss, last/i.test(md), 'Models shows the same figure under the same name (it was "Average miss")');
await page.goto(URL + '/forecasting/forecasts', { waitUntil: 'domcontentloaded' });
await page.getByRole('columnheader', { name: 'Test miss' }).waitFor({ timeout: 60000 });
note((await page.getByRole('columnheader', { name: 'WAPE' }).count()) === 0, 'the Forecasts list column is "Test miss", not an unexplained WAPE');

// 5. accessibility, layout, console
await open(groups.FULL, '/forecasting/accuracy-heatmap');
await page.getByTestId('accuracy-hero').waitFor({ timeout: 90000 });
await page.waitForFunction(() => !/…/.test(document.querySelector('[data-testid=accuracy-value]')?.textContent || ''), null, { timeout: 60000 });
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the Accuracy page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
