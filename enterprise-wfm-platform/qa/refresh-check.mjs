// Looks at the Auto-refresh panel on Forecasting > Forecasts in a real browser, against a test stack (it creates its own group and forecast):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node refresh-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-refresh-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };

function historyCsv(queue, days) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 11 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const group = async (name) => {
  const g = (await call(token, 'POST', '/config/groups', { name: `${name} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
  const q = (await call(token, 'POST', '/config/queues', { name: `${name} Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  return g;
};
const build = async (g, weeks = 4, from = addDays(today, -1)) => (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks, fromDay: iso(from) })).json;
const step = (id, s, b = {}) => call(token, 'POST', `/forecast/versions/${id}/${s}`, b);
const versionsOf = async (g) => (await call(token, 'GET', `/forecast/versions?groupId=${g.id}`)).json;


const g = await group('RFSales');
const live = await build(g, 4, addDays(today, -1)); for (const s of ['submit', 'approve', 'publish']) await step(live.id, s);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/429|Failed to load resource/.test(m.text())) errors.push(m.text()); });
await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.goto(URL + '/forecasting/forecasts', { waitUntil: 'domcontentloaded' });
await page.getByLabel('Search forecasts').waitFor({ timeout: 60000 });
await page.waitForSelector('tr[data-family]', { timeout: 30000 });
const fam = page.locator('tr[data-family]', { hasText: `RFSales ${run}` });
const title = `RFSales ${run} · Short-term`;

note((await fam.getByTestId('refresh-chip').count()) === 0, 'no chip while auto-refresh is off');
await page.getByRole('button', { name: `Actions for ${title}` }).click();
const items = await page.getByRole('menuitem').allInnerTexts();
note(items.includes('Auto-refresh…'), 'the forecast menu offers Auto-refresh…', items.join(', '));
await page.getByRole('menuitem', { name: 'Auto-refresh…' }).click();
const dlg = page.getByRole('dialog', { name: /Auto-refresh for/ });
await dlg.waitFor();
note(/Off: nothing runs by itself/.test(await dlg.innerText()), 'the panel starts switched off and says so');
note(/Nothing has run yet/.test(await dlg.innerText()), 'and says nothing has run');
await page.screenshot({ path: path.join(SHOTS, '1-panel-off.png') });

// save a weekly schedule
await dlg.getByLabel('Create a new draft automatically').check();
await dlg.getByLabel('Day of the week').selectOption('2');
await dlg.getByLabel('Time of day').selectOption('7');
await dlg.getByRole('button', { name: 'Save schedule' }).click();
await dlg.getByText('Saved.').waitFor();
await dlg.getByText(/Next:/).waitFor({ timeout: 10000 }).catch(() => undefined);
note(/every Wednesday at 07:00/i.test(await dlg.innerText()) && /Next:/.test(await dlg.innerText()), 'saving shows the schedule in words and when it runs next', (await dlg.innerText()).match(/Every Wednesday[^.]*\. Next: [^.]*/i)?.[0]);
await page.waitForTimeout(800);
note(await dlg.getByRole('button', { name: 'Save schedule' }).isDisabled(), 'Save is greyed out again until something changes');

// run now
await dlg.getByRole('button', { name: 'Run now' }).click();
const card = dlg.getByTestId('run-card');
await card.waitFor({ timeout: 10000 });
note(/Running/.test(await card.innerText()) || /Draft made/.test(await card.innerText()), 'Run now shows a run at once');
await card.getByText('Draft made').waitFor({ timeout: 180000 });
const ct = (await card.innerText()).replace(/\s+/g, ' ');
note(/How the live forecast did/.test(ct) && /The new draft/.test(ct), 'the finished run shows accuracy and the new draft', ct.slice(0, 160));
note(/(Over the \d+ days it shares with v1|same volume as v1 over the \d+ days they share)/.test(ct), 'and compares it with the live version', ct.slice(-300));
note(/told/.test(ct), 'and says who was told');
await page.screenshot({ path: path.join(SHOTS, '2-panel-run.png') });
note(await dlg.getByRole('button', { name: 'Run now' }).isEnabled(), 'Run now is available again');

// keyboard + a11y
const ax = await new AxeBuilder({ page }).include('[role=dialog]').analyze();
note(ax.violations.length === 0, 'no accessibility violations in the panel', ax.violations.map((v) => v.id + ':' + v.nodes.length).join(', '));
await page.keyboard.press('Escape');
await dlg.waitFor({ state: 'hidden' });
note(true, 'Escape closes the panel');

// the chip and the new draft on the list
await page.waitForSelector(`[data-testid=refresh-chip]`, { timeout: 15000 });
note(/Auto-refresh Wednesday at 07:00/.test(await fam.getByTestId('refresh-chip').innerText()), 'the list shows an "Auto-refresh Wednesday at 07:00" chip', await fam.getByTestId('refresh-chip').innerText());
await page.getByRole('button', { name: new RegExp(`^Expand RFSales ${run}`) }).click();
const rows = await page.locator(`tr[data-of^="${g.id}"]`).evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
note(rows.length === 2 && rows.some((r) => /auto refresh/i.test(r) && /draft/i.test(r)), 'the new draft is a second version, named "auto refresh"', rows.map((r) => r.slice(0, 50)).join(' | '));

// open the draft from the panel
await fam.getByTestId('refresh-chip').click();
await dlg.waitFor();
await dlg.getByRole('button', { name: 'Open the draft' }).click();
await page.waitForTimeout(1500);
note(/dashboard/.test(page.url()), '"Open the draft" goes to the dashboard', page.url());


note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`
${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
