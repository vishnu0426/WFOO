// Looks at excusing attendance problems on Workforce > Time & Attendance in a real browser, against a test stack (it creates its own group, schedule and punches). Shifts today run
// 00:00-02:00 on the group's clock, so run it after 02:30 UTC:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node attendance-exceptions-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-attendance-exceptions-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const utc = new Date(); const today = utc.toISOString().slice(0, 10);
if (utc.getUTCHours() * 60 + utc.getUTCMinutes() < 150) { console.log('too soon after midnight UTC for a 00:00-02:00 shift to be over: run again later'); process.exit(0); }

const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `AXQ ${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '00:00', latestStart: '00:00', durationHours: 2, mealMinutes: 0 })).json;
const wkApi = async (g, q = '') => (await call(token, 'GET', `/attendance/week?from=${today}&to=${today}&groupId=${g.id}${q}`)).json;
// the first solve after the engine starts can be a cold, thin one: build again (a new group) until enough people have a shift today
let g, scheduled = [];
for (let t = 1; t <= 3 && scheduled.length < 6; t++) {
  g = (await call(token, 'POST', '/config/groups', { name: `Axq ${t} ${run}` })).json;
  for (let i = 1; i <= 8; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `AX${t}${run}-${String(i).padStart(2, '0')}`, firstName: `X${String(i).padStart(2, '0')}`, lastName: `Ax${run}`, primaryGroupId: g.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
  for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${g.id}/coverage-windows`, { dayOfWeek: d, startTime: '00:00', endTime: '02:00', headcount: 8 });
  const v = (await call(token, 'POST', '/scheduling/versions', { groupId: g.id, from: today, weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false })).json;
  await call(token, 'POST', `/scheduling/versions/${v.id}/publish`, {});
  scheduled = (await wkApi(g)).people.filter((p) => p.days.some((d) => d.scheduledHours > 0));
}
if (scheduled.length < 6) { console.log('the schedule gave only', scheduled.length, 'people a shift today'); process.exit(2); }
const punch = (id, i, o) => call(token, 'POST', '/attendance/punches', { employeeId: id, day: today, clockIn: `${today}T${i}:00Z`, clockOut: o ? `${today}T${o}:00Z` : null });
await punch(scheduled[0].employeeId, '00:40', '02:00');
await punch(scheduled[1].employeeId, '00:00', '02:00');
const start = await wkApi(g);
const missedAtStart = start.counts.missed;
const target = start.people.find((p) => p.days[0].issues.includes('missed'));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((id) => { if (!localStorage.getItem('wfm_group')) localStorage.setItem('wfm_group', id); }, g.id);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
const chip = (name) => page.getByRole('group', { name: 'Filter by what happened' }).getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
const chipCount = async (name) => Number((await chip(name).innerText()).replace(/\D+/g, ' ').trim().split(' ').pop());

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
await page.waitForSelector('.ag-row');

note(await chip('Excused').isVisible() && await chipCount('Excused') === 0 && await chipCount('Missed punch') === missedAtStart, 'there is an Excused chip, at 0 to begin with', `${missedAtStart} missed`);

// 1. open a person with a missed punch and excuse it
await page.getByRole('button', { name: new RegExp(`^${target.name}, open this week`) }).click();
const panel = page.getByRole('dialog', { name: new RegExp(`^${target.name}: this week`) });
await panel.waitFor();
await panel.getByRole('button', { name: 'Excuse…' }).first().click();
const dlg = page.getByRole('dialog', { name: new RegExp(`^Excuse ${target.name}`) });
await dlg.waitFor();
note(await dlg.getByLabel('Reason').isVisible() && /Pay the scheduled hours/.test(await dlg.innerText()), 'Excuse opens a dialog with a reason and the "pay the scheduled hours" choice');
await page.screenshot({ path: path.join(SHOTS, '1-dialog.png') });
// "Other" needs words
await dlg.getByLabel('Reason').selectOption('OTHER');
note(await dlg.getByRole('button', { name: 'Excuse', exact: true }).isDisabled(), 'choosing "Other" keeps Excuse disabled until you say what happened');
await dlg.getByLabel('What happened').fill('power cut at the depot');
note(await dlg.getByRole('button', { name: 'Excuse', exact: true }).isEnabled(), 'and enables it once you have');
await dlg.getByLabel('Reason').selectOption('CLOCK_FAULT');
// Escape closes the dialog only, back to the person
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
note(!(await dlg.isVisible().catch(() => false)) && await panel.isVisible(), 'Escape closes just the dialog and returns to the person');
await panel.getByRole('button', { name: 'Excuse…' }).first().click();
const dlg2 = page.getByRole('dialog', { name: new RegExp(`^Excuse ${target.name}`) });
await dlg2.getByLabel('Note (optional)').fill('badge reader down');
await dlg2.getByRole('button', { name: 'Excuse', exact: true }).click();
await page.waitForTimeout(1500);
const ex = (await wkApi(g, `&q=${encodeURIComponent(target.employeeNumber)}`)).people[0].days[0];
note(ex.issues.length === 1 && ex.issues[0] === 'excused' && ex.excused[0].reasonCode === 'CLOCK_FAULT', 'saving excuses it on the server', JSON.stringify(ex.excused.map((x) => x.reasonCode)));
const pt = (await panel.innerText()).replace(/\s+/g, ' ');
note(/Excused: Missed punch/.test(pt) && /Clock or badge fault: badge reader down/.test(pt) && /Administrator/.test(pt), 'the person shows "Excused: Missed punch", the reason, the note and who excused it');
await page.screenshot({ path: path.join(SHOTS, '2-excused.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);
note(await chipCount('Missed punch') === missedAtStart - 1 && await chipCount('Excused') === 1, 'the chips follow: Missed down by one, Excused up to one');

// 2. undo it
await page.getByRole('button', { name: new RegExp(`^${target.name}, open this week`) }).click();
await panel.waitFor();
await panel.getByRole('button', { name: /^Undo excuse for missed punch/ }).click();
await page.waitForTimeout(1500);
note((await wkApi(g, `&q=${encodeURIComponent(target.employeeNumber)}`)).people[0].days[0].issues.includes('missed'), 'Undo puts the missed punch back');
await page.keyboard.press('Escape');
await page.waitForTimeout(500);

// 3. excuse everything under the Missed filter at once
await chip('Missed punch').click();
await page.waitForTimeout(900);
const bulk = page.getByRole('button', { name: /^Excuse all \d+ missed punch/ });
note(await bulk.isVisible(), 'with Missed punch selected there is an "Excuse all N missed punch…" button', await bulk.innerText());
await bulk.click();
const bd = page.getByRole('dialog', { name: /^Excuse all \d+ missed punch/ });
await bd.waitFor();
note(/on every page/.test(await bd.innerText()), 'it says it covers every page, not just this one');
await bd.getByLabel('Reason').selectOption('SYSTEM_OUTAGE');
await bd.getByLabel('Note (optional)').fill('clock outage');
await bd.getByRole('button', { name: 'Excuse', exact: true }).click();
await page.waitForTimeout(1800);
const after = await wkApi(g);
note(after.counts.missed === 0 && after.counts.excused === missedAtStart, 'every missed punch is excused', `${after.counts.excused} excused`);
note(/Nobody has that this week/.test(await text()), 'and the Missed filter now shows that nobody has one');
await page.screenshot({ path: path.join(SHOTS, '3-all-excused.png') });
await chip('Excused').click();
await page.waitForTimeout(900);
note(await page.locator('.ag-row').count() === missedAtStart, 'the Excused chip lists those people', `${await page.locator('.ag-row').count()} rows`);

// 4. quality
await page.getByRole('button', { name: new RegExp(', open this week$') }).first().click();
const pn = page.getByRole('dialog', { name: /: this week$/ });
await pn.waitFor();
await pn.getByRole('button', { name: 'Undo excuse for missed punch', exact: false }).first().waitFor();
await page.waitForTimeout(500);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations (person panel with an excuse)', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 120)).join(' ## ')}`).join(', '));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await chip('Excused').click();                       // clear the filter so the bulk button is gone and the page is plain
await page.waitForTimeout(500);
await chip('Missed punch').click();
await page.waitForTimeout(500);
const undone = await wkApi(g);
await call(token, 'DELETE', `/attendance/exceptions/${(await call(token, 'GET', `/attendance/exceptions?from=${today}&to=${today}`)).json[0].id}`);
const bulk2 = (await wkApi(g)).counts.missed === 1;
note(undone.counts.missed === 0 && bulk2, 'an excuse removed through the API shows up as a missed punch again');
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
