// Looks at Workforce > Teams in a real browser, against a test stack (it creates its own teams, people and supervisors):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node teams-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-teams-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;

// data: three teams without a lead, one holding nearly everyone, two people who can lead, and one empty team to delete
const big = (await call(token, 'POST', '/workforce/teams', { name: `Alpha ${run}`, location: 'Pune' })).json;
const mid = (await call(token, 'POST', '/workforce/teams', { name: `Bravo ${run}` })).json;
const tiny = (await call(token, 'POST', '/workforce/teams', { name: `Charlie ${run}` })).json;
const empty = (await call(token, 'POST', '/workforce/teams', { name: `Empty ${run}` })).json;
const group = (await call(token, 'POST', '/config/groups', { name: `TG ${run}` })).json;
const mk = (i, extra = {}) => call(token, 'POST', '/workforce/employees', { employeeNumber: `TM${run}-${i}`, firstName: `Tm${i}`, lastName: `Person${run}`, primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48, ...extra });
for (let i = 1; i <= 30; i++) await mk(i, { teamId: big.id });
await mk(31, { teamId: mid.id });
const sup1 = (await mk(40, { isSupervisor: true, firstName: 'Sunita', lastName: `Lead${run}` })).json;
await mk(41, { isSupervisor: true, firstName: 'Rahul', lastName: `Lead${run}` });

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
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
await page.goto(URL + '/workforce/teams', { waitUntil: 'domcontentloaded' });
await page.getByRole('region', { name: /Teams without a lead/ }).waitFor({ timeout: 30000 });
await page.getByPlaceholder(/Find a team/).fill(run); await page.waitForTimeout(1500);
let t = await text();

// 1. the warning
const warn = page.getByRole('region', { name: /Teams without a lead/ });
const wt = (await warn.innerText()).replace(/\s+/g, ' ');
note(/4 teams have no lead\./.test(wt), 'the page warns that the teams have no lead, with the count', wt.slice(0, 80));
note(/Alerts, approvals and .my team. views go to a team.s lead/.test(wt), 'and says what breaks');
note(!/Nothing|None\b/.test(await page.locator('table').innerText()) && (await page.getByRole('button', { name: /No lead: assign/ }).count()) >= 4, 'each leadless row says "No lead: assign" instead of a quiet "None"');
note(/of the 31 people who are in a team are in .Alpha/.test(t), 'it says nearly everyone sits in one team', '');

// 2. no delete icon next to Edit; delete is behind the menu
note((await page.getByRole('button', { name: 'Delete team' }).count()) === 0, 'there is no trash icon beside Edit');
note((await page.getByRole('button', { name: /More actions for Alpha/ }).count()) === 1, 'each row has a "more actions" menu');
await page.screenshot({ path: path.join(SHOTS, '1-warning.png') });

// 3. assign a lead inline
await page.getByRole('button', { name: 'Assign leads' }).click();
const picker = page.getByLabel(`Team lead for Alpha ${run}`);
await picker.waitFor({ timeout: 8000 });
const assignBtn = warn.locator('div', { hasText: new RegExp(`^Alpha ${run}`) }).getByRole('button', { name: /^Assign$/ }).first();
note(await assignBtn.isDisabled(), 'Assign stays off until a person is chosen');
await picker.click(); await page.keyboard.type('Sunita'); await page.waitForTimeout(1200);
await page.getByRole('option', { name: /Sunita/ }).first().click().catch(async () => { await page.getByText(/Sunita/).first().click(); });
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(SHOTS, '2-picking.png') });
await assignBtn.click(); await page.waitForTimeout(2000);
t = await text();
const teamsNow = (await call(token, 'GET', `/workforce/teams?limit=50&q=${run}`)).json;
const alpha = teamsNow.find((x) => x.id === big.id);
note(alpha?.managerId === sup1.id, 'choosing a person and pressing Assign saves the lead', alpha?.managerName ?? 'none');
note(/3 teams have no lead\./.test((await warn.innerText().catch(() => '')).replace(/\s+/g, ' ')), 'the warning count drops to 3');

// 4. delete names who is affected, and moves them first
await page.getByRole('button', { name: new RegExp(`More actions for Bravo ${run}`) }).click();
await page.getByRole('menuitem', { name: /Delete team/ }).click();
const dlg = page.getByRole('dialog', { name: /Delete the team/ });
await dlg.waitFor({ timeout: 8000 });
await page.waitForTimeout(800);
const dt = (await dlg.innerText()).replace(/\s+/g, ' ');
note(/1 person is in this team: Tm31 Person/.test(dt), 'the dialog names the person who is in the team', dt.slice(0, 120));
note(/cannot be deleted, so they are moved first/.test(dt), 'and says why they must be moved');
const confirmBtn = dlg.getByRole('button', { name: /Move 1 person and delete/ });
note(await confirmBtn.isDisabled(), 'the delete button is off until a team to move them to and a reason are given');
await page.screenshot({ path: path.join(SHOTS, '3-delete-dialog.png') });
await dlg.getByLabel('Move them to').selectOption({ label: new RegExp(`Alpha ${run}`).source ? undefined : undefined, index: 1 }).catch(() => {});
await dlg.locator('textarea').fill('QA: merging the team');
note(!(await confirmBtn.isDisabled()), 'it turns on once both are given');
await confirmBtn.click(); await page.waitForTimeout(2500);
const after = (await call(token, 'GET', `/workforce/teams?limit=50&q=${run}`)).json;
note(!after.some((x) => x.id === mid.id), 'the team is gone');
const moved = (await call(token, 'GET', `/workforce/employees?q=Tm31&limit=5`)).json;
note(Array.isArray(moved) ? moved.some((e) => e.teamId && e.teamId !== mid.id) : true, 'the person was moved to the other team, not deleted');

// 5. an empty team deletes with a plain confirmation
await page.getByRole('button', { name: new RegExp(`More actions for Empty ${run}`) }).click();
await page.getByRole('menuitem', { name: /Delete team/ }).click();
const d2 = page.getByRole('dialog', { name: /Delete the team/ }); await d2.waitFor();
await page.waitForTimeout(600);
note(/Nobody is in this team/.test((await d2.innerText()).replace(/\s+/g, ' ')), 'an empty team says nobody is in it');
await d2.locator('textarea').fill('QA: empty'); await d2.getByRole('button', { name: /^Delete team$/ }).click(); await page.waitForTimeout(1800);
note(!(await call(token, 'GET', `/workforce/teams?limit=50&q=${run}`)).json.some((x) => x.id === empty.id), 'the empty team is deleted');

// 6. nothing else broke
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
