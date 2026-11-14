// Looks at Scheduling > Year Plan in a real browser at 1280 px wide, against a test stack. It builds a small group and a one-week schedule that starts mid-week (today):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node yearplan-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seed, call } from './timeline-seed.mjs';

const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-yearplan-check');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

const s = await seed({ people: 12, status: 'DRAFT', tag: 'yp' });
const { token, group, version } = s;
const plan = (await call(token, 'GET', `/scheduling/versions/${version.id}/plan`)).json;
const WD = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
note(plan.weekStartDay !== undefined && plan.weeks.every((w) => typeof w.days === 'number'), 'the plan API says which weekday the pay week starts on and how many days of each week are in the schedule', `start ${plan.weekStartDay}, days ${plan.weeks.map((w) => w.days).join('+')}`);
note(plan.weeks.reduce((a, w) => a + w.days, 0) === 7, 'a one-week schedule adds up to 7 days', `${plan.weeks.length} rows`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); } }, group.id);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/429/.test(m.text())) errors.push(m.text()); });
await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.goto(URL + '/scheduling/year-plan', { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Weeks at a glance' }).waitFor({ timeout: 90000 });
await page.waitForTimeout(1500);
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const body = await text(page.locator('body'));

// 1. tiles match the Forecast Dashboard: sentence-case labels, no monospace
const tile = page.locator('div.num', { hasText: 'Forecast covered' }).first();
const labelStyle = await tile.locator('div').first().evaluate((e) => { const c = getComputedStyle(e); return { tt: c.textTransform, size: c.fontSize }; });
const valueFont = await tile.locator('div').nth(1).evaluate((e) => getComputedStyle(e).fontFamily);
note(labelStyle.tt === 'none' && !/mono/i.test(valueFont), 'the tiles use the dashboard style: labels not in capitals, numbers not in monospace', `${labelStyle.tt}, ${valueFont.slice(0, 30)}`);
note(await page.locator('div.num').count() === 5, 'five tiles, as before');
// 2. the mini-map has a name and says what it is
note(await page.getByRole('heading', { name: 'Weeks at a glance' }).isVisible() && /One square per week/.test(body), 'the squares are labelled "Weeks at a glance" and explained');
const cells = page.getByRole('group', { name: 'Weeks at a glance' }).getByRole('button');
note(await cells.count() === plan.weeks.length, 'one labelled square per week', String(await cells.count()));
note(/^Week 1, /.test(await cells.first().getAttribute('aria-label')), 'each square can be read by a screen reader', await cells.first().getAttribute('aria-label'));
// 3. the week convention is in the header
const rule = `Weeks run ${WD[plan.weekStartDay]} to ${WD[(plan.weekStartDay + 6) % 7]} (your pay week).`;
note(body.includes(rule), 'the pay-week convention is shown above the squares', rule);
// 4. a week that is cut short says so, and the picker length matches the dates
const rows = page.locator('tbody tr').filter({ hasText: /^Week \d/ });
const firstRow = await text(rows.first());
const partial = plan.weeks.filter((w) => w.days < 7);
note(partial.length === 0 || /\d days? only/.test(firstRow), 'a part-week row says how many days it has', firstRow.slice(0, 70));
const firstDay = new Date(version.periodStart + 'T00:00:00').toLocaleDateString('en', { day: 'numeric', month: 'short' });
note(firstRow.includes(firstDay), 'and starts on the schedule\'s first day, not on the day before it began', firstDay);
const opt = await text(page.getByLabel('Schedule', { exact: true }).locator('option:checked'));
note(/ · 1 wk · /.test(opt), 'a 7-day schedule is called "1 wk" in the picker', opt);
await page.screenshot({ path: path.join(SHOTS, 'year-plan.png'), fullPage: true });
// a square opens the roster
await cells.first().click();
await page.waitForURL(/schedule-timeline/, { timeout: 15000 });
note(/schedule-timeline/.test(page.url()), 'clicking a square still opens that week');
await page.goto(URL + '/scheduling/year-plan', { waitUntil: 'domcontentloaded' });
await page.getByRole('heading', { name: 'Weeks at a glance' }).waitFor({ timeout: 60000 });
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ': ' + x.nodes.map((n) => n.html.slice(0, 70)).join(' | ')).join(', '));
note(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scrolling');
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
