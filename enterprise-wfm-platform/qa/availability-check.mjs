// Looks at Workforce > Availability in a real browser, against a test stack (it creates its own team of 30):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node availability-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-availability-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;

// a new team of 30 who have no availability yet, plus a bigger team so this one is not the default by size unless it is the largest
const group = (await call(token, 'POST', '/config/groups', { name: `AvQ ${run}` })).json;
const team = (await call(token, 'POST', '/workforce/teams', { name: `ZZ New team ${run}` })).json;
const ids = [];
for (let i = 1; i <= 30; i++) ids.push((await call(token, 'POST', '/workforce/employees', { employeeNumber: `AQ${run}-${String(i).padStart(2, '0')}`, firstName: `P${String(i).padStart(2, '0')}`, lastName: `Av${run}`, primaryGroupId: group.id, teamId: team.id, weeklyContractHours: 40, maxWeeklyHours: 48 })).json.id);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 2000 } })).newPage();
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
await page.goto(URL + '/workforce/availability', { waitUntil: 'domcontentloaded' });
await page.getByRole('table', { name: /Weekly availability by person/ }).waitFor({ timeout: 30000 });
await page.getByLabel('Team', { exact: true }).selectOption({ label: new RegExp(`ZZ New team ${run}`).source ? undefined : undefined, value: team.id });
await page.getByLabel(`Tick P01 Av${run}`).waitFor({ timeout: 15000 });
const cell = (n, d) => page.getByRole('button', { name: new RegExp(`^P${String(n).padStart(2, '0')} Av${run}, ${d}:`) });

// 1. arrives on a grid, not an empty page
const rows = await page.locator('tbody tr').count();
note(rows === 30, 'the page opens on a team-week grid with one row per person', `${rows} rows`);
note((await page.locator('thead th').allInnerTexts()).filter((h) => /^(MON|TUE|WED|THU|FRI|SAT|SUN)$/i.test(h.trim())).length === 7, 'with the seven days across');
note(/Any time/.test(await cell(1, 'Mon').innerText()), 'a person with nothing entered shows "Any time" in every cell');
note(/0 of 30 shown have availability entered/.test(await text()), 'and it says nobody has availability entered yet');
await page.screenshot({ path: path.join(SHOTS, '1-grid.png') });

// 2. multi-cell paint: Off all day on the weekend for everyone, with one drag
await page.getByRole('button', { name: 'Off all day' }).click();
const a = await cell(1, 'Sat').boundingBox(), b = await cell(30, 'Sun').boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 }); await page.mouse.up();
await page.waitForTimeout(500);
note(/Off/.test(await cell(1, 'Sat').innerText()) && /Off/.test(await cell(30, 'Sun').innerText()) && /Off/.test(await cell(15, 'Sat').innerText()), 'one drag paints Saturday and Sunday off for all 30 people');
note(/Any time/.test(await cell(5, 'Mon').innerText()), 'and leaves the other days alone');
note(/30 people have unsaved changes/.test(await text()), 'the page says 30 people have unsaved changes, and nothing is saved yet');
note((await call(token, 'GET', `/workforce/availability/grid?teamId=${team.id}`)).json.people.every((p) => p.windows.length === 0), 'nothing was written to the server by painting');
await page.screenshot({ path: path.join(SHOTS, '2-painted.png') });

// 3. apply to selected people: weekdays 9 to 17 for ten people
await page.getByRole('button', { name: 'Only available…' }).click();
await page.getByLabel('From').fill('09:00'); await page.getByLabel('To').fill('17:00');
for (let i = 1; i <= 10; i++) await page.getByLabel(`Tick P${String(i).padStart(2, '0')} Av${run}`).check();
const applyBtn = page.getByRole('button', { name: /Apply to 10 selected people/ });
note(await applyBtn.isEnabled(), '"Apply to selected people" is ready once people are ticked and a paint chosen');
await applyBtn.click(); await page.waitForTimeout(500);
note(/9–17/.test(await cell(3, 'Wed').innerText()) && /9–17/.test(await cell(10, 'Fri').innerText()), 'Monday to Friday 9 to 17 is set for the ten people ticked');
note(/Any time/.test(await cell(11, 'Wed').innerText()), 'and not for anyone else');
await page.screenshot({ path: path.join(SHOTS, '3-applied.png') });

// 4. copy week: person 1 to everyone shown
await page.getByRole('button', { name: 'Copy week' }).first().click();
await page.getByRole('button', { name: 'Paste to everyone shown' }).click(); await page.waitForTimeout(500);
note(/9–17/.test(await cell(25, 'Tue').innerText()) && /Off/.test(await cell(25, 'Sat').innerText()), 'Copy week gives person 1\'s week to everyone shown');

// 5. a single click paints one cell
await page.getByRole('button', { name: 'Prefers…' }).click();
await page.getByLabel('From').fill('06:00'); await page.getByLabel('To').fill('10:00');
await cell(2, 'Thu').click(); await page.waitForTimeout(300);
note(/Prefers 6–10/.test(await cell(2, 'Thu').innerText()), 'a click paints one cell (a preference for the morning)');
note(/problem|The end must be after the start/.test(await text()) === false, 'no error while the times are valid');
await page.getByLabel('To').fill('05:00'); await page.waitForTimeout(300);
note(/The end must be after the start/.test(await text()), 'hours that end before they start are refused with a reason');
await page.getByLabel('To').fill('10:00');

// 6. save once
await page.getByRole('button', { name: /^Save 30 people$/ }).click(); await page.waitForTimeout(3000);
const saved = (await call(token, 'GET', `/workforce/availability/grid?teamId=${team.id}&limit=100`)).json;
note(saved.people.length === 30 && saved.people.every((p) => p.windows.some((w) => w.dayOfWeek === 5 && w.kind === 'UNAVAILABLE')), 'one save writes all 30 people', `${saved.people.filter((p) => p.windows.length).length} with a week`);
const two = saved.people.find((p) => p.employeeNumber === `AQ${run}-02`);
note(two.windows.some((w) => w.dayOfWeek === 3 && w.kind === 'PREFERRED' && w.startTime === '06:00' && w.endTime === '10:00'), 'including the single preference');
note(!/unsaved changes/.test(await text()), 'the unsaved-changes bar is gone');
note(/9–17/.test(await cell(30, 'Mon').innerText()), 'and the grid shows what was saved');

// 7. discard
await page.getByRole('button', { name: 'Off all day' }).click(); await cell(4, 'Mon').click();
note(/1 person has unsaved changes/.test(await text()), 'a further change is held on screen');
await page.getByRole('button', { name: 'Discard' }).click(); await page.waitForTimeout(400);
note(/9–17/.test(await cell(4, 'Mon').innerText()), 'Discard puts the cell back');

// 8. details still reachable, quality
await page.getByRole('button', { name: 'Details' }).first().click(); await page.waitForTimeout(1500);
note(/One person in detail/.test(await text()), '"Details" opens the one-person editor below the grid');
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
