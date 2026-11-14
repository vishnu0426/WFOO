// Looks at Forecasting > Scenarios in a real browser at 1280 px wide, against a test stack (it creates its own group, history and forecast versions):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node scenarios-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-scenarios-check');
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
  let seed = 7 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}
const g = (await call(token, 'POST', '/config/groups', { name: `SCNUI ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
const q = (await call(token, 'POST', '/config/queues', { name: `SCNUI Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
const v1 = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 4, fromDay: iso(addDays(today, -1)) })).json;
for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v1.id}/${s}`, {});
const v2 = (await call(token, 'POST', `/forecast/versions/${v1.id}/clone`)).json;
await call(token, 'POST', `/forecast/versions/${v2.id}/archive`, { reason: 'old draft' });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
let ctx = null, page = null;
const open = async () => {
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
  await page.goto(URL + '/forecasting/scenarios', { waitUntil: 'domcontentloaded' });
  await page.getByTestId('baseline-tiles').waitFor({ timeout: 90000 });
};
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const table = () => page.getByTestId('scenario-table');
const row = (name) => table().locator(`[data-row=${name}]`);
const cells = async (name) => (await row(name).locator('td').allInnerTexts()).map((t) => t.trim());
const waitResults = async () => { await page.waitForFunction(() => !/…/.test(document.querySelector('[data-row=fte]')?.textContent || '') , null, { timeout: 90000 }); };
const fte = async (i) => Number((await cells('fte'))[i]);

await open();
// 1. nothing to fill in to start, and no button to press
note((await page.getByRole('button', { name: /Compare with baseline/ }).count()) === 0, 'there is no "Compare with baseline" button');
note((await page.getByTestId('baseline-tiles').count()) === 1 && (await table().count()) === 0, 'with no scenario the baseline is a few tiles, not a table of empty rows');
const tiles = await text(page.getByTestId('baseline-tiles'));
note(/Agents needed \(FTE\) [\d.]+/.test(tiles) && /Service level/.test(tiles) && /Peak agents/.test(tiles) && /Staffing cost/.test(tiles), 'the tiles show agents needed, service level, peak agents and cost', tiles.slice(0, 120));
note((await page.getByTestId('add-scenario').count()) === 1 && /Add a scenario to compare/.test(await text(page.getByTestId('add-scenario'))), 'a dashed "Add a scenario to compare" button invites the first step');
note(!/Choose a starting point above/.test(await text(page.locator('body'))), 'the starting-point message is said once');
const chips = await page.getByRole('group', { name: 'Start from' }).getByRole('button').allInnerTexts();
note(['+10% volume', '+15 s handle time', 'Shrinkage 25%', 'Holiday week'].every((c) => chips.includes(c)), 'four starting points are offered as chips', chips.join(' | '));
note((await page.locator('main input[type=number]').count()) === 0, 'and no blank boxes are on screen until one is chosen');
// the cost rate can be set from the tile, before any scenario
await page.getByTestId('set-cost').click();
await page.getByLabel('Cost per agent hour').fill('30');
await page.getByTestId('cost-editor').getByRole('button', { name: 'Save' }).click();
await page.waitForFunction(() => /\$[\d,]+/.test(document.querySelector('[data-testid=baseline-tiles]')?.textContent || ''), null, { timeout: 60000 });
note(/Staffing cost \$[\d,]+/.test(await text(page.getByTestId('baseline-tiles'))), 'a cost rate set from the tile shows the baseline cost there', (await text(page.getByTestId('baseline-tiles'))).slice(-70));
note((await call(token, 'GET', `/config/groups/${g.id}`)).json.agentCostPerHour === 30, 'and is saved on the group');

// 2. a preset makes a column and the result follows by itself
const baseFte = Number((await text(page.getByTestId('baseline-tiles'))).match(/Agents needed \(FTE\) ([\d.]+)/)[1]);
await page.getByTestId('preset-vol10').click();
await waitResults();
const c1 = await cells('fte');
note(c1.length === 2 && Number(c1[1]) > baseFte, '+10% volume adds a column that needs more agents, with no button pressed', c1.join(' vs '));
const d1 = (await cells('fte-delta'))[1];
note(/^\+\d+(\.\d)? FTE$/.test(d1), 'and says how many more agents against the baseline', d1);
note(await row('fte-delta').locator('td').nth(1).evaluate((el) => el.className.includes('text-critical')), 'more agents is shown in red');
note((await page.getByTestId('preset-vol10').isDisabled()) && (await page.getByTestId('preset-vol10').getAttribute('aria-pressed')) === 'true', 'a chip that is already in use goes quiet instead of adding a duplicate');
const hl = await text(page.getByTestId('headline'));
note(/^Volume \+10% needs [\d.]+ more agents \(\+\d+%\)/.test(hl) && /costs \$[\d,]+ more/.test(hl), 'a sentence says what the scenario does: agents, share and cost', hl.slice(0, 130));
const tb = await table().locator('table').boundingBox(), ab = await table().locator('tbody th').first().boundingBox(), bb = await table().locator('thead th').nth(1).boundingBox();
note(tb.width <= 190 + 170 * 2 + 4, 'the table is as wide as its columns, not stretched across the screen', Math.round(tb.width) + ' px');
const baseCell = await row('fte').locator('td').first().boundingBox();
note(Math.abs((baseCell.x + baseCell.width) - (bb.x + bb.width)) <= 1, 'the Baseline heading lines up with its numbers');
note(baseCell.x - (ab.x + ab.width) < 20, 'and sits right next to the labels');
const order = await table().locator('tbody tr').evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim().slice(0, 18)));
note(order.findIndex((t) => /^Agents needed/.test(t)) < order.findIndex((t) => /^change this/i.test(t)), 'results come first and "Change this" comes under them');
const cardVol = page.getByLabel('Volume +10% volume %');
note((await cardVol.inputValue()) === '10', 'the column holds the preset values, ready to change');

// 3. changing a value recomputes live
await cardVol.fill('30');
await page.waitForTimeout(200);
await waitResults();
const c2 = await fte(1);
note(c2 > Number(c1[1]), 'typing +30% gives a bigger answer, again with no button', `${c1[1]} to ${c2}`);

// 4. handle time in seconds
await page.getByTestId('preset-aht15').click();
await waitResults();
note((await page.getByLabel('Handle time +15 s handle time unit').inputValue()) === 'sec' && (await page.getByLabel('Handle time +15 s handle time change').inputValue()) === '15', '+15 s handle time fills 15 with the unit seconds');
note(Number((await cells('fte'))[2]) > baseFte, 'and needs more agents than the baseline', (await cells('fte')).join(' | '));
note(/\d+ s average/.test(await text(table().locator('tr', { hasText: 'Handle time' }).first())),'the baseline column shows the average handle time it is added to');

// 5. shrinkage and holiday week
await page.getByTestId('preset-holiday').click();
await waitResults();
note((await page.getByLabel('Holiday week shrinkage %').inputValue()) === '35' && (await page.getByLabel('Holiday week volume %').inputValue()) === '25', 'Holiday week is +25% volume and 35% shrinkage');
await page.screenshot({ path: path.join(SHOTS, '1-columns.png') });

// 6. baseline column is read-only and shows the group's settings
const sh = await text(table().locator('tr', { hasText: 'Shrinkage %' }).first());
note(/25%/.test(sh), 'the baseline column shows the group\'s shrinkage (25%) as text, not a box', sh.slice(0, 60));

// 7. cost
await page.locator('[data-row=cost]').waitFor({ timeout: 60000 });
await waitResults();
const cost = await cells('cost');
note(cost.every((c) => /^\$[\d,]+$/.test(c)), 'once set, a Staffing cost row shows money for the baseline and every scenario', cost.join(' | '));
const costDelta = await cells('cost-delta');
note(/^\+\$[\d,]+$/.test(costDelta[1]), 'with the change against the baseline', costDelta.join(' | '));
note(/Agent hours times \$30 an hour/.test(await text(table())), 'the rate is explained under the cost row, with a link to change it');

// 8. remove, save, saved chip
await page.getByRole('button', { name: /^Remove Holiday week/ }).click();
await page.getByRole('button', { name: /^Remove Handle time \+15 s/ }).click();
await page.waitForTimeout(600);
note((await page.locator('[data-testid=scenario-table] thead th').count()) === 3, 'removing columns leaves the baseline and one scenario');
await page.getByRole('button', { name: 'Save with the forecast' }).click();
await page.getByTestId('saved-chip').waitFor({ timeout: 15000 });
note((await page.getByTestId('saved-chip').count()) === 1, 'saving puts the scenario beside the preset chips');
await open();
note((await page.getByTestId('saved-chip').count()) === 1, 'and it is still there after reloading the page');
await page.getByTestId('saved-chip').getByRole('button').first().click();
await waitResults();
note((await page.getByLabel('Volume +10% volume %').inputValue()) === '30', 'clicking the saved chip adds its column again, with the +30% that was saved');
await page.getByRole('button', { name: /^Delete Volume \+10%/ }).click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid=saved-chip]').length === 0, null, { timeout: 15000 });
note(true, 'a saved scenario can be deleted from its chip');

// 9. limits and out-of-range values
for (const id of ['preset-vol10', 'preset-aht15', 'preset-shrink25', 'preset-holiday']) await page.getByTestId(id).click();
note(await page.getByTestId('preset-vol10').isDisabled(), 'at five scenarios the chips switch off, with a note', (await text(page.getByRole('group', { name: 'Start from' }))).slice(-45));
await page.getByLabel('Volume +10% volume %').first().fill('900');
note(/Volume can change between/.test(await text(page.getByRole('alert').first())), 'a value out of range is explained instead of sent');
await page.getByLabel('Volume +10% volume %').first().fill('10');
await waitResults();

// 10. archived forecasts are hidden
const opts = await page.getByLabel('Forecast', { exact: true }).locator('option').allInnerTexts();
note(opts.length === 1 && !/archived/i.test(opts.join(' ')), 'the Forecast picker lists only the live forecast, not the archived one', opts.join(' | '));
const toggle = page.getByLabel(/^Show archived/);
note((await toggle.count()) === 1, 'a "Show archived (1)" box says one is put away');
await toggle.check();
const opts2 = await page.getByLabel('Forecast', { exact: true }).locator('option').allInnerTexts();
note(opts2.length === 2 && opts2.some((o) => /archived/i.test(o)), 'ticking it lists the archived version too', opts2.join(' | '));
await toggle.uncheck();

// 11. layout, accessibility, console
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await page.screenshot({ path: path.join(SHOTS, '2-final.png') });
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
