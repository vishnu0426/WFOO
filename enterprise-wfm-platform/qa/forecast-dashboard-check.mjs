// Looks at Forecasting > Forecast Dashboard in a real browser, against a test stack. It uses the groups "FD Busy ..." and "FD Flat ..." if they are already there (see forecast-seed.mjs),
// otherwise it creates them (a couple of minutes):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node forecast-dashboard-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seed } from './forecast-seed.mjs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-forecast-dashboard-check');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return iso(d); };
const today = iso(new Date());

let groups = (await call(token, 'GET', '/config/groups')).json;
let busy = groups.find((g) => g.name.startsWith('FD Busy')), flat = groups.find((g) => g.name.startsWith('FD Flat'));
if (!busy || !flat) { const s = await seed(API, token, Date.now().toString(36)); busy = s.busy.group; flat = s.flat.group; }
const queues = (await call(token, 'GET', '/config/queues')).json;
const busyQueues = queues.filter((q) => q.wfmGroupId === busy.id);
const flatVersion = (await call(token, 'GET', `/forecast/versions?groupId=${flat.id}`)).json[0];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, acceptDownloads: true });
// the remembered group and view are set before the app starts (once per tab), not while it is still starting up and about to write its own choice
await ctx.addInitScript(([id]) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); localStorage.removeItem('wfm_fc_view'); } }, [busy.id]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const dataCalls = [];
const tooMany = [];
page.on('response', (r) => { if (r.status() === 429) tooMany.push(r.url().split('/api/v1').pop()); });
page.on('requestfinished', async (r) => { if (/\/forecast\/versions\/[^/]+\/data/.test(r.url())) dataCalls.push(Math.round(r.timing().responseEnd)); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const bar = page.getByRole('group', { name: 'What this page is showing' });

// sign in, with a clean slate for the remembered group and view
await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
dataCalls.length = 0;
const t0 = Date.now();
await page.goto(URL + '/forecasting/forecast-dashboard', { waitUntil: 'domcontentloaded' });
await bar.waitFor({ timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: path.join(SHOTS, 'fail-bar.png'), fullPage: true }); console.log('BODY:', (await text()).slice(300, 1100)); console.log('STORAGE:', await page.evaluate(() => JSON.stringify({ g: localStorage.getItem('wfm_group'), v: localStorage.getItem('wfm_fc_view') }))); console.log('ERRORS:', errors.slice(0, 3)); throw e; });
await page.waitForSelector('.recharts-surface', { timeout: 60000 });
const tFirst = Date.now() - t0;

// 1. one context bar, with the rest behind Advanced
const names = await bar.locator('select, input, button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean));
note(['Group', 'Forecast', 'Day', 'Week', 'All', 'Custom', 'Starting'].every((n) => names.some((x) => x === n)), 'the bar carries Group, Forecast and the date range', names.slice(0, 9).join(' | '));
note(!(await bar.getByLabel('Interval').isVisible().catch(() => false)) && !(await bar.getByLabel('Queue').isVisible().catch(() => false)) && !(await page.getByLabel('Type', { exact: true }).isVisible().catch(() => false)), 'Interval, Queue and Type are not on the bar');
const box = await bar.boundingBox();
note(box.height < 70, 'the bar is one row (it was two)', `${Math.round(box.height)}px tall`);
note(await bar.locator('svg.lucide-sliders-horizontal').count() <= 1, 'the generic slider icon appears once (on Advanced), not on every control', `${await bar.locator('svg.lucide-sliders-horizontal').count()}`);
await page.screenshot({ path: path.join(SHOTS, '1-busy.png') });

// 2. opens on today when the forecast covers it; a forecast that starts in the future opens on its first day
note(await bar.getByLabel('Starting').inputValue() === today, 'a forecast that covers today opens on today', today);
const opt = await bar.getByLabel('Forecast').evaluate((el) => [...el.querySelectorAll('optgroup')].map((g) => g.label));
note(opt.includes('Short-term'), 'the Forecast list is grouped by type (short-term / long-term)', opt.join(', '));

// 3. Advanced holds Interval and Queue
await bar.getByRole('button', { name: /^Advanced/ }).click();
const adv = page.getByRole('dialog', { name: 'Advanced filters' });
await adv.waitFor();
note(await adv.getByLabel('Interval').isVisible() && await adv.getByLabel('Queue').isVisible(), 'Advanced opens a box with Interval and Queue');
await adv.getByLabel('Queue').selectOption({ label: busyQueues[0].name });
await page.waitForTimeout(800);
note(/Advanced\s*1/.test((await bar.getByRole('button', { name: /^Advanced/ }).innerText()).replace(/\s+/g, ' ')), 'a choice made there shows as a count on the Advanced button');
await page.screenshot({ path: path.join(SHOTS, '2-advanced.png') });
await page.keyboard.press('Escape');
note(!(await adv.isVisible().catch(() => false)), 'Escape closes it');

// 4. Today
const other = addDays(today, 2);
await bar.getByLabel('Starting').fill(other);
await page.waitForTimeout(600);
const todayBtn = bar.getByRole('button', { name: 'Today', exact: true });
note(await todayBtn.isVisible(), 'a Today button appears once you have moved off today');
await todayBtn.click();
await page.waitForTimeout(400);
note(await bar.getByLabel('Starting').inputValue() === today && !(await todayBtn.isVisible().catch(() => false)), 'and takes you back to today');

// 5. the choice is shared with the other Forecasting pages and kept between visits
await bar.getByRole('button', { name: 'Week', exact: true }).click();
await bar.getByLabel('Starting').fill(other);
await page.waitForTimeout(500);
await page.goto(URL + '/forecasting/adjustments', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: /^Advanced/ }).waitFor({ timeout: 30000 });
await page.getByRole('button', { name: /^Advanced/ }).click();           // on Adjustments the queue is behind Advanced, in the same bar
note(await page.getByRole('dialog', { name: 'Advanced filters' }).getByLabel('Queue').evaluate((el) => el.options[el.selectedIndex].text) === busyQueues[0].name, 'Adjustments opens on the queue chosen on the dashboard');
await page.keyboard.press('Escape');
note((await page.getByLabel('Day', { exact: true }).first().inputValue().catch(() => '')) === other, 'and on the same day', other);
await page.goto(URL + '/forecasting/forecast-dashboard', { waitUntil: 'domcontentloaded' });
await bar.waitFor();
note(await bar.getByRole('button', { name: 'Week', exact: true }).getAttribute('aria-pressed') === 'true' && await bar.getByLabel('Starting').inputValue() === other, 'coming back to the dashboard (and reloading the page) keeps the range and date', `${other}, Week`);
await bar.getByRole('button', { name: /^Advanced/ }).click();
note(await page.getByRole('dialog', { name: 'Advanced filters' }).getByLabel('Queue').evaluate((el) => el.options[el.selectedIndex].text) === busyQueues[0].name, 'and the queue');
await page.keyboard.press('Escape');
// back to a plain day for the rest
await bar.getByRole('button', { name: 'Day', exact: true }).click();
await bar.getByRole('button', { name: /^Advanced/ }).click();
await page.getByRole('dialog', { name: 'Advanced filters' }).getByRole('button', { name: 'Reset' }).click();
await page.keyboard.press('Escape');
await bar.getByRole('button', { name: 'Today', exact: true }).click().catch(() => {});

// 6. charts with nothing to say collapse to a line; charts with something to say stay
await page.waitForSelector('.recharts-surface');
const aht = page.getByRole('region').filter({ hasText: 'Average handle time by time of day' });
const bt = await text();
note(/Required versus scheduled staff/.test(bt) && /No published schedule covers this range/.test(bt), 'the staffing chart with no schedule behind it is one line saying so, with a peak', (bt.match(/It peaks at [^.]+\./) || [''])[0]);
await page.getByRole('button', { name: 'Show chart' }).first().click();
await page.waitForTimeout(400);
note(await page.getByRole('button', { name: 'Hide chart' }).isVisible(), 'Show chart draws it anyway, and Hide chart puts it away again');
await page.getByRole('button', { name: 'Hide chart' }).click();
note(/Average handle time by time of day/.test(bt) && !/Handle time is a steady/.test(bt) && (await page.locator('.recharts-surface').count()) >= 2, 'a handle time that changes through the day is still drawn', `${await page.locator('.recharts-surface').count()} charts`);
await page.screenshot({ path: path.join(SHOTS, '3-busy-collapsed.png'), fullPage: true });

// 7. the flat forecast, which starts in the future
await bar.getByLabel('Group').selectOption({ value: flat.id });
await page.waitForTimeout(2500);
await bar.getByLabel('Starting').waitFor();
note(await bar.getByLabel('Starting').inputValue() === flatVersion.fromDay, 'a forecast that starts in the future opens on its first day', flatVersion.fromDay);
await page.waitForSelector('.recharts-surface');
await page.waitForTimeout(800);
const ft = await text();
note(/Handle time is a steady 180 sec/.test(ft), 'a handle time that is 180 s all day is one line, not a flat chart', (ft.match(/Handle time is a steady [^.]+\./) || [''])[0]);
await page.screenshot({ path: path.join(SHOTS, '4-flat.png'), fullPage: true });
await page.getByRole('button', { name: 'Show chart' }).first().click().catch(() => {});

// 8. the exports say what they export
const labels = await page.getByRole('button').evaluateAll((els) => els.map((e) => (e.textContent || '').trim()));
note(labels.includes('Export this view') && labels.includes('Export all intervals (CSV)') && !labels.includes('Export all') && !labels.includes('Export'), 'the exports are "Export this view" and "Export all intervals (CSV)"');
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.getByRole('button', { name: 'Export this view' }).click()]);
const csv = fs.readFileSync(await dl.path(), 'utf8').trim().split('\n');
const tableRows = await page.locator('table.num tbody tr').count();
note(csv[0] === 'Interval,Historical,Forecast,Actual,AHT (s),Required,Scheduled' && csv.length - 1 === tableRows, 'Export this view is exactly the rows in the table', `${csv.length - 1} rows`);

// 9. speed: the data behind the first chart comes back quickly, and the page draws promptly
const sorted = [...dataCalls].sort((x, y) => x - y), median = sorted[Math.floor(sorted.length / 2)];
note(median < 300 && sorted.at(-1) < 3000, 'the forecast data behind the charts comes back quickly: most requests in a few hundred ms, the first one for each queue (worked out once per revision) within 3 s (it was about 0.7 s for every request before, on this data)', `median ${median} ms, slowest ${sorted.at(-1)} ms of ${sorted.length}`);
note(tFirst < 8000, 'the first chart is up within 8 s of opening the page on a dev server', `${tFirst} ms`);

// 10. quality
await bar.getByRole('button', { name: /^Advanced/ }).click();
await page.waitForTimeout(300);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations (Advanced open)', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 110)).join(' ## ')}`).join(', '));
// the sign-in screen's organisation lookup is rate-limited after many sign-ins on one test stack: that is not what is being checked
if (tooMany.length && tooMany.every((u) => u.startsWith('/auth/login-options'))) { for (let i = errors.length - 1; i >= 0; i--) if (/429/.test(errors[i])) errors.splice(i, 1); tooMany.length = 0; }
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | ') + (tooMany.length ? ` [429 on: ${[...new Set(tooMany)].slice(0, 4).join(', ')}, ${tooMany.length} times]` : ''));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
