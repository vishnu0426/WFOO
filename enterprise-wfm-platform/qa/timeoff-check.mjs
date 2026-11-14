// Looks at Workforce > Time Off in a real browser, against a test stack (it creates its own group, schedule and requests):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node timeoff-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-timeoff-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;
const plus = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// dates far ahead and different every run (a newer run sorts above older ones in the list), so earlier runs on the same database do not get in the way
const BASE_DAY = plus('2090-01-01', 4 * (Math.floor(Date.now() / 60000) % 2000));
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// a group of six who need five on shift 08:00-17:00 every day, scheduled for the coming week, plus people who joined after it was published
const group = (await call(token, 'POST', '/config/groups', { name: `TOQ ${run}` })).json;
const mk = async (n, label) => (await call(token, 'POST', '/workforce/employees', { employeeNumber: `TQ${run}-${n}`, firstName: label, lastName: `To${run}`, primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).json.id;
const crew = []; for (let i = 1; i <= 6; i++) crew.push(await mk(i, `Crew${i}`));
const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `TOQT${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60 })).json;
for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '17:00', headcount: 5 });
const from = new Date(); from.setDate(from.getDate() + 2);
const ver = (await call(token, 'POST', '/scheduling/versions', { groupId: group.id, from: iso(from), weeks: 1, timeLimitSec: 20, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false })).json;
await call(token, 'POST', `/scheduling/versions/${ver.id}/publish`, {});
const shifts = (await call(token, 'GET', `/scheduling/versions/${ver.id}/shifts`)).json;
const worker = shifts[0].employeeId, workDay = shifts[0].day;
const workerName = (await call(token, 'GET', `/workforce/employees/${worker}`)).json.name;
const spares = []; for (let i = 1; i <= 3; i++) spares.push(await mk(10 + i, `Spare${i}`));
const BASE_DAY2 = plus(BASE_DAY, 2);
const rule = (await call(token, 'POST', '/self-service/time-off-rules', { kind: 'BLACKOUT', groupId: group.id, startDate: BASE_DAY2, endDate: BASE_DAY2, strict: true, reason: 'Audit week' })).json;
const ask = async (id, day) => (await call(token, 'POST', '/workforce/time-off', { employeeId: id, type: 'VACATION', startDate: day, endDate: day })).json.id;
const reqWorker = await ask(worker, workDay);
const r1 = await ask(spares[0], BASE_DAY), r2 = await ask(spares[1], plus(BASE_DAY, 1)), r3 = await ask(spares[2], BASE_DAY2);   // the third falls on the blackout day
const impactWorker = (await call(token, 'GET', `/workforce/time-off/${reqWorker}/impact`)).json;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 1100 } })).newPage();
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
await page.goto(URL + '/workforce/time-off', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: new RegExp(`^Spare1 To${run}, review request`) }).first().waitFor({ timeout: 30000 });

// 1. list with a tick box in the first column, a calendar toggle and what is waiting
note(await page.getByRole('button', { name: 'List', exact: true }).isVisible() && await page.getByRole('button', { name: 'Calendar', exact: true }).isVisible(), 'a List and Calendar switch is at the top');
note(/waiting for a decision/.test(await text()), 'the list says how many requests are waiting');
const firstBox = await page.locator('.ag-row').first().locator('input[type=checkbox]').boundingBox();
const nameCell = await page.locator('.ag-row').first().locator('[col-id="employeeName"]').boundingBox();
note(firstBox && nameCell && firstBox.x < nameCell.x, 'the tick box is in the first column, before the name');
await page.screenshot({ path: path.join(SHOTS, '1-list.png') });

// 2. drawer from the list for the one on the blackout day: balance, rules, cover, and why it cannot be one-clicked
await page.getByRole('button', { name: new RegExp(`^Spare3 To${run}, review request`) }).first().click();
const drawer = page.getByRole('dialog', { name: new RegExp(`Time off request for Spare3 To${run}`) });
await drawer.waitFor({ timeout: 15000 });
await drawer.getByText('Cover on each day').waitFor();
const dt = (await drawer.innerText()).replace(/\s+/g, ' ');
note(/Audit week/.test(dt), 'the drawer shows the blackout rule that is in the way');
note(/Needs your judgement/.test(dt), 'and says the request needs judgement, with the reasons');
note(await drawer.getByRole('button', { name: /^Approve anyway/ }).isVisible() && !(await drawer.getByRole('button', { name: /^Approve$/ }).isVisible().catch(() => false)), 'the plain Approve button is replaced by "Approve anyway…"');
await page.screenshot({ path: path.join(SHOTS, '2-drawer-blocked.png') });
await page.keyboard.press('Escape');
note(!(await drawer.isVisible().catch(() => false)), 'Escape closes the drawer');

// 3. bulk: tick the three waiting ones, approve the ones that pass
for (const n of ['Spare1', 'Spare2', 'Spare3']) {
  const row = page.locator('.ag-row', { hasText: `${n} To${run}` }).first();
  await row.locator('input[type=checkbox]').check();
}
const bar = page.getByRole('region', { name: 'Selected requests' });
note(await bar.isVisible(), 'ticking requests shows a bar with the number selected');
const approveBulk = bar.getByRole('button', { name: /^Approve 3 that pass the rules$/ });
note(await approveBulk.waitFor({ timeout: 5000 }).then(() => true, () => false), 'with a button to approve the ones that pass the rules');
await page.screenshot({ path: path.join(SHOTS, '3-bulk-bar.png') });
await approveBulk.click();
await page.getByText(/Approved 2 requests/).waitFor({ timeout: 15000 });
const after = await text();
note(/1 left for you to look at/.test(after) && /Audit week/.test(after), 'two were approved; the blackout one was left, with the reason');
const st = (await call(token, 'GET', `/workforce/time-off?from=${BASE_DAY}&to=${BASE_DAY2}`)).json;
note(st.find((t) => t.id === r1).status === 'APPROVED' && st.find((t) => t.id === r2).status === 'APPROVED' && st.find((t) => t.id === r3).status === 'REQUESTED', 'and the server agrees');
await page.screenshot({ path: path.join(SHOTS, '4-bulk-result.png') });

// 4. calendar: the worker's request on the day they work
await page.getByRole('button', { name: 'Calendar', exact: true }).click();
await page.getByRole('table', { name: 'Time off calendar' }).waitFor();
const [wy, wm] = workDay.split('-').map(Number);
const now = new Date();
let hops = (wy - now.getFullYear()) * 12 + (wm - 1 - now.getMonth());
for (; hops > 0; hops--) await page.getByRole('button', { name: 'Next month' }).click();
const chip = page.getByRole('button', { name: new RegExp(`^${workerName}, Vacation, waiting, ${workDay}`) });
await chip.waitFor({ timeout: 15000 });
note(true, 'the calendar shows the request as a chip on the day', workDay);
await page.screenshot({ path: path.join(SHOTS, '5-calendar.png') });

// 5. the drawer from the calendar says what approving leaves
await chip.click();
const d2 = page.getByRole('dialog', { name: new RegExp(`Time off request for ${workerName}`) });
await d2.getByText('Cover on each day').waitFor({ timeout: 15000 });
const t2 = (await d2.innerText()).replace(/\s+/g, ' ');
const want = impactWorker.coverage.headline;
note(t2.includes(want), 'the drawer headline is the one the API gives', want);
const dayRow = impactWorker.coverage.days[0];
note(t2.includes(`${dayRow.afterPercent}%`), 'and the table shows the cover if approved', `${dayRow.beforePercent}% now, ${dayRow.afterPercent}% if approved`);
await page.screenshot({ path: path.join(SHOTS, '6-drawer-cover.png') });

// 6. approve anyway needs a reason when something is open; decline needs a reason
if (!impactWorker.passes.ok) {
  await d2.getByRole('button', { name: /^Approve anyway/ }).click();
  const dlg = page.getByRole('dialog', { name: /Approve .* anyway/ });
  const go = dlg.getByRole('button', { name: 'Approve anyway' });
  note(await go.isDisabled(), '"Approve anyway" stays disabled until a reason is given');
  await dlg.getByRole('textbox').fill('Covered by overtime');
  await go.click();
  await page.waitForTimeout(1500);
  const w = (await call(token, 'GET', `/workforce/time-off?employeeId=${worker}`)).json.find((t) => t.id === reqWorker);
  note(w.status === 'APPROVED' && /Covered by overtime/.test(w.reason), 'approving anyway keeps the reason with the request', w.reason);
} else {
  await d2.getByRole('button', { name: /^Approve$/ }).click();
  await page.waitForTimeout(1500);
  const w = (await call(token, 'GET', `/workforce/time-off?employeeId=${worker}`)).json.find((t) => t.id === reqWorker);
  note(w.status === 'APPROVED', 'approving a request that passes is one click');
}
note(!(await d2.isVisible().catch(() => false)), 'the drawer closes after a decision');

// the one left on the blackout day: decline it with a reason from the drawer
await page.getByRole('button', { name: 'List', exact: true }).click();
await page.getByRole('button', { name: new RegExp(`^Spare3 To${run}, review request`) }).first().click();
const d3 = page.getByRole('dialog', { name: new RegExp(`Time off request for Spare3 To${run}`) });
await d3.getByRole('button', { name: /^Decline/ }).click();
const dd = page.getByRole('dialog', { name: new RegExp(`Decline Spare3 To${run}`) });
note(await dd.getByRole('button', { name: 'Decline', exact: true }).isDisabled(), 'Decline stays disabled until a reason is given');
await dd.getByRole('textbox').fill('Audit week');
await dd.getByRole('button', { name: 'Decline', exact: true }).click();
await page.waitForTimeout(1500);
note((await call(token, 'GET', `/workforce/time-off?from=${BASE_DAY2}&to=${BASE_DAY2}`)).json.find((t) => t.id === r3).status === 'REJECTED', 'the request is declined');

// 7. quality
await page.getByRole('button', { name: new RegExp(`^Spare1 To${run}, review request`) }).first().click();
await page.getByRole('dialog', { name: new RegExp(`Time off request for Spare1 To${run}`) }).getByText('Cover on each day').waitFor();
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations (drawer open)', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(SHOTS, '7-after-escape.png') });
note((await page.getByRole('dialog').count()) === 0, 'Escape closes the drawer without opening anything else (the app-wide Escape handler leaves it alone)');
await page.getByRole('button', { name: 'Calendar', exact: true }).click();
await page.getByRole('table', { name: 'Time off calendar' }).waitFor();
await page.waitForTimeout(600);       // let the List/Calendar button finish its colour change: axe measured it half way through once
const axe2 = await new AxeBuilder({ page }).analyze();
const bad2 = axe2.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad2.length === 0, 'and none on the calendar', bad2.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.map((n) => n.html.slice(0, 140) + ' ' + (n.any[0]?.message ?? '')).join(' ## ')}`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await call(token, 'DELETE', `/self-service/time-off-rules/${rule.id}`);
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
