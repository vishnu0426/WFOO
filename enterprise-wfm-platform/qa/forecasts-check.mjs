// Looks at Forecasting > Forecasts in a real browser at 1280 px wide, against a test stack (it creates its own groups and forecast versions):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node forecasts-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-forecasts-check');
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

// Sales: v1 live, v2 a draft cloned from it (with an edit), v3 cloned from v2 and approved, v4 a new draft. Billing: one draft. Support: one live version.
const sales = await group('FCSales'), billing = await group('FCBilling'), support = await group('FCSupport');
const s1 = await build(sales, 6, addDays(today, -7)); for (const s of ['submit', 'approve', 'publish']) await step(s1.id, s);
const s2 = (await call(token, 'POST', `/forecast/versions/${s1.id}/clone`)).json;
await call(token, 'PATCH', `/forecast/versions/${s2.id}/adjustments`, { mode: 'pct', value: 15, from: iso(today), to: iso(addDays(today, 2)), reason: 'campaign' });
const s3 = (await call(token, 'POST', `/forecast/versions/${s2.id}/clone`)).json; await step(s3.id, 'submit'); await step(s3.id, 'approve');
const s4 = await build(sales, 2);
const b1 = await build(billing, 2);
const p1 = await build(support, 4); for (const s of ['submit', 'approve', 'publish']) await step(p1.id, s);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
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
await page.goto(URL + '/forecasting/forecasts', { waitUntil: 'domcontentloaded' });
await page.getByLabel('Search forecasts').waitFor({ timeout: 60000 });
await page.waitForSelector('tr[data-family]', { timeout: 30000 });
const fam = (name) => page.locator('tr[data-family]', { hasText: `${name} ${run}` });
const mine = page.locator('tr[data-family]', { hasText: run });          // this run's forecasts, whatever else is on the stack
const versionsIn = (g) => page.locator(`tr[data-of^="${g.id}"]`);

// 1. one row per forecast
const nFam = await mine.count();
note(nFam === 3, 'three forecasts (six versions) are three rows, not six', `${nFam} rows`);
note(/\d+ forecasts? · \d+ versions?/.test(await text()), 'and the page says how many forecasts and versions', (await text()).match(/\d+ forecasts? · \d+ versions?/)?.[0]);
await page.screenshot({ path: path.join(SHOTS, '1-collapsed.png') });

// 2. the live ones are pinned to the top, under their own heading
const order = await mine.evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ')));
note(/live \(\d+\)/i.test(await text()) && /not live yet \(\d+\)/i.test(await text()), 'rows are split under "Live" and "Not live yet" headings');
note(!/FCBilling/.test(order[0]) && !/FCBilling/.test(order[1]) && /FCBilling/.test(order[2]) && /published/i.test(order[0]) && /published/i.test(order[1]), 'the two live forecasts are first, the draft-only one is last');

// 3. one line per row at 1280 px, the Updated column in view, and nothing clipped
const dims = await mine.evaluateAll((rs) => rs.map((r) => Math.round(r.getBoundingClientRect().height)));
note(Math.max(...dims) <= 64, 'each row is one compact line (it was about 85 px)', `${dims.join(', ')} px`);
const upd = page.getByRole('columnheader', { name: 'Updated' });
const ub = await upd.boundingBox();
note(ub && ub.x + ub.width <= 1280 && (await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the Updated column is fully on screen and the page does not scroll sideways', `right edge ${Math.round(ub.x + ub.width)} px`);
const fcol = await page.getByRole('columnheader', { name: 'Forecast' }).boundingBox();
note(fcol && fcol.width >= 150, 'the Forecast column has room for a name (it was squeezed to a few letters)', `${Math.round(fcol?.width ?? 0)} px`);
const hz = await fam('FCSales').locator('td').nth(3).innerText();
note(/^\d{1,2} [A-Z][a-z]{2}( \d{4})? – \d{1,2} [A-Z][a-z]{2}( \d{4})? · \d+ (wk|d|mo)$/.test(hz.replace(/ /g, ' ')), 'the horizon is one line: dates and a length', hz.replace(/ /g, ' '));

// 4. low-value columns are hidden until asked for
let heads = await page.getByRole('columnheader').allInnerTexts();
note(!heads.includes('Channel') && !heads.includes('Interval') && !heads.includes('Owner'), 'Channel, Interval and Owner are not shown by default', heads.join(' | '));
await page.getByRole('button', { name: /^Columns/ }).click();
await page.getByLabel('Owner').check();
await page.keyboard.press('Escape');
heads = await page.getByRole('columnheader').allInnerTexts();
note(heads.includes('Owner'), 'the Columns menu brings one back');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('tr[data-family]');
note((await page.getByRole('columnheader').allInnerTexts()).includes('Owner'), 'and the choice is remembered');
await page.getByRole('button', { name: /^Columns/ }).click(); await page.getByLabel('Owner').uncheck();
await page.getByRole('button', { name: /^Columns/ }).click();

// 5. expand a forecast: its versions, live first, with where each came from
await page.getByRole('button', { name: new RegExp(`^Expand FCSales ${run}`) }).click();
const vrows = await versionsIn(sales).evaluateAll((rs) => rs.map((r) => r.innerText.replace(/\s+/g, ' ').trim()));
note(vrows.length === 4 && /^v1.*published/i.test(vrows[0]) && vrows.some((r) => /^v2 from v1/.test(r)) && vrows.some((r) => /^v3 from v2/.test(r)), 'Sales opens to four versions, the live one first, clones saying "from v1" and "from v2"', vrows.map((r) => r.slice(0, 22)).join(' | '));
await page.screenshot({ path: path.join(SHOTS, '2-expanded.png') });

// 6. the row menus
const menuItems = async (label) => { await page.getByRole('button', { name: label }).click(); const items = await page.getByRole('menuitem').allInnerTexts(); await page.keyboard.press('Escape'); return items; };
const live = await menuItems(`Actions for FCSales ${run} · Short-term v1`);
note(live.join('|') === 'Open|Compare…|Clone to edit|Export CSV', 'the live version offers Open, Compare, Clone and Export (no Archive or Delete)', live.join(', '));
const draft = await menuItems(`Actions for FCSales ${run} · Short-term v2`);
note(draft.join('|') === 'Open|Compare…|Submit for approval|Export CSV|Archive…|Delete…', 'a draft offers its next step, Archive and Delete', draft.join(', '));
const approved = await menuItems(`Actions for FCSales ${run} · Short-term v3`);
note(approved.includes('Publish…') && approved.includes('Return to draft…'), 'an approved version offers Publish and Return to draft');

// 7. compare
await page.getByRole('button', { name: `Actions for FCSales ${run} · Short-term v2` }).click();
await page.getByRole('menuitem', { name: 'Compare…' }).click();
const dlg = page.getByRole('dialog', { name: 'Compare v2' });
await dlg.waitFor();
const headlineEl = dlg.getByTestId('compare-headline');
await headlineEl.waitFor({ timeout: 30000 });
const hl = (await headlineEl.innerText()).replace(/\s+/g, ' ');
note(/^v2 is \d+(\.\d+)?% higher than v1 \(live\) over the \d+ days they share/.test(hl), 'Compare says in a sentence what changed against the live version', hl.slice(0, 120));
note(/They differ most on/.test(hl), 'and where they differ most');
note((await dlg.getByLabel('Compare with').evaluate((el) => el.options[el.selectedIndex].text)).startsWith('v1 · Published (live)'), 'it compares with the live version first');
await dlg.getByLabel('Compare with').selectOption({ index: 1 });
await page.waitForTimeout(800);
note(/v2 is/.test((await headlineEl.innerText())), 'another version can be chosen to compare with');
await page.screenshot({ path: path.join(SHOTS, '3-compare.png') });
await page.keyboard.press('Escape');
note(!(await dlg.isVisible().catch(() => false)), 'Escape closes it');

// 8. archive a draft (reason required), and the live version cannot be archived
await page.getByRole('button', { name: `Actions for FCSales ${run} · Short-term v4` }).click();
await page.getByRole('menuitem', { name: 'Archive…' }).click();
const ad = page.getByRole('dialog', { name: 'Archive v4?' });
await ad.waitFor();
note(await ad.getByRole('button', { name: 'Archive', exact: true }).isDisabled(), 'Archive asks for a reason first');
await ad.getByRole('textbox').fill('replaced by v3');
await ad.getByRole('button', { name: 'Archive', exact: true }).click();
await page.waitForTimeout(1500);
note((await versionsOf(sales)).find((v) => v.id === s4.id).status === 'ARCHIVED', 'the draft is archived and kept');

// 9. publish the approved version from the menu: it goes live and the old live one is archived
await page.getByRole('button', { name: `Actions for FCSales ${run} · Short-term v3` }).click();
await page.getByRole('menuitem', { name: 'Publish…' }).click();
const pd = page.getByRole('dialog', { name: 'Publish v3?' });
await pd.waitFor();
note(/archived/.test(await pd.innerText()), 'Publish explains that the live version is archived');
await pd.getByRole('button', { name: 'Publish', exact: true }).click();
await page.waitForTimeout(1800);
const after = await versionsOf(sales);
note(after.find((v) => v.id === s3.id).status === 'PUBLISHED' && after.find((v) => v.id === s1.id).status === 'ARCHIVED', 'v3 is live and v1 is archived');
const firstExpanded = (await versionsIn(sales).first().innerText()).replace(/\s+/g, ' ').trim();
note(/^v3/.test(firstExpanded) && /published/i.test(firstExpanded), 'and v3 is now the first version listed');

// 10. filters keep the versions that match
await page.getByLabel('Status').selectOption('DRAFT');
await page.waitForTimeout(500);
const draftRows = (await versionsIn(sales).count()) + (await versionsIn(billing).count()), draftFam = await mine.count();
note(draftFam === 2 && draftRows === 2 && !/published/i.test((await versionsIn(sales).allInnerTexts()).join(' ')), 'filtering to Drafts keeps the forecasts that have one, showing only the drafts', `${draftFam} forecasts, ${draftRows} versions`);
await page.getByLabel('Status').selectOption('');

// 11. opening a forecast goes to the dashboard
await page.getByRole('button', { name: new RegExp(`^FCSupport ${run} · Short-term`) }).first().click();
await page.waitForURL(/forecast-dashboard/, { timeout: 15000 });
note(/FCSupport/.test(await text()), 'clicking a forecast opens it on the dashboard');

// 12. quality (back on the list, menu open)
await page.goto(URL + '/forecasting/forecasts', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('tr[data-family]');
await page.getByRole('button', { name: new RegExp(`^Expand FCSales ${run}`) }).click();
await page.getByRole('button', { name: `Actions for FCSales ${run} · Short-term v3` }).click();
await page.waitForTimeout(300);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations (a row menu open)', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 110)).join(' ## ')}`).join(', '));
await page.keyboard.press('Escape');
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
