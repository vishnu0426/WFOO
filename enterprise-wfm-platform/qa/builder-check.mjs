// Looks at Forecasting > Forecast Builder in a real browser, against a test stack (it creates its own group with one queue that has plenty of history and one with very little):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node builder-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-builder-check');
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
  let seed = 9 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) { const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1; for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); } }
  return rows.join('\n');
}
const g = (await call(token, 'POST', '/config/groups', { name: `BLD ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
for (const [name, days] of [[`Rich ${run}`, 56], [`Thin ${run}`, 9]]) {
  const q = (await call(token, 'POST', '/config/queues', { name, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
  const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, days) });
  await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
}
const quality = (await call(token, 'GET', `/forecast/history-quality?groupId=${g.id}`)).json;
const findings = quality.queues.reduce((n, q) => n + q.findings.length, 0);
const versionsBefore = (await call(token, 'GET', `/forecast/versions?groupId=${g.id}`)).json.length;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const open = async (width, height) => {
  const ctx = await browser.newContext({ viewport: { width, height } });
  await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); } }, g.id);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // the sign-in screen's organisation lookup is rate-limited after many sign-ins on one test stack: that is not what is being checked
  const limited = [];
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
  return { page, errors, ctx };
};
// scroll the page's own scrolling area (scrollIntoView would also push the app's overflow-hidden frame out of place)
const jumpIn = (page) => (id) => page.evaluate((i) => { const el = document.getElementById(i); let sc = el; while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 1)) sc = sc.parentElement; sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 60; }, id);
let jump = async () => {};
const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

// ---- a wide screen (1920 px): the index is a rail down the left
let { page, errors } = await open(1920, 1000);
jump = jumpIn(page);
const footer = page.getByRole('region', { name: 'Form actions' });
note(findings >= 1, 'the test group has a data-check finding to look for', `${findings} finding(s)`);

// 1. the buttons are in a footer that stays in view, and not at the top any more
const inView = async () => { const b = await footer.boundingBox(); return b && b.y + b.height <= 1000 + 1 && b.y >= 0; };
note(await inView(), 'a footer with the buttons is in view when the page opens');
const scroller = await page.evaluate(() => { let el = document.getElementById('sec-events'); while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement; el.scrollTop = el.scrollHeight; return true; });
await page.waitForTimeout(500);
note(await inView() && await footer.getByRole('button', { name: 'Save draft' }).isVisible() && await footer.getByRole('button', { name: 'Create forecast' }).isVisible(), 'and still there at the bottom of the page: Save draft and Create forecast');
note((await page.getByRole('button', { name: 'Create forecast' }).count()) === 1 && (await page.getByRole('button', { name: 'Save draft' }).count()) === 1, 'each button appears once (they left the top of the page)');
const fs1 = (await footer.innerText()).replace(/\s+/g, ' ');
note(new RegExp(`Short-term forecast for BLD ${run} · \\d+ weeks? from`).test(fs1), 'the footer says what will be created', fs1.slice(0, 110));
await page.evaluate(() => { let el = document.getElementById('sec-scope'); while (el && !/(auto|scroll)/.test(getComputedStyle(el).overflowY)) el = el.parentElement; el.scrollTop = 0; });

// 2. the section index, with the one in view marked
const rail = page.getByRole('navigation', { name: 'Sections of this form' });
note(await rail.isVisible() && !(await page.getByRole('navigation', { name: 'Jump to a section' }).isVisible()), 'on a wide screen the index is a rail down the left');
const items = (await rail.getByRole('button').allInnerTexts()).map((t) => t.replace(/\d+$/, '').trim());
note(['Scope', 'Period', 'Service parameters', 'Model', 'History check', 'Special events'].every((n, i) => items[i] === n), 'it lists the six sections in order', items.join(' | '));
note(await rail.getByRole('button', { name: /^Scope/ }).getAttribute('aria-current') === 'true', 'Scope is marked at the top');
await rail.getByRole('button', { name: /^Special events/ }).click();
await page.waitForTimeout(1200);
const evTop = await page.locator('#sec-events').evaluate((el) => Math.round(el.getBoundingClientRect().top));
note(evTop < 220 && await rail.getByRole('button', { name: /^Special events/ }).getAttribute('aria-current') === 'true', 'clicking a section scrolls to it and marks it', `its top is ${evTop}px from the top of the window`);
await page.evaluate(() => { let el = document.getElementById('sec-service'); const top = el.getBoundingClientRect().top; let sc = el; while (sc && !/(auto|scroll)/.test(getComputedStyle(sc).overflowY)) sc = sc.parentElement; sc.scrollTop += top - 140; });
await page.waitForTimeout(500);
note(await rail.getByRole('button', { name: /^Service parameters/ }).getAttribute('aria-current') === 'true', 'scrolling by hand moves the mark (Service parameters)');
await page.screenshot({ path: path.join(SHOTS, '1-wide.png') });

// 3. the goal as a sentence
await jump('sec-service');
note(/80% answered within 20 s/.test(await text(page)), 'the service goal reads "80% answered within 20 s"');
note(/Answer\s*% of contacts within\s*seconds/.test(await text(page).then((t) => t.replace(/\d+/g, ''))) || /Answer .* % of contacts within .* seconds/.test(await text(page)), 'with the numbers inside the sentence: "Answer [80] % of contacts within [20] seconds"');
await page.getByLabel('Service goal').fill('90');
await page.getByLabel('Threshold seconds').fill('30');
note(/90% answered within 30 s/.test(await text(page)), 'and the sentence follows what is typed');
note(/Agents busy at most \d+% of their logged-in time/.test(await text(page)) && /of paid time is lost to breaks/.test(await text(page)), 'occupancy and shrinkage read as sentences too');

// 4. the data check is open, not collapsed
const finding = page.locator('#sec-history [data-testid=issue-card]').first();
note(await finding.isVisible(), 'the data-check finding is already open (no click needed)', ((await finding.innerText().catch(() => '')) || '').slice(0, 90));
note(/Ready, with a caution/.test(await page.locator('#sec-history').innerText()), 'the section starts with a plain verdict');
note(/\d+$/.test(await rail.getByRole('button', { name: /^History check/ }).innerText()), 'the index shows a count beside History check');
note(/History check: \d+ cautions?\. You can still create/.test((await footer.innerText()).replace(/\s+/g, ' ')), 'and the footer reminds you, with a "Review it" link');
await jump('sec-scope');
await page.getByRole('button', { name: 'Review it' }).click();
await page.waitForTimeout(1200);
note(Math.round(await page.locator('#sec-history').evaluate((el) => el.getBoundingClientRect().top)) < 220, '"Review it" takes you to the finding');

// 5. the events calendar
await jump('sec-events');
const cal = page.getByRole('table', { name: 'Special events calendar' });
await cal.waitFor();
const a = new Date(); a.setDate(15); const b = new Date(); b.setDate(18);
const lab = (d) => d.toLocaleDateString('en', { day: 'numeric', month: 'short', year: 'numeric' });
await cal.getByRole('button', { name: new RegExp(`^${lab(a)}`) }).click();
await cal.getByRole('button', { name: new RegExp(`^${lab(b)}`) }).click();
note(await page.locator('#sec-events input[type=date]').first().inputValue() === iso(new Date(Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()))) && await page.locator('#sec-events input[type=date]').nth(1).inputValue() === iso(new Date(Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()))), 'clicking two days on the calendar fills the From and To dates of a new event');
await page.getByPlaceholder('e.g. Spring sale').fill(`Sale ${run}`);
await page.getByLabel('Change %').fill('20');
await page.getByRole('button', { name: 'Add event' }).click();
await page.waitForTimeout(1500);
note(await cal.getByRole('button', { name: new RegExp(`Sale ${run}`) }).first().isVisible(), 'the event appears on the calendar once added', `${await cal.getByRole('button', { name: new RegExp(`Sale ${run}`) }).count()} days`);
note((await page.locator('#sec-events').innerText()).includes(`Sale ${run}`) && /\+20%/.test(await page.locator('#sec-events').innerText()), 'and in the list, with its +20%');
await page.screenshot({ path: path.join(SHOTS, '2-events.png') });

// 6. Save draft creates a draft and stays; Create opens it
await page.getByRole('button', { name: 'Save draft' }).click();
await page.waitForFunction(() => /Created .* It is a draft/.test(document.body.innerText), null, { timeout: 120000 });
const after1 = (await call(token, 'GET', `/forecast/versions?groupId=${g.id}`)).json.length;
note(after1 === versionsBefore + 1 && /forecast-builder/.test(page.url()), 'Save draft makes one draft and stays on the page', `${versionsBefore} to ${after1} versions`);
await page.getByRole('button', { name: 'Create forecast' }).click();
await page.waitForURL(/forecast-dashboard/, { timeout: 120000 });
note((await call(token, 'GET', `/forecast/versions?groupId=${g.id}`)).json.length === versionsBefore + 2, 'Create forecast makes another and opens it on the dashboard');

// 7. quality at this size
await page.goto(URL + '/forecasting/forecast-builder', { waitUntil: 'domcontentloaded' });
await page.getByRole('region', { name: 'Form actions' }).waitFor({ timeout: 60000 });
await page.waitForTimeout(1500);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 110)).join(' ## ')}`).join(', '));
note(errors.length === 0, 'no console errors (wide)', errors.slice(0, 2).join(' | '));

// ---- a laptop screen (1440 px): the index is a strip along the top
({ page, errors } = await open(1440, 900));
const strip = page.getByRole('navigation', { name: 'Jump to a section' });
note(await strip.isVisible() && !(await page.getByRole('navigation', { name: 'Sections of this form' }).isVisible()), 'on a laptop screen the index is a strip along the top');
await strip.getByRole('button', { name: /^Model/ }).click();
await page.waitForTimeout(1200);
note(await strip.getByRole('button', { name: /^Model/ }).getAttribute('aria-current') === 'true', 'and works the same way');
note(await page.getByRole('region', { name: 'Form actions' }).isVisible(), 'the footer is there too');
await page.screenshot({ path: path.join(SHOTS, '3-laptop.png') });
note(errors.length === 0, 'no console errors (laptop)', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
