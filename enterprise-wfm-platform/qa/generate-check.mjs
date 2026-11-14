// Looks at Scheduling > Generate Schedule in a real browser at 1280 px wide, against a test stack (it creates its own groups, people, templates and forecasts):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node generate-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-generate-check');
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
const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `GENT ${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 2, breakMinutes: 15, flexMinutes: 60, earliestStart: '07:00', latestStart: '13:00', durationHours: 8, mealMinutes: 30 })).json;
async function group(key, { people, forecast, windows }) {
  const g = (await call(token, 'POST', '/config/groups', { name: `GEN${key} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 })).json;
  for (let i = 1; i <= people; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `GN${key}${run}-${String(i).padStart(2, '0')}`, firstName: `Gen${key}${i}`, lastName: `T${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
  if (forecast) {
    const q = (await call(token, 'POST', '/config/queues', { name: `GEN${key} Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
    const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
    await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
    const v = await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: forecast.weeks, fromDay: iso(addDays(today, forecast.startIn)) });
    if (v.status !== 201) console.log('forecast', key, v.status, v.text.slice(0, 200));
    if (forecast.publish && v.json?.id) for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v.json.id}/${s}`, {});
    g.forecast = v.json;
  }
  if (windows) for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '07:00', endTime: '21:00', headcount: windows === 'low' ? 2 : 5 });
  return g;
}
// A: the only published forecast starts well after the default start. B: a draft covers the dates. C: no forecast at all, but coverage windows are set.
const A = await group('A', { people: 30, forecast: { weeks: 4, startIn: 63, publish: true } });
const B = await group('B', { people: 8, forecast: { weeks: 6, startIn: -1, publish: false } });
const C = await group('C', { people: 8, windows: true });
const D = await group('D', { people: 20, windows: 'low' });
note(!!A.forecast?.id && !!B.forecast?.id, 'set-up: a forecast published well ahead, a draft covering today, and a group with no forecast', `${A.forecast?.fromDay} / ${B.forecast?.fromDay}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
let ctx = null, page = null;
const open = async (g) => {
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
  await page.goto(URL + '/scheduling/generate-schedule', { waitUntil: 'domcontentloaded' });
  await page.getByText('Ready to generate?').waitFor({ timeout: 90000 });
  await page.waitForTimeout(1500);
};
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const checklist = () => page.locator('li').filter({ has: page.locator('span') });
const card = () => page.locator('div').filter({ hasText: /^Ready to generate\?/ }).last();
const generate = () => page.getByRole('button', { name: /^Generate schedule$/ });

// 1. the only published forecast starts later
await open(A);
const body1 = await text(page.locator('body'));
const itemA = page.locator('li', { hasText: /covers .* not / }).first();
note(await itemA.isVisible(), 'the checklist says which dates the forecast covers and which were asked for', (await text(itemA)).slice(0, 150));
const mainFix = page.locator('button[data-fix=main]').first();
note(/^Start on \d{1,2} [A-Z][a-z]{2} \d{4}$/.test((await mainFix.innerText()).trim()), 'and offers the fix as a button: "Start on <date>"', (await mainFix.innerText()).trim());
note(await generate().isDisabled(), 'Generate is off meanwhile');
note(/Generate is off: /.test(await text(page.getByTestId('why-off'))), 'and says why, next to the button', (await text(page.getByTestId('why-off'))).slice(0, 110));
await page.screenshot({ path: path.join(SHOTS, '1-stuck.png') });
await mainFix.click();
await page.waitForTimeout(1500);
const startVal = await page.getByLabel('Starts on', { exact: true }).inputValue();
const pw = (await call(token, 'GET', `/scheduling/pay-week?groupId=${A.id}`)).json;
const dow = (iso0) => (new Date(`${iso0}T00:00:00Z`).getUTCDay() + 6) % 7;
note(startVal >= A.forecast.fromDay && startVal <= iso(addDays(new Date(`${A.forecast.fromDay}T00:00:00Z`), 6)) && dow(startVal) === (pw.start ?? 0), 'one click moves the start into the forecast, on the first day of the pay week', `${startVal}, forecast from ${A.forecast.fromDay}`);
note((await page.locator('li', { hasText: /^OK: Forecast: / }).count()) >= 1, 'and the forecast line turns OK');
note(await generate().isEnabled(), 'Generate is on');
const est = await text(page.locator('li', { hasText: /Takes up to about/ }).first());
note(/^i Takes up to about .+ for 30 people: the search stops at \d+ s per four-week window/.test(est), 'the checklist gives an estimated solver time', est.slice(0, 140));
// templates say what the times are
await page.getByRole('button', { name: 'Choose templates' }).click();
const dlg = page.getByRole('dialog', { name: 'Choose shift templates' });
await dlg.waitFor();
const cellTxt = await text(dlg.locator('tr', { hasText: `GENT ${run}` }));
note(/starts 07:00 to 13:00/.test(cellTxt) && /8 h/.test(cellTxt), 'the template list says "starts 07:00 to 13:00" and the length, so the window is not read as the shift\'s hours', cellTxt.slice(0, 90));
await dlg.getByRole('button', { name: 'Done' }).click();

// 2. a draft covers the dates
await open(B);
const draftItem = page.locator('li', { hasText: /Forecast v\d+ covers these dates but is still a draft/ }).first();
note(await draftItem.isVisible(), 'a draft that covers the dates is named, with its state', (await text(draftItem)).slice(0, 120));
const draftBtn = page.locator('button[data-fix=main]').first();
note(/^Open forecast v\d+ to publish it$/.test((await draftBtn.innerText()).trim()), 'with a button to open it', (await draftBtn.innerText()).trim());
await draftBtn.click();
await page.waitForURL(/forecasting\/(all-forecasts|forecasts)/, { timeout: 15000 });
note(/forecasting\/(all-forecasts|forecasts)/.test(page.url()), 'which goes to the Forecasts list', page.url().replace(URL, ''));

// 3. nothing at all: build one, or use the coverage windows
await open(C);
note(await page.locator('li', { hasText: /No published short-term forecast/ }).first().isVisible(), 'with no forecast it says so');
const buildBtn = page.locator('button[data-fix=main]').first();
note((await buildBtn.innerText()).trim() === 'Build a forecast for these dates', 'and offers "Build a forecast for these dates"');
const manualBtn = page.getByRole('button', { name: 'Use manual coverage windows' });
note(await manualBtn.isVisible(), 'and, since the group has coverage windows, "Use manual coverage windows"');
await manualBtn.click();
await page.waitForTimeout(1500);
note(await generate().isEnabled() && (await page.locator('li', { hasText: /coverage windows? set/ }).count()) >= 1, 'which switches the source and turns Generate on');
await page.getByRole('button', { name: 'Choose templates' }).waitFor();
// 4. far more contract time than the work needs: said before the build, with a way to ease it, and the result panel is honest
// eight templates that may start any quarter hour between 06:00 and 18:00: far more shift choices than a 20-person crew needs
for (let k = 1; k <= 8; k++) await call(token, 'POST', '/scheduling/templates', { name: `GENW${k} ${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 2, breakMinutes: 15, flexMinutes: 60, earliestStart: '06:00', latestStart: '18:00', startStepMinutes: 15, durationHours: 8, mealMinutes: 30 });
await open(D);
await page.getByRole('button', { name: 'Use manual coverage windows' }).click();
await page.waitForTimeout(2000);
const crew = page.locator('li', { hasText: /would cover it, so not everyone can reach their full contract/ }).first();
note(await crew.isVisible(), 'a crew far bigger than the work says so before the build, with the crew that would do', (await text(crew)).slice(0, 170));
note(await generate().isEnabled(), 'and does not stop the build');
const lower = page.getByRole('button', { name: 'Lower "Meet contract hours"' });
note(await lower.isVisible(), 'and offers to lower "Meet contract hours"');
await lower.click();
await page.waitForTimeout(500);
note(await lower.count() === 0, 'which applies it (the offer goes away once the weight is 40 or less)');
const search = page.locator('li', { hasText: /shift choices to search/ }).first();
note(await search.isVisible(), 'many templates for the crew: it says how many shift choices there are and that the optimiser may stop at a plain roster', (await text(search)).slice(0, 120));
await generate().click();
await page.getByTestId('result-tiles').waitFor({ timeout: 240000 });
const tiles = await text(page.getByTestId('result-tiles'));
note(/Forecast covered/.test(tiles) && /Paid hours/.test(tiles) && /h needed on shift/.test(tiles), 'the result shows paid hours against what the forecast needs', tiles.slice(0, 200));
note(/Overstaffed: \d+% more paid time than needed/.test(tiles), 'and calls the schedule overstaffed instead of showing a green "covered"');
const tt = await page.getByTestId('result-tiles').locator('div.num').first().locator('div').first().evaluate((e) => getComputedStyle(e).textTransform);
note(tt === 'none', 'the result tiles use the dashboard style', tt);
note(!/Good solution/.test(tiles) || !/Starting roster only/.test(tiles), 'the Solver tile never says both "good solution" and "starting roster only"', tiles.slice(-140));
await page.screenshot({ path: path.join(SHOTS, '4-result.png'), fullPage: true });

// 4. accessibility and console
const ax = await new AxeBuilder({ page }).analyze();
note(ax.violations.length === 0, 'no accessibility violations', ax.violations.map((x) => x.id + ': ' + x.nodes.map((n) => n.html.slice(0, 70)).join(' | ')).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
