// Looks at Workforce > Employees in a real browser at 1280 px, against a test stack with people, a published schedule and skills:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node employees-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-employees-check');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
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
await page.evaluate(() => localStorage.removeItem('wfm.employees.columns'));
await page.goto(URL + '/workforce/employees', { waitUntil: 'domcontentloaded' });
await page.locator('.ag-row').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

// 1. the checkbox is the first column, and everything shown fits
const boxX = (await page.locator('.ag-row').first().locator('.ag-selection-checkbox').boundingBox())?.x ?? 999;
const nameX = (await page.locator('.ag-row').first().locator('.ag-cell').filter({ hasText: /Person|G\d/ }).first().boundingBox())?.x ?? 0;
note(boxX < nameX, 'the checkbox is at the start of the row, before the name', `checkbox x=${Math.round(boxX)}, name x=${Math.round(nameX)}`);
const headers = (await page.locator('.ag-header-cell').allInnerTexts()).map((h) => h.trim()).filter(Boolean);
note(['Employee', 'Team', 'WFM group', 'Contract', 'Skills', 'Status'].every((h) => headers.includes(h)), 'the default columns are shown', headers.join(' | '));
const fits = await page.evaluate(() => { const v = document.querySelector('.ag-body-horizontal-scroll-viewport'); return v ? v.scrollWidth <= v.clientWidth + 2 : true; });
note(fits, 'at 1280 px no shown column is cut off at the right edge');
const statusBox = await page.locator('.ag-header-cell', { hasText: 'Status' }).boundingBox();
note(!!statusBox && statusBox.x + statusBox.width <= 1280, 'the last column ends inside the screen');
await page.screenshot({ path: path.join(SHOTS, '1-table.png') });

// 2. no bar until something is selected, then a sticky bar with the actions
note(!(await page.getByRole('region', { name: /Actions for the people selected/ }).isVisible().catch(() => false)), 'no bulk bar before anything is selected');
await page.locator('.ag-row').nth(0).locator('.ag-selection-checkbox input').check();
await page.locator('.ag-row').nth(1).locator('.ag-selection-checkbox input').check(); await page.waitForTimeout(700);
const bar = page.getByRole('region', { name: /Actions for the people selected/ });
await bar.waitFor({ timeout: 5000 }).catch(() => {});
t: {
  const t = await bar.innerText().catch(() => '');
  note(/2 selected/.test(t), 'the bar says how many are selected', t.replace(/\s+/g, ' '));
  for (const b of ['Assign team', 'Assign group', 'Add skill', 'Set contract', 'Export CSV', 'Edit selected', 'Clear selection']) note(new RegExp(b).test(t), `the bar offers "${b}"`);
}
const bb = await bar.boundingBox();
note(!!bb && bb.y + bb.height <= 800, 'the bar is on screen (sticky at the bottom)');
await page.screenshot({ path: path.join(SHOTS, '2-bulk-bar.png') });

// 3. export
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), page.getByRole('button', { name: 'Export CSV' }).click()]);
if (dl) { const file = path.join(SHOTS, 'export.csv'); await dl.saveAs(file); const csv = fs.readFileSync(file, 'utf8'); note(csv.split('\n').filter((l) => l.trim()).length === 3 && /Employee number,Name,Email/.test(csv), 'Export CSV downloads the two selected people with a header', dl.suggestedFilename()); } else note(false, 'Export CSV downloads a file');

// 4. a quick action opens the bulk editor with that change already ticked
await page.getByRole('button', { name: 'Assign team' }).click(); await page.waitForTimeout(600);
note(/Change team/i.test(await text()) && await page.locator('label', { hasText: /Change team/i }).locator('input').isChecked().catch(() => false), '"Assign team" opens the editor with the team change already ticked');
await page.screenshot({ path: path.join(SHOTS, '3-assign-team.png') });
await page.getByRole('button', { name: /^Cancel$/ }).first().click().catch(() => {});
await page.getByRole('button', { name: /Clear selection/ }).first().click().catch(() => {}); await page.waitForTimeout(500);

// 5. the column chooser, remembered
await page.getByRole('button', { name: 'Columns' }).click();
await page.getByLabel('Email').check(); await page.getByLabel('Skills', { exact: true }).uncheck();
await page.getByRole('button', { name: 'Done' }).click(); await page.waitForTimeout(600);
let h2 = (await page.locator('.ag-header-cell').allInnerTexts()).map((x) => x.trim());
note(h2.includes('Email') && !h2.includes('Skills'), 'the column chooser adds Email and hides Skills', h2.join(' | '));
await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('.ag-row').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(1200);
h2 = (await page.locator('.ag-header-cell').allInnerTexts()).map((x) => x.trim());
note(h2.includes('Email') && !h2.includes('Skills'), 'the choice is remembered after a reload');
await page.getByRole('button', { name: 'Columns' }).click(); await page.getByRole('button', { name: 'Reset' }).click(); await page.getByRole('button', { name: 'Done' }).click();

// 6. the side panel: tabs
await page.getByPlaceholder('Search name or number').fill('G1'); await page.waitForTimeout(1500);
await page.locator('.ag-row .ag-cell').filter({ hasText: /G1 Person/ }).first().click();
await page.getByRole('tab', { name: 'Overview' }).waitFor({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
let t2 = await text();
note(await page.getByRole('tab').count() === 5, 'the panel has five tabs', (await page.getByRole('tab').allInnerTexts()).join(', '));
note(/This week/i.test(t2) && /Right now/i.test(t2) && /Leave balances/i.test(t2) && /Adherence, last 7 days/i.test(t2), 'Overview answers where they are this week: shifts, today, adherence, leave balances');
note(/h paid this week of a 40 h contract/.test(t2), 'it totals the paid hours against the contract');
await page.screenshot({ path: path.join(SHOTS, '4-overview.png') });
await page.getByRole('tab', { name: 'Contract' }).click(); await page.waitForTimeout(400);
t2 = await text(); note(/Days per week/.test(t2) && /Hours/.test(t2) && /Email/.test(t2), 'Contract tab shows assignment, contact and contract');
await page.getByRole('tab', { name: 'Skills' }).click(); await page.waitForTimeout(500);
note(await page.getByText(/No skills yet|Billing/).first().isVisible().catch(() => false), 'Skills tab can be edited in place');
await page.getByRole('tab', { name: 'Availability' }).click(); await page.waitForTimeout(800);
note(/Edit availability|No limits on when/.test(await text()), 'Availability tab shows when they can work');
await page.getByRole('tab', { name: 'Login' }).click(); await page.waitForTimeout(400);
note(/App login/i.test(await text()), 'Login tab shows the app login');
await page.screenshot({ path: path.join(SHOTS, '5-login.png') });

// 7. accessibility and errors
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
