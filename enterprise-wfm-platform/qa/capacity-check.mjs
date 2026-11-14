// Looks at Forecasting > Staffing in a real browser at 1280 px wide, against a test stack (it creates its own groups, history, forecasts and people):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node capacity-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-capacity-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
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
/** A group with history and a long-term forecast; `fromDay` and `days` set its period. */
async function group(name, { shrink = 20, cats = [], people = 0, fromDay = iso(today), days = 90 } = {}) {
  const g = (await call(token, 'POST', '/config/groups', { name: `${name} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: shrink, targetOccupancy: 88 })).json;
  for (const [n, p] of cats) await call(token, 'POST', `/config/groups/${g.id}/shrinkage-categories`, { name: n, pct: p });
  const q = (await call(token, 'POST', '/config/queues', { name: `${name} Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 60) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  const v = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'LONG', days, fromDay })).json;
  for (let i = 0; i < people; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `CC${run}-${name[3]}${i}`, firstName: `Cc${i}`, lastName: `Run${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
  return { g, v };
}
const needOf = async (v) => { const c = (await call(token, 'GET', `/forecast/versions/${v.id}/capacity?grain=month`)).json; const wk = c.periods.reduce((t, p) => t + p.days, 0) / 7; return c.periods.reduce((t, p) => t + p.agentHours, 0) / (c.fteHoursWeek * wk); };

// A group that is over-staffed: categories add up to 10% while the flat setting says 20%.
const over = await group('CAPOver', { cats: [['Breaks', 5], ['Training', 3], ['Absence', 2]] });
const need = await needOf(over.v);
const staff = Math.ceil(need * 1.6) + 2;
for (let i = 0; i < staff; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `CC${run}-o${i}`, firstName: `Cc${i}`, lastName: `Run${run}`, primaryGroupId: over.g.id, weeklyContractHours: 40, maxWeeklyHours: 40 });
// A group that is short: one person.
const short = await group('CAPShort', { people: 1 });
// A group whose forecast is one month: the first day of a 31-day month ahead.
let first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
while (new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate() < 31) first = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
const one = await group('CAPOne', { people: 2, fromDay: iso(first), days: 31 });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
let ctx = null, page = null;
const open = async (g, url = '/forecasting/capacity-plan') => {
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
  await page.getByLabel('Type', { exact: true }).waitFor({ timeout: 60000 });
  await page.getByLabel('Type', { exact: true }).selectOption('LONG');
};
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

// 1. over-staffed
await open(over.g);
await page.getByTestId('position').waitFor({ timeout: 90000 });
const pos = page.getByTestId('position');
note((await pos.getAttribute('data-state')) === 'OVER', 'the page opens on a state: over-staffed');
const label = await text(page.getByTestId('position-label'));
note(/^Over by \d+ FTE$/.test(label), 'it says "Over by N FTE" in big type', label);
note((await pos.evaluate((el) => getComputedStyle(el).borderTopColor)) === 'rgb(183, 121, 31)', 'in amber, not green and not red');
const story = await text(page.getByTestId('position-story'));
note(/^You have [\d,]+ FTE \([\d,]+ people\) against an average need of [\d,]+\. That is [\d,]+ FTE more than needed \(\+\d+%\)/.test(story), 'and a sentence: what you have, what is needed, how much over', story.slice(0, 150));
const cap = (await call(token, 'GET', `/forecast/versions/${over.v.id}/capacity?grain=month`)).json;
note(Math.abs(cap.headcount.fte - staff) < 0.01, 'the people you have match the active people assigned (contract hours as FTE)', `${cap.headcount.fte} FTE, ${cap.headcount.people} people`);
const kpis = await text(page.locator('div.num', { hasText: 'People you have' }).first());
note(/People you have [\d.]+/.test(kpis) && /active people/.test(kpis), 'the People you have tile counts heads and FTE', kpis.slice(0, 70));
note(/Gap \+[\d.]+ More than needed/.test(await text(page.locator('main'))), 'the Gap tile is a signed number with "More than needed"');
await page.screenshot({ path: path.join(SHOTS, '1-over.png') });

// 2. the waterfall
const wf = await text(page.getByTestId('waterfall'));
note(['Workload', '+ Service-level buffer', '+ Shrinkage', 'People needed', 'People you have', 'Surplus'].every((l) => wf.includes(l)), 'a waterfall: Workload, + Service-level buffer, + Shrinkage, People needed, People you have, Surplus', wf.slice(0, 160));
note((await page.getByTestId('waterfall').locator('path.recharts-rectangle, .recharts-bar-rectangle path').count()) >= 6, 'with a bar for each step');

// 3. where shrinkage comes from
const src = await text(page.getByTestId('shrinkage-source'));
note(/^Shrinkage 10% — 10% from the group's shrinkage categories|^Shrinkage 10% — from the group's shrinkage categories \(breaks 5% \+ training 3% \+ absence 2%\)/.test(src) && /flat 20% setting is not used/.test(src), 'the shrinkage figure names its source, and says the flat 20% is not used', src.slice(0, 190));
await page.getByTestId('shrinkage-source').getByRole('button', { name: 'Change it on WFM Groups' }).click();
await page.waitForURL(/wfm-groups/, { timeout: 15000 }).catch(() => undefined);
note(/wfm-groups/.test(page.url()), 'with a link to WFM Groups', page.url());

// 4. the same shrinkage on the other screens
await page.goto(URL + '/forecasting/forecast-builder', { waitUntil: 'domcontentloaded' });
await page.getByRole('region', { name: 'Form actions' }).waitFor({ timeout: 60000 });
note((await page.getByLabel('Shrinkage', { exact: true }).inputValue()) === '10', 'the Builder shows 10% shrinkage, not the unused flat 20%');
note(/total of the group's shrinkage categories/.test(await text(page.locator('main'))), 'and says it is the total of the categories');
await page.goto(URL + '/forecasting/scenarios', { waitUntil: 'domcontentloaded' });
await page.getByLabel('Type', { exact: true }).waitFor({ timeout: 60000 });
await page.getByLabel('Type', { exact: true }).selectOption('LONG');
await page.getByTestId('baseline-tiles').waitFor({ timeout: 90000 });
await page.getByTestId('preset-vol10').click();
await page.getByTestId('scenario-table').waitFor({ timeout: 90000 });
note(/10%/.test(await text(page.getByTestId('scenario-table').locator('tr', { hasText: 'Shrinkage %' }).first())), 'and Scenarios shows 10% as the baseline');

// 5. several periods get a line, one period a sentence
await open(over.g);
await page.getByTestId('trend-chart').waitFor({ timeout: 90000 });
note((await page.getByTestId('trend-chart').count()) === 1 && (await page.getByTestId('one-period').count()) === 0, 'several months are a line chart with the people you have as a reference line');
note(/People you have \d+/.test(await text(page.getByTestId('trend-chart'))), 'labelled on the chart', (await text(page.getByTestId('trend-chart'))).slice(0, 80));
await open(one.g);
await page.getByTestId('one-period').waitFor({ timeout: 90000 });
const one1 = await text(page.getByTestId('one-period'));
note(/^\d{4}-\d{2}: [\d.]+ people needed on average, [\d.]+ on the busiest day\.$/.test(one1) && (await page.getByTestId('trend-chart').count()) === 0, 'one month is a single sentence, not a one-bar chart', one1);

// 6. the headcount plan says the surplus
await open(over.g);
await page.getByTestId('plan-note').waitFor({ timeout: 90000 });
const pn = await text(page.getByTestId('plan-note'));
note((await page.getByTestId('plan-note').getAttribute('data-tone')) === 'over' && /^No hiring is needed\. You start \d+ above the need/.test(pn), 'the headcount plan says "No hiring is needed. You start N above the need"', pn.slice(0, 120));
const plan = await text(page.locator('main'));
note(/Short-handed Never in this period/.test(plan) && !/First month short-handed/.test(plan), '"Short-handed: Never in this period" replaces "None"');

// 7. short-staffed
await open(short.g);
await page.getByTestId('position').waitFor({ timeout: 90000 });
const sp = page.getByTestId('position');
note((await sp.getAttribute('data-state')) === 'SHORT' && /^Short by \d+ FTE$/.test(await text(page.getByTestId('position-label'))), 'a short group reads "Short by N FTE"');
note((await sp.evaluate((el) => getComputedStyle(el).borderTopColor)) === 'rgb(200, 74, 74)', 'in red');
note(/fewer than needed/.test(await text(page.getByTestId('position-story'))) && /Hiring, overtime/.test(await text(page.getByTestId('position-story'))), 'with what would close it');
await page.waitForSelector('[data-testid=plan-note]', { timeout: 60000 });
note((await page.getByTestId('plan-note').getAttribute('data-tone')) === 'short' && /^Hire \d+ /.test(await text(page.getByTestId('plan-note'))), 'and the headcount plan says how many to hire');

// 8. layout, accessibility, console
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
