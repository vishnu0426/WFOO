// Looks at the Forecast Builder's history check in a real browser at 1280 px wide, against a test stack (it creates its own groups and imports history):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node history-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-history-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { status: r.status, json, text }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const today = new Date(); today.setUTCHours(0, 0, 0, 0);

/** `days` of history whose newest day is `endAgo` days before today. */
function historyCsv(queue, days, endAgo) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 9 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = endAgo + days - 1; n >= endAgo; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}
const group = async (name) => (await call(token, 'POST', '/config/groups', { name: `${name} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
const queue = async (g, name, days, endAgo) => {
  const q = (await call(token, 'POST', '/config/queues', { name: `${name} ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  if (days) { const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, days, endAgo) }); await call(token, 'POST', `/data/imports/${up.json.id}/commit`); }
  return q;
};

// The case from the review: a queue with 56 days of history whose newest data is 12 days old, and a borrowed pattern it no longer needs.
const stale = await group('HCStale');
const voice = await queue(stale, 'Voice', 56, 12);
const donor = await queue(stale, 'Donor', 56, 1);
await call(token, 'PUT', `/config/queues/${voice.id}`, { shapeFromQueueId: donor.id });
// A group whose queue has no history at all.
const empty = await group('HCEmpty');
await queue(empty, 'Nothing', 0, 0);
// A clean group.
const clean = await group('HCClean');
await queue(clean, 'Fine', 56, 1);

const api = (await call(token, 'GET', `/forecast/history-quality?groupId=${stale.id}`)).json;
const v = api.queues.find((x) => x.name === voice.name);
note(v.findings.map((f) => f.kind).join(',') === 'CAUTION,TIP', 'API: the stale data is a caution and the borrowed pattern a tip', v.findings.map((f) => `${f.code}:${f.kind}`).join(', '));
note(v.length.level === 'GOOD' && v.freshness.level === 'OLD' && v.freshness.daysBehind === 12, 'API: length is good and freshness 12 days behind, separately', JSON.stringify([v.length, v.freshness]));
note(api.staleAfterDays === 3, 'API: the stale limit defaults to 3 days');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
const limited = [];
let ctx = null, page = null;
/** A fresh signed-in browser for each group: the app remembers the last group a person used, which would otherwise override the one being looked at. */
const openBuilder = async (g) => {
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
  await page.goto(URL + '/forecasting/forecast-builder', { waitUntil: 'domcontentloaded' });
  await page.getByRole('region', { name: 'Form actions' }).waitFor({ timeout: 60000 });
  await page.getByTestId('history-verdict').waitFor({ timeout: 60000 });
};

const section = () => page.locator('#sec-history');
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

// 1. the stale case
await openBuilder(stale);
const verdict = page.getByTestId('history-verdict');
note((await verdict.getAttribute('data-level')) === 'CAUTION', 'the verdict is a caution, not an error');
const vt = await text(verdict);
note(/^Ready, with a caution/.test(vt) && /You can create this forecast\. One thing will make it less accurate: .*newest data is 12 days old/.test(vt), 'it says you can create the forecast and what will make it less accurate', vt.slice(0, 150));
note(!/\bPoor\b/.test(await text(section())), 'the word "Poor" is gone');
const color = await verdict.evaluate((el) => getComputedStyle(el).borderTopColor);
note(color === 'rgb(183, 121, 31)', 'the verdict box is amber', color);
const line = await text(section().locator(`[data-queue="${voice.name}"] [data-testid=status-line]`));
note(line === 'History length: good (56 days) · Freshness: 12 days behind', 'the status is two facts, so length and freshness are not mixed', line);
const cards = section().locator(`[data-queue="${voice.name}"] [data-testid=issue-card]`);
note((await cards.count()) === 2 && (await cards.nth(0).getAttribute('data-kind')) === 'CAUTION' && (await cards.nth(1).getAttribute('data-kind')) === 'TIP', 'the queue shows a caution card, then a tip card');
const c0 = await text(cards.nth(0));
note(/Newest data is 12 days old/.test(c0) && /What it means: A forecast starts from the last full day/.test(c0), 'the caution says what is wrong and what it means', c0.slice(0, 120));
note(await cards.nth(0).getByRole('button', { name: 'Import the latest data' }).isVisible(), 'and has an "Import the latest data" button');
note(/optional tips/i.test(await text(section())), 'tips sit under their own "Optional tips" heading');
const badge = await text(page.getByRole('button', { name: /^History check/ }));
note(/History check 1$/.test(badge), 'the section badge counts the caution only (1, not 2)', badge);
const foot = await text(page.getByRole('region', { name: 'Form actions' }));
note(/History check: 1 caution\. You can still create the forecast/.test(foot) && !/tip/.test(foot), 'the footer says 1 caution, that you can still create, and does not count the tip', foot.slice(0, 140));
note(/1 caution · 1 tip/.test(vt), 'the verdict line counts them apart: 1 caution · 1 tip');
await page.screenshot({ path: path.join(SHOTS, '1-stale.png') });

// 2. technical settings are behind "Advanced"
note((await page.getByTestId('advanced').count()) === 0 && !/What counts as demand/.test(await text(section())), 'the technical settings are hidden at first');
await section().getByRole('button', { name: 'Advanced settings for this queue' }).first().click();
const adv = page.getByTestId('advanced').first();
note(/What counts as demand in the history/.test(await text(adv)) && /Copy the hourly shape from/.test(await text(adv)), 'Advanced shows them, in plainer words');
await section().getByRole('button', { name: 'Hide advanced settings' }).first().click();

// 3. one click fixes the tip
const clear = cards.nth(1).getByRole('button', { name: /^Clear it/ });
note(await clear.isVisible(), 'the borrowed-pattern tip has a one-click "Clear it (recommended)"');
await clear.click();
await page.waitForFunction((name) => document.querySelectorAll(`#sec-history [data-queue="${name}"] [data-testid=issue-card]`).length === 1, voice.name, { timeout: 20000 });
note((await call(token, 'GET', `/config/queues/${voice.id}`)).json?.shapeFromQueueId == null, 'the setting really is cleared on the queue');
note(!/optional tips/i.test(await text(section())), 'and the tip is gone');

// 4. the import button goes to Data Management
await cards.nth(0).getByRole('button', { name: 'Import the latest data' }).click();
await page.waitForURL(/data-management|staged-imports/, { timeout: 15000 }).catch(() => undefined);
note(/data-management|staged-imports/.test(page.url()), '"Import the latest data" opens Data Management', page.url());

// 5. the stale limit is a setting
await openBuilder(stale);
await section().getByRole('button', { name: 'Advanced settings for this group' }).click();
const limit = page.getByLabel('Days before the newest data is out of date');
note((await limit.inputValue()) === '3', 'the group setting starts at 3 days');
await limit.fill('15');
await limit.blur();
await page.waitForFunction(() => document.querySelector('[data-testid=history-verdict]')?.getAttribute('data-level') === 'READY', null, { timeout: 20000 });
note((await page.getByTestId('history-verdict').getAttribute('data-level')) === 'READY', 'raising it to 15 days makes the same data fine: the verdict turns to Ready');
const afterLine = await text(section().locator(`[data-queue="${voice.name}"] [data-testid=status-line]`));
note(/Freshness: current/.test(afterLine), 'and freshness reads "current"', afterLine);
note((await call(token, 'GET', `/config/groups/${stale.id}`)).json?.historyStaleDays === 15, 'the group keeps it');
note(!/History check: \d/.test(await text(page.getByRole('region', { name: 'Form actions' }))), 'the footer no longer mentions the history');
await call(token, 'PUT', `/config/groups/${stale.id}`, { historyStaleDays: 3 });

// 6. no history at all is the one red case
await openBuilder(empty);
const ev = page.getByTestId('history-verdict');
note((await ev.getAttribute('data-level')) === 'BLOCKED' && /Can't forecast yet/.test(await text(ev)) && /has no history\. Import it first\./.test(await text(ev)), 'no history at all reads "Can\'t forecast yet"', (await text(ev)).slice(0, 100));
note((await ev.evaluate((el) => getComputedStyle(el).borderTopColor)) === 'rgb(200, 74, 74)', 'and only that case is red');
note(await page.getByRole('button', { name: 'Create forecast' }).isDisabled(), 'Create is off, with the reason in the footer');

// 7. a clean group
await openBuilder(clean);
const cl = page.getByTestId('history-verdict');
note((await cl.getAttribute('data-level')) === 'READY' && /^Ready The history is fit to forecast from/.test(await text(cl)), 'a clean history reads "Ready"', (await text(cl)).slice(0, 90));
note(/Nothing to fix/.test(await text(section())) , 'and the queue says "Nothing to fix"');

// 8. accessibility and console
const ax = await new AxeBuilder({ page }).include('#sec-history').analyze();
note(ax.violations.length === 0, 'no accessibility violations in the section', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
await openBuilder(stale);
const ax2 = await new AxeBuilder({ page }).include('#sec-history').analyze();
note(ax2.violations.length === 0, 'and none with cards and buttons showing', ax2.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
