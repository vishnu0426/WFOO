// Looks at the Pooling benefit picker (Forecasting > Staffing, bottom of the page) in a real browser at 1280 px wide, against a test stack (it creates its own groups, history, forecasts and people):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node pooling-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-pooling-check');
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
  let seed = 3 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); }
  }
  return rows.join('\n');
}
const site = (await call(token, 'POST', '/config/sites', { name: `Pool site ${run}`, timezone: 'UTC' })).json;
const other = (await call(token, 'POST', '/config/sites', { name: `Other site ${run}`, timezone: 'UTC' })).json;
const ids = {};
async function group(key, forecast, siteId) {
  const g = (await call(token, 'POST', '/config/groups', { name: `POOL${key} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88, ...(siteId ? { siteId } : {}) })).json;
  ids[key] = g.id;
  if (!forecast) return g;
  const q = (await call(token, 'POST', '/config/queues', { name: `POOL${key} Q ${run}`, channel: key === 'B' ? 'CHAT' : 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
  const v = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 2, fromDay: iso(today) })).json;
  for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v.id}/${s}`, {});
  return g;
}
const A = await group('A', true, site.id), B = await group('B', true, site.id), D = await group('D', true, other.id);
await group('C', false, null);
for (let i = 0; i < 30; i++) await call(token, 'POST', '/config/groups', { name: `POOLX${i} ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 });
await call(token, 'POST', '/workforce/employees', { employeeNumber: `POOL${run}-1`, firstName: 'Pool', lastName: `Run${run}`, primaryGroupId: A.id, eligibleGroupIds: [A.id, B.id], weeklyContractHours: 40, maxWeeklyHours: 40 });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); } }, A.id);
const page = await ctx.newPage();
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
await page.goto(URL + '/forecasting/capacity-plan', { waitUntil: 'domcontentloaded' });
await page.getByTestId('pool-picker').waitFor({ timeout: 90000 });
await page.waitForFunction(() => /groups can be compared on/.test(document.querySelector('[data-testid=pool-count]')?.textContent || ''), null, { timeout: 60000 });
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');
const picker = page.getByTestId('pool-picker');
const list = page.getByTestId('pool-list');

// 1. no wall of groups
const listed = (await list.locator('li').allInnerTexts()).join(' | ');
note(['A', 'B', 'D'].every((k) => listed.includes(`POOL${k} ${run}`)), 'the list holds the groups that can be compared', listed.slice(0, 120));
note(!listed.includes(`POOLC ${run}`) && !listed.includes('POOLX'), 'groups with no forecast that day are not in it');
const lb = await list.boundingBox();
note(lb.height <= 250, 'the list is a short scrolling box, not a wall of pills', Math.round(lb.height) + ' px');
note(/^\d+ of \d+ groups can be compared on \d{4}-\d{2}-\d{2}$/.test(await text(page.getByTestId('pool-count'))), 'a line says how many of the groups can be compared that day', await text(page.getByTestId('pool-count')));
const un = page.getByTestId('pool-unavailable');
note(/^\d+ groups can't be compared on this day: no published short-term forecast covers it$/.test(await text(un.locator('summary'))) && !(await un.evaluate((el) => el.open)), 'the rest are one collapsed line saying why', await text(un.locator('summary')));
await un.locator('summary').click();
note((await text(un)).includes(`POOLX0 ${run}`), 'and can be opened to see them');
await un.locator('summary').click();
note((await page.getByRole('button', { name: /^Compare$/ }).count()) === 0, 'there is no Compare button to press');
note(/Pick at least two groups to compare\./.test(await text(page.getByTestId('pool-why'))), 'and a line says why nothing shows yet');
await page.screenshot({ path: path.join(SHOTS, '1-picker.png') });

// 2. quick picks
const ideas = await page.getByTestId('pool-idea').allInnerTexts();
note(ideas.length >= 1 && ideas.some((t) => t.includes(`POOLA ${run}`) && t.includes(`POOLB ${run}`) && /share 1/.test(t)), 'a quick pick names the pair that already shares people', ideas.join(' | ').replace(/\s+/g, ' ').slice(0, 100));
const sites = await page.getByTestId('pool-site').allInnerTexts();
note(sites.some((t) => t.includes(`Pool site ${run}`) && /2/.test(t)) && !sites.some((t) => t.includes(`Other site ${run}`)), 'and one for a site with two groups (not for a site with one)', sites.join(' | ').replace(/\s+/g, ' ').slice(0, 100));

// 3. picking two gives the answer by itself
await page.getByTestId('pool-idea').filter({ hasText: run }).first().click();
const sel = await text(page.getByTestId('pool-selected'));
note(/Picked 2 of 8/.test(sel) && sel.includes(`POOLA ${run}`) && sel.includes(`POOLB ${run}`), 'the picked groups show as chips with a count', sel.slice(0, 100));
await page.getByTestId('pool-headline').waitFor({ timeout: 120000 });
const hl = await text(page.getByTestId('pool-headline'));
note(new RegExp(`^Pooling POOL[AB] ${run} and POOL[AB] ${run} (needs [\\d,]+ fewer agent hours on the day \\(−\\d+%\\)|gives no gain on this day)`).test(hl), 'the answer is one sentence, with no button pressed', hl.slice(0, 140));
note(/Separate pools/.test(await text(page.locator('body'))) && /One shared pool/.test(await text(page.locator('body'))), 'the numbers and chart follow it');
note((await page.getByTestId('pool-why').count()) === 0, 'and the "pick at least two" line is gone');
await page.screenshot({ path: path.join(SHOTS, '2-answer.png') });

// 4. remove, search, site pick
await page.getByRole('button', { name: new RegExp(`^Remove POOLB ${run}`) }).click();
await page.waitForFunction(() => !document.querySelector('[data-testid=pool-headline]'), null, { timeout: 15000 });
note(/Pick at least two groups/.test(await text(page.getByTestId('pool-why'))) && /Picked 1 of 8/.test(await text(page.getByTestId('pool-selected'))), 'taking one off goes back to "pick at least two"');
await page.getByLabel('Search groups').fill(`POOLD ${run}`);
note((await list.locator('li').count()) === 1 && (await text(list)).includes(`POOLD ${run}`), 'search narrows the list to the group typed');
await page.getByLabel('Search groups').fill('chat');
note((await text(list)).includes(`POOLB ${run}`) && !(await text(list)).includes(`POOLA ${run}`), 'search also finds a channel (chat)');
await page.getByLabel('Search groups').fill('zzzz');
note(/No group matches that search/.test(await text(list)), 'and says when nothing matches');
await page.getByLabel('Search groups').fill('');
await page.getByRole('button', { name: 'Clear' }).click();
await page.getByTestId('pool-site').filter({ hasText: `Pool site ${run}` }).click();
note(/Picked 2 of 8/.test(await text(page.getByTestId('pool-selected'))), '"All at <site>" picks that site\'s groups in one click');
await page.getByTestId('pool-headline').waitFor({ timeout: 120000 });
await list.getByRole('checkbox', { name: new RegExp(`POOLD ${run}`) }).check();
await page.waitForFunction((n) => (document.querySelector('[data-testid=pool-headline]')?.textContent || '').includes(n), `POOLA ${run}, POOLB ${run} and POOLD ${run}`, { timeout: 120000 }).catch(() => undefined);
note((await text(page.getByTestId('pool-headline'))).includes(`POOLA ${run}, POOLB ${run} and POOLD ${run}`), 'three groups read "A, B and D" in the sentence', (await text(page.getByTestId('pool-headline'))).slice(0, 100));

// 5. a day with no forecast
await page.locator('input[type=date][aria-label=Day]').fill(iso(addDays(today, 200)));
await page.waitForFunction(() => /0 of \d+ groups can be compared/.test(document.querySelector('[data-testid=pool-count]')?.textContent || ''), null, { timeout: 30000 });
note(/Picked 0 of 8/.test(await text(page.getByTestId('pool-selected'))), 'a day without forecasts drops the picks that can no longer be compared');
note(/No group has a published short-term forecast for this day/.test(await text(list)), 'and says that none can be');

// 6. layout, accessibility, console
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).include('[data-testid=pool-picker]').analyze();
note(ax.violations.length === 0, 'no accessibility violations in the picker', ax.violations.map((x) => x.id + ':' + x.nodes.length).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
