// Looks at Workforce > Org chart in a real browser, against a test stack (it creates its own group, teams and people):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node org-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-org-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;

// data: a group of 40 people, two teams with leads, a team with no lead, nobody has a manager
const group = (await call(token, 'POST', '/config/groups', { name: `OrgG ${run}` })).json;
const team = async (k) => (await call(token, 'POST', '/workforce/teams', { name: `${k} ${run}` })).json;
const A = await team('Alpha'), B = await team('Bravo'), C = await team('Charlie');
const mk = async (key, extra = {}) => (await call(token, 'POST', '/workforce/employees', { employeeNumber: `OG${run}-${key}`, firstName: key, lastName: `Org${run}`, primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48, ...extra })).json;
const leadA = await mk('LeadA', { isSupervisor: true }), leadB = await mk('LeadB', { isSupervisor: true });
await call(token, 'PUT', `/workforce/teams/${A.id}`, { name: A.name, managerId: leadA.id });
await call(token, 'PUT', `/workforce/teams/${B.id}`, { name: B.name, managerId: leadB.id });
for (let i = 1; i <= 20; i++) await mk(`a${i}`, { teamId: A.id });
for (let i = 1; i <= 12; i++) await mk(`b${i}`, { teamId: B.id });
for (let i = 1; i <= 4; i++) await mk(`c${i}`, { teamId: C.id });
const loose = [await mk('x1'), await mk('x2')];
const TOTAL = 2 + 20 + 12 + 4 + 2;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
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
await page.goto(URL + '/workforce/org-chart', { waitUntil: 'domcontentloaded' });
await page.getByRole('combobox').filter({ has: page.locator(`option:has-text("OrgG ${run}")`) }).first().selectOption({ label: `OrgG ${run}` });
const banner = page.getByRole('region', { name: /Reporting lines to set up/ });
await banner.waitFor({ timeout: 30000 });
await page.waitForTimeout(1200);

// 1. the banner is the first thing, and treats it as a task
const bt = (await banner.innerText()).replace(/\s+/g, ' ');
note(new RegExp(`Assign managers to ${TOTAL} people`).test(bt), 'a prominent banner says "Assign managers to N people"', bt.slice(0, 70));
note(/Set from teams/.test(bt) && /Import from a file/.test(bt) && /Choose one by one/.test(bt), 'with the three ways to do it');
const bb = await banner.boundingBox();
note(!!bb && bb.y < 260, 'it is at the top of the page, above the filters', `y=${Math.round(bb?.y ?? 0)}`);
await page.screenshot({ path: path.join(SHOTS, '1-banner.png') });

// 2. set from teams: shows what will happen, then does it
await page.getByRole('button', { name: 'Set from teams' }).click();
const dlg = page.getByRole('dialog', { name: /Make each team lead the manager of their team/ });
await dlg.waitFor({ timeout: 8000 }); await page.waitForTimeout(1000);
const dt = (await dlg.innerText()).replace(/\s+/g, ' ');
note(/32 people in 2 teams with a lead have no manager/.test(dt), 'the dialog says how many people in how many teams will be set', dt.slice(0, 90));
note(/1 team has no lead yet, so 4 people cannot be set this way/.test(dt), 'and warns about the team that has no lead');
note(/4 people are in no team/.test(dt), 'and about people in no team (the two leads and two others)');
const apply = dlg.getByRole('button', { name: /Set 32 reporting lines/ });
note(await apply.isDisabled(), 'applying needs a reason');
await page.screenshot({ path: path.join(SHOTS, '2-from-teams.png') });
await dlg.locator('textarea').fill('QA: set from teams');
await apply.click(); await page.waitForTimeout(2500);
const after = (await call(token, 'GET', `/workforce/employees?q=a1&limit=50`)).json;
const list = Array.isArray(after) ? after : after.rows ?? [];
const a1 = list.find((e) => e.employeeNumber === `OG${run}-a1`);
note(a1?.reportsTo === leadA.id, 'a person now reports to their team lead');
const t2 = await text();
note(/Assign managers to 6 people/.test(t2), 'the banner count drops to the people still with no line and no reports (the 4 in the team with no lead and 2 in no team)');
note(/LeadA Org/.test(t2) && /LeadB Org/.test(t2), 'the chart now shows the two leads as branches');
await page.screenshot({ path: path.join(SHOTS, '3-after-teams.png') });

// 3. import from a file: checked first, problems listed
await page.getByRole('button', { name: 'Import from a file' }).click();
const imp = page.getByRole('dialog', { name: /Import reporting lines from a file/ });
await imp.waitFor();
const csv = ['employee_number,reports_to_number', `OG${run}-c1,OG${run}-LeadA`, `OG${run}-c2,OG${run}-LeadA`, `OG${run}-c3,OG${run}-LeadB`, `OG${run}-c4,`, `NOPE-9,OG${run}-LeadA`].join('\n');
await imp.getByLabel('Or paste the file here').fill(csv);
const confirm = imp.getByRole('button', { name: /Check the file first|Set \d+ reporting/ }).last();
note(await confirm.isDisabled(), 'nothing can be applied before the file is checked');
await imp.getByRole('button', { name: 'Check the file', exact: true }).click(); await page.waitForTimeout(1500);
const it = (await imp.innerText()).replace(/\s+/g, ' ');
note(/3 lines will be set/.test(it) && /1 rows with no manager left alone/.test(it), 'checking says how many lines will be set and how many rows are left alone', it.slice(it.indexOf('3 lines'), it.indexOf('3 lines') + 110));
note(/1 row has a problem and is skipped/.test(it) && /No employee has the number "NOPE-9"/.test(it), 'and lists the row it cannot use');
await page.screenshot({ path: path.join(SHOTS, '4-import-check.png') });
const c1 = (await call(token, 'GET', `/workforce/employees?q=c1&limit=50`)).json; const c1row = (Array.isArray(c1) ? c1 : c1.rows ?? []).find((e) => e.employeeNumber === `OG${run}-c1`);
note(c1row?.reportsTo == null, 'checking changed nothing');
await imp.locator('textarea').last().fill('QA: from a file');
await imp.getByRole('button', { name: /Set 3 reporting lines/ }).click(); await page.waitForTimeout(2500);
const c1b = (await call(token, 'GET', `/workforce/employees?q=c1&limit=50`)).json; const c1after = (Array.isArray(c1b) ? c1b : c1b.rows ?? []).find((e) => e.employeeNumber === `OG${run}-c1`);
note(c1after?.reportsTo === leadA.id, 'applying sets the lines from the file');
note(/Assign managers to 3 people/.test(await text()), 'the banner count drops again (3 left)');

// 4. the file to fill in, and the one-by-one list
await page.getByRole('button', { name: 'Import from a file' }).click();
const imp2 = page.getByRole('dialog', { name: /Import reporting lines/ }); await imp2.waitFor();
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => null), imp2.getByRole('button', { name: /Download the current lines to fill in/ }).click()]);
note(!!dl && /reporting-lines/.test(dl.suggestedFilename()), 'the current lines can be downloaded as the file to fill in', dl?.suggestedFilename());
await imp2.getByRole('button', { name: /^Cancel$/ }).click();
await page.getByRole('button', { name: 'Choose one by one' }).click(); await page.waitForTimeout(1200);
note(/People with no reporting line/.test(await text()), '"Choose one by one" opens the list');

// 5. quality
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
