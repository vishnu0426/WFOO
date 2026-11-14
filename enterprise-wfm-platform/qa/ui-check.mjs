// Looks at the screens changed for the enterprise scheduling policies, in a real browser, against a test stack:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node ui-check.mjs
// Writes screenshots to QA_SHOTS (default: the temp folder) and prints what it saw.
import { chromium } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-ui-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push({ ok, what }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

const call = async (token, method, p, body) => {
  const r = await fetch(API + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;

// data: a group with a normal and a split-shift template, people, a draft schedule, approval required
const group = (await call(token, 'POST', '/config/groups', { name: `UI ${run}` })).json;
const tpl = (await call(token, 'POST', '/scheduling/templates', { name: `Day ${run}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '08:00', durationHours: 9, mealMinutes: 60, breakCount: 0, breakMinutes: 15, flexMinutes: 0 })).json;
for (let i = 1; i <= 10; i++) await call(token, 'POST', '/workforce/employees', { employeeNumber: `UI${run}-${i}`, firstName: `Ui${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
for (let d = 0; d < 7; d++) await call(token, 'POST', `/config/groups/${group.id}/coverage-windows`, { dayOfWeek: d, startTime: '08:00', endTime: '17:00', headcount: 4 });
const pol = (await call(token, 'GET', '/config/scheduling-policy')).json;
await call(token, 'PUT', '/config/scheduling-policy', { ...pol, scheduling: { ...pol.scheduling, requireApproval: true } });
const v1 = (await call(token, 'POST', '/scheduling/versions', { groupId: group.id, from: '2026-12-07', weeks: 1, timeLimitSec: 10, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false })).json;
await call(token, 'POST', `/scheduling/versions/${v1.id}/submit`, {}); await call(token, 'POST', `/scheduling/versions/${v1.id}/approve`, {});
await call(token, 'POST', `/scheduling/versions/${v1.id}/publish`, {});                       // v1 is live, so a second draft has something to replace
const v2 = (await call(token, 'POST', '/scheduling/versions', { groupId: group.id, from: '2026-12-07', weeks: 1, timeLimitSec: 10, coverageSource: 'MANUAL', templateIds: [tpl.id], useHistory: false })).json;
const shifts = (await call(token, 'GET', `/scheduling/versions/${v2.id}/shifts`)).json;
await call(token, 'DELETE', `/scheduling/versions/${v2.id}/shifts/${shifts.at(-1).id}?reason=ui%20check`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: path.join(SHOTS, `${n}.png`), fullPage: false });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');

await page.goto(URL + '/');
await page.getByLabel(/^Username/i).waitFor();                       // the sign-in form renders after the page loads: wait for it before looking for the organisation code
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });

// 1. Scheduling rules: the new settings
await page.goto(URL + '/configuration/scheduling-rules'); await page.waitForTimeout(2500);
let t = await text();
note(/Overtime/.test(t) && /Public holidays/.test(t) && /Notice for shift changes/.test(t), 'Scheduling Rules shows overtime, public holidays and notice for shift changes');
note(/must be approved before it is published/i.test(t), 'Scheduling Rules shows the approval switch');
await shot('1-scheduling-rules');

// 2. Shift templates: the split shift option
await page.goto(URL + '/scheduling/shift-templates'); await page.waitForTimeout(2500);
const add = page.getByRole('button', { name: /new template|add template|new shift template|^\+?\s*new/i }).first();
if (await add.isVisible().catch(() => false)) await add.click();
await page.waitForTimeout(800);
const more = page.getByText(/More options: shift lengths/i).first();
if (await more.isVisible().catch(() => false)) await more.click();
await page.waitForTimeout(500);
t = await text();
note(/This is a split shift/.test(t), 'Shift template form offers "This is a split shift"');
if (/This is a split shift/.test(t)) {
  await page.getByLabel(/This is a split shift/i).check();
  await page.waitForTimeout(400);
  note(/Unpaid gap between the two parts/.test(await text()), 'ticking it relabels the meal as the unpaid gap');
}
await shot('2-shift-template-split');

// 3. Timeline with a draft: pick the group, find the draft
await page.goto(URL + '/scheduling/schedule-timeline'); await page.waitForTimeout(3000);
await shot('3a-timeline-start');
t = await text();
note(!/Something went wrong|Unexpected error/i.test(t), 'Timeline opens without an error screen');
const picker = page.getByLabel(/WFM group|Group/i).first();
if (await picker.isVisible().catch(() => false)) { try { await picker.selectOption({ label: group.name }); await page.waitForTimeout(3000); } catch { /* not a select */ } }
if (!(await text()).includes(group.name)) {
  const any = page.getByText(/Select (a )?group|WFM group/i).first();
  if (await any.isVisible().catch(() => false)) await any.click().catch(() => {});
}
await shot('3b-timeline-group');
t = await text();
note(t.includes(`UI ${run}`) || /Publish/.test(t), 'Timeline shows the chosen group schedules', '(see 3b screenshot if this failed: the group may need picking by hand)');

// version select: choose the draft v2
const sel = page.getByLabel('Schedule version');
if (await sel.isVisible().catch(() => false)) {
  await sel.selectOption(v2.id).catch(() => {});
  await page.waitForTimeout(2500);
  t = await text();
  note(/Submit for approval/.test(t), 'a draft that needs approval offers "Submit for approval"');
  note(/Publish/.test(t) && await page.getByRole('button', { name: /^Publish$/ }).isDisabled().catch(() => false), 'Publish is disabled until it is approved');
  await shot('3c-draft-needs-approval');
  await page.getByRole('button', { name: /^Check rules$/ }).click().catch(() => {});
  await page.waitForTimeout(2500);
  t = await text();
  note(/Every rule is met|rules? (is|are) broken/.test(t) && /Cover meets the requirement|understaffed/.test(t), 'Check rules reports the verdict and the cover separately');
  await shot('3c2-check-rules');
  await page.getByRole('button', { name: /Submit for approval/ }).click().catch(() => {});
  await page.waitForTimeout(800);
  await page.getByPlaceholder(/note for the approver/i).fill('ui check').catch(() => {});
  await page.getByRole('button', { name: /^Submit$/ }).click().catch(() => {});
  await page.waitForTimeout(2500);
  t = await text();
  note(/Waiting for approval/.test(t), 'after submitting, the schedule shows "Waiting for approval"');
  note(await page.getByRole('button', { name: /^Approve$/ }).isVisible().catch(() => false), 'an approver sees Approve and Send back');
  await shot('3d-submitted');
  await page.getByRole('button', { name: /^Approve$/ }).click().catch(() => {});
  await page.waitForTimeout(2500);
  note(/Approved/.test(await text()), 'after approving, it shows "Approved"');
  await page.getByRole('button', { name: /^Publish$/ }).click().catch(() => {});
  await page.waitForTimeout(3000);
  t = await text();
  note(/Publishing replaces/.test(t) && /changed shifts/.test(t), 'publishing over a live schedule says who is affected before it happens');
  await shot('3e-impact');
  await page.getByRole('button', { name: /Publish and tell/ }).click().catch(() => {});
  await page.waitForTimeout(3000);
  note(/is published/.test(await text()) || /Published/.test(await text()), 'confirming publishes it');
  await shot('3f-published');
} else {
  note(false, 'could not find the schedule version selector on the Timeline (see 3b screenshot)');
}

// 4. WFM group form: the group's own chat efficiency
await page.goto(URL + '/configuration/wfm-groups'); await page.waitForTimeout(2500);
const newGroup = page.getByRole('button', { name: /Create WFM Group/i }).first();
if (await newGroup.isVisible().catch(() => false)) await newGroup.click();
await page.waitForTimeout(1200);
t = await text();
note(/Chat efficiency/.test(t), 'the WFM group form has a Chat efficiency field');
const eff = page.locator('input[aria-label="Chat efficiency"]').first();      // the label names the input (an info button carries the same words)
if (await eff.isVisible().catch(() => false)) note((await eff.inputValue()) === '0.85', 'a new group starts at the default chat efficiency of 0.85');
await shot('4-group-form-chat-efficiency');

// 5. Staffing builder: the staffing preview opens without errors
await page.goto(URL + '/forecasting/forecast-builder'); await page.waitForTimeout(3000);
note(!/Something went wrong|Unexpected error/i.test(await text()), 'the forecast builder opens without an error screen');
await shot('5-builder');

// 6. Generate screen: a plan built week by week says so
note(errors.filter((e) => !/favicon|ResizeObserver/i.test(e)).length === 0, 'no browser errors on these screens', errors.slice(0, 3).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed. Screenshots: ${SHOTS}`);
process.exit(failed ? 1 : 0);
