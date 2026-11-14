// Looks at Workforce > Time & Attendance in a real browser, against a test stack (it creates its own groups, schedules and punches). Shifts today run 00:00-02:00 on the group's clock,
// so the check needs to run after 02:30 there:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node attendance-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-attendance-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const utc = new Date(); const today = utc.toISOString().slice(0, 10);
if (utc.getUTCHours() * 60 + utc.getUTCMinutes() < 150) { console.log('too soon after midnight UTC for a 00:00-02:00 shift to be over: run again later'); process.exit(0); }

const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `ATQ ${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '00:00', latestStart: '00:00', durationHours: 2, mealMinutes: 0 })).json;
const build = async (label, n) => {
  const g = (await call(token, 'POST', '/config/groups', { name: `Atq ${label} ${run}` })).json;
  const ids = [];
  for (let i = 1; i <= n; i++) ids.push((await call(token, 'POST', '/workforce/employees', { employeeNumber: `AQ${label}${run}-${String(i).padStart(2, '0')}`, firstName: `${label}${String(i).padStart(2, '0')}`, lastName: `Aq${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).json.id);
  for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '00:00', endTime: '02:00', headcount: n });
  const vr = await call(token, 'POST', '/scheduling/versions', { groupId: g.id, from: today, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false });
  const v = vr.json;
  if (vr.status !== 201) console.log('create version', label, vr.status, JSON.stringify(vr.json).slice(0, 400));
  const pub = await call(token, 'POST', `/scheduling/versions/${v.id}/publish`, {});
  if (pub.status !== 200) console.log('publish', label, pub.status, JSON.stringify(pub.json).slice(0, 300));
  return { g, ids };
};
// the first solve after the engine starts can be a cold, thin one: build again (a new group) until enough people have a shift today
const until = async (label, n, min) => { for (let t = 1; t <= 3; t++) { const x = await build(`${label}${t}`, n); const w = await wkApi(x.g); if (w.people.filter((p) => p.days.some((d) => d.scheduledHours > 0)).length >= min) return x; } throw new Error(`could not get ${min} people scheduled in group ${label}`); };
const wkApi = async (g, q = '') => (await call(token, 'GET', `/attendance/week?from=${today}&to=${today}&groupId=${g.id}${q}`)).json;
const mixed = await until('M', 8, 5), big = await until('B', 80, 30);
const scheduled = (await wkApi(mixed.g)).people.filter((p) => p.days.some((d) => d.scheduledHours > 0));
if (scheduled.length < 5) { console.log('the schedule gave only', scheduled.length, 'people a shift today'); process.exit(2); }
const punch = (id, i, o) => call(token, 'POST', '/attendance/punches', { employeeId: id, day: today, clockIn: `${today}T${i}:00Z`, clockOut: o ? `${today}T${o}:00Z` : null });
await punch(scheduled[0].employeeId, '00:01', '02:00'); await punch(scheduled[1].employeeId, '00:30', '02:00'); await punch(scheduled[2].employeeId, '00:00', '01:00'); await punch(scheduled[3].employeeId, '00:00', null);
const api = await wkApi(mixed.g);
const bigApi = await wkApi(big.g);
const bigTotal = bigApi.total;
if (bigTotal <= 25) { console.log('group B has only', bigTotal, 'people scheduled today: not enough to page'); process.exit(2); }
const page2 = Math.min(25, bigTotal - 25);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((id) => { if (!localStorage.getItem('wfm_group')) localStorage.setItem('wfm_group', id); }, mixed.g.id);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const chip = (name) => page.getByRole('group', { name: 'Filter by what happened' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
const chipCount = async (name) => Number((await chip(name).innerText()).replace(/\D+/g, ' ').trim().split(' ').pop());
const rows = () => page.locator('.ag-row').count();

await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.goto(URL + '/workforce/attendance', { waitUntil: 'domcontentloaded' });
await chip('Missed punch').waitFor({ timeout: 30000 });
// the page shows the pay week that holds today; the people we made worked today
await page.waitForSelector('.ag-row', { timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: path.join(SHOTS, 'fail-rows.png'), fullPage: true }); console.log('BODY:', (await text()).slice(0, 700), errors.slice(0, 3)); throw e; });

// 1. one row per person, not per person-day; seven days across
const n = await rows();
await page.screenshot({ path: path.join(SHOTS, '0-initial.png') });
note(n === api.total && n <= 8, 'one row per person for the week, not one per person-day', `${n} rows for ${api.total} people`);
const heads = (await page.locator('.ag-header-cell-text').allInnerTexts()).map((s) => s.trim());
note(['Person', 'Scheduled', 'Worked', 'Variance', 'Overtime'].every((h) => heads.includes(h)) && heads.filter((h) => /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/.test(h)).length === 7, 'with the seven days across and the totals', heads.join(' | '));
await page.screenshot({ path: path.join(SHOTS, '1-week.png') });

// 2. chips count person-days and match the server
const want = api.counts;
note(await chipCount('Missed punch') === want.missed && await chipCount('Late') === want.late && await chipCount('Early leave') === want.early && await chipCount('OK') === want.ok && await chipCount('Still clocked in') === want.open, 'the chips show Missed punch, Late, Early leave, Still clocked in and OK, as the server counts them', JSON.stringify({ missed: want.missed, late: want.late, early: want.early, ok: want.ok, open: want.open }));
note(!/Almost no punches/.test(await text()), 'no "punches are missing" banner for a group that has punches');

// 3. chips filter
await chip('Late').click();
await page.waitForTimeout(800);
note(await chip('Late').getAttribute('aria-pressed') === 'true' && await rows() === (await wkApi(mixed.g, '&issue=late')).total, 'clicking Late shows only the people who were late', `${await rows()} rows`);
note(await chipCount('Missed punch') === want.missed, 'and the other chips keep their counts');
await chip('Late').click();
await page.waitForTimeout(800);
note(await chip('Late').getAttribute('aria-pressed') === 'false' && await rows() === n, 'clicking it again clears the filter');

// 4. search
await page.getByLabel('Search people').fill(scheduled[1].employeeNumber);
await page.waitForTimeout(1200);
note(await rows() === 1, 'searching by employee number narrows to one person');
await page.getByLabel('Search people').fill('');
await page.waitForTimeout(1200);

// 5. open a person
await page.getByRole('button', { name: new RegExp(`^${scheduled[1].name}, open this week`) }).click();
const panel = page.getByRole('dialog', { name: new RegExp(`^${scheduled[1].name}: this week`) });
await panel.waitFor();
const pt = (await panel.innerText()).replace(/\s+/g, ' ');
note(/scheduled 00:00–02:00/.test(pt) && /00:30–02:00/.test(pt) && /Late by 30m/.test(pt), 'a person opens in a side panel with the shift, the punch times and "Late by 30m"');
await page.screenshot({ path: path.join(SHOTS, '2-person.png') });

// 6. add a punch for that person from the panel, then remove it
await panel.getByRole('button', { name: 'Add a punch' }).first().click();
const add = page.getByRole('dialog', { name: 'Add a punch' });
await add.waitFor();
note(await add.getByRole('button', { name: 'Save punch' }).isEnabled(), 'adding a punch from a person opens a form with the person already chosen');
await add.getByLabel('Note (optional)').fill('forgot to badge');
await add.getByRole('button', { name: 'Save punch' }).click();
await page.waitForTimeout(1500);
const after = (await wkApi(mixed.g, `&q=${encodeURIComponent(scheduled[1].employeeNumber)}`)).people[0].days[0];
note(after.punches.length === 2, 'saving adds the punch', `${after.punches.length} punches today`);
// after saving, the person's panel is still open behind where the form was
const panel2 = page.getByRole('dialog', { name: new RegExp(`^${scheduled[1].name}: this week`) });
await panel2.getByRole('button', { name: /^Remove punch/ }).last().click();
const confirm = page.getByRole('dialog', { name: 'Remove this punch?' });
await confirm.waitFor();
await confirm.getByRole('button', { name: 'Remove punch' }).click();
await page.waitForTimeout(1500);
note((await wkApi(mixed.g, `&q=${encodeURIComponent(scheduled[1].employeeNumber)}`)).people[0].days[0].punches.length === 1, 'removing a punch asks first, then removes it');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// 7. "Add a punch" is in the header and opens a side panel
const headerBtn = page.getByRole('button', { name: 'Add a punch' }).first();
const box = await headerBtn.boundingBox();
note(box && box.y < 260, '"Add a punch" is a header button, not a form at the foot of the page', `y=${Math.round(box?.y ?? -1)}`);
await headerBtn.click();
const hdr = page.getByRole('dialog', { name: 'Add a punch' });
await hdr.waitFor();
note(await hdr.getByRole('button', { name: 'Save punch' }).isDisabled(), 'it opens a side panel; Save is disabled until a person is chosen');
await page.keyboard.press('Escape');
note(!(await hdr.isVisible().catch(() => false)), 'Escape closes it');

// 8. a group with no punches at all: one note, not a wall of red, and pages
await page.evaluate((id) => localStorage.setItem('wfm_group', id), big.g.id);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.getByText(/Almost no punches for this week/).waitFor({ timeout: 30000 });
await page.waitForSelector('.ag-row');
const bt = await text();
note(/Almost no punches for this week/.test(bt) && /have no punch, which usually means the time-clock file has not been imported/.test(bt), 'when nearly every finished day has no punch it says once that the file is probably not imported', `${bigApi.counts.missed} of ${bigApi.counts.dueScheduled}`);
const noPunchCells = await page.locator('.ag-cell', { hasText: 'No punch' }).count();
const missedCells = await page.locator('.ag-cell', { hasText: /^Missed$/ }).count();
note(noPunchCells > 0 && missedCells === 0, 'and the cells say "No punch" in grey instead of a red "Missed" on every row', `${noPunchCells} muted, ${missedCells} red`);
const size25 = await page.getByLabel('Per page').inputValue();
note(size25 === '50', 'the default page is 50 people');
await page.getByLabel('Per page').selectOption('25');
await page.waitForTimeout(1200);
note(new RegExp(`Showing 1–25 of ${bigTotal} people`).test(await text()) && await rows() > 5, 'a page of 25 shows "Showing 1–25 of N people" (rows are drawn as they scroll into view)', `${await rows()} drawn`);
await page.getByRole('button', { name: 'Next', exact: true }).click();
await page.waitForTimeout(1200);
note(new RegExp(`Showing 26–${Math.min(50, bigTotal)} of ${bigTotal} people`).test(await text()), 'Next shows the following people');
const height = await page.evaluate(() => document.documentElement.scrollHeight);
note(height < 2500, 'the page is a screen or two tall (it was 16,700 px for 351 rows)', `${height}px`);
await page.screenshot({ path: path.join(SHOTS, '3-feed-missing.png'), fullPage: true });

// 9. quality
await page.getByRole('button', { name: new RegExp(', open this week$') }).first().click();
await page.getByRole('dialog', { name: /: this week$/ }).waitFor();
await page.waitForTimeout(500);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations (person panel open)', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 120)).join(' ## ')}`).join(', '));
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
const axe2 = await new AxeBuilder({ page }).analyze();
const bad2 = axe2.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad2.length === 0, 'and none on the page itself', bad2.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 120)).join(' ## ')}`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
