// Looks at Workforce > Skills in a real browser, against a test stack (it creates its own skills, people and a group that requires one):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node skills-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-skills-check');
fs.mkdirSync(SHOTS, { recursive: true });
const run = Date.now().toString(36);
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
const token = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: 'ORG' })).json.token;

// data: French (one person who is level 4; the group needs level 4 too: thin), Billing (five people), Spanish (nobody)
const group = (await call(token, 'POST', '/config/groups', { name: `SkG ${run}` })).json;
const sk = async (name) => (await call(token, 'POST', '/workforce/skills', { name: `${name} ${run}`, category: 'LANGUAGES' })).json;
const french = await sk('French'), billing = await sk('Billing'), spanish = await sk('Spanish');
const person = async (i, skills) => { const e = (await call(token, 'POST', '/workforce/employees', { employeeNumber: `SK${run}-${i}`, firstName: `Sk${i}`, lastName: `Person${run}`, primaryGroupId: group.id, eligibleGroupIds: [group.id], weeklyContractHours: 40, maxWeeklyHours: 48 })).json; await call(token, 'PUT', `/workforce/employees/${e.id}/skills`, { skills }); return e; };
await person(1, [{ skillId: french.id, proficiency: 4 }]);
for (const [i, l] of [[2, 1], [3, 2], [4, 3], [5, 3], [6, 5]]) await person(i, [{ skillId: billing.id, proficiency: l }]);
await call(token, 'PUT', `/config/groups/${group.id}/skills`, { skills: [{ skillId: french.id, minProficiency: 4 }] });
// Amharic: two speakers who are only in another group, one person in this group at level 1, one in this group without it. The group needs level 3.
const other = (await call(token, 'POST', '/config/groups', { name: `SkO ${run}` })).json;
const amharic = await sk('Amharic');
const mkIn = async (key, g, skills) => { const e = (await call(token, 'POST', '/workforce/employees', { employeeNumber: `AM${run}-${key}`, firstName: key, lastName: `Am${run}`, primaryGroupId: g.id, eligibleGroupIds: [g.id], weeklyContractHours: 40, maxWeeklyHours: 48 })).json; if (skills.length) await call(token, 'PUT', `/workforce/employees/${e.id}/skills`, { skills }); return e; };
await mkIn('Sp5', other, [{ skillId: amharic.id, proficiency: 5 }]); await mkIn('Sp3', other, [{ skillId: amharic.id, proficiency: 3 }]);
await mkIn('Low', group, [{ skillId: amharic.id, proficiency: 1 }]); const lacking = await mkIn('Lacks', group, []);
await call(token, 'PUT', `/config/groups/${group.id}/skills`, { skills: [{ skillId: french.id, minProficiency: 4 }, { skillId: amharic.id, minProficiency: 3 }] });

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
await page.evaluate(() => localStorage.removeItem('wfm.skills.thin'));
await page.goto(URL + '/workforce/skills', { waitUntil: 'domcontentloaded' });
await page.getByRole('row', { name: new RegExp(`Billing ${run}`) }).waitFor({ timeout: 30000 });
const rowOf = (n) => page.getByRole('row', { name: new RegExp(`${n} ${run}`) });
let t = await text();

// 1. less noise
const heads = (await page.locator('thead th').allInnerTexts()).map((h) => h.trim()).filter(Boolean);
note(!heads.includes('Certification'), 'the Certification column is not shown while no skill requires it', heads.join(' | '));
note(['Skill', 'Levels', 'People'].every((h) => heads.some((x) => x.toLowerCase() === h.toLowerCase())), 'there are Levels and People columns');
const codeText = await page.locator(`span[title="Code ${billing.code}"]`).count();
note(codeText === 1 && !(await rowOf('Billing').locator('div.font-mono').count()), 'the skill code moved into a tooltip on the name', billing.code);
const hidden = await rowOf('Billing').locator('.sr-only').first().boundingBox();
note(!!hidden && hidden.width <= 2 && hidden.height <= 2, 'and is not shown beside it (only a screen reader hears it)');

// 2. coverage risk
note(/Coverage risk:/.test(t), 'a summary line says how many skills are at risk', (t.match(/Coverage risk:[^.]*/) ?? [''])[0]);
const fr = (await rowOf('French').innerText()).replace(/\s+/g, ' ');
note(/Thin/.test(fr) && /Only 1 person is qualified for SkG/.test(fr), 'French is flagged thin, with the reason and the group', fr.slice(0, 100));
note(/Nobody/.test((await rowOf('Spanish').innerText())), 'Spanish (nobody has it) is flagged');
note(!/Thin|Nobody/.test(await rowOf('Billing').innerText()), 'Billing (five people) is not flagged');

// 3. level bar
const bar = rowOf('Billing').getByRole('img', { name: /proficiency/ });
note(await bar.count() === 1 && /Level 1: 1 · Level 2: 1 · Level 3: 2 · Level 4: 0 · Level 5: 1/.test(await bar.getAttribute('aria-label')), 'a level bar shows how the five people are spread over levels', await bar.getAttribute('title'));
note(await rowOf('Spanish').getByRole('img').count() === 0, 'a skill nobody has shows no bar');
await page.screenshot({ path: path.join(SHOTS, '1-skills.png') });

// 4. the threshold
await page.getByLabel('Thin coverage threshold, people').fill('6'); await page.waitForTimeout(1500);
note(/Thin/.test(await rowOf('Billing').innerText()), 'raising the threshold to 6 flags Billing as thin');
await page.getByLabel('Thin coverage threshold, people').fill('3'); await page.waitForTimeout(1200);

// 5. the people count opens exactly those people
await rowOf('Billing').getByRole('link', { name: /with Billing/ }).click();
await page.getByPlaceholder('Search name or number').waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);
note(/skill=/.test(page.url()) && /status=ACTIVE/.test(page.url()), 'the count is a link to Employees filtered by the skill', page.url().replace(URL, ''));
t = await text();
note(/5 people/.test(t), 'Employees opens with exactly those five people');
note(new RegExp(`Billing ${run}`).test(t) || /1 skill/i.test(t), 'and the skill filter is shown as set');
await page.screenshot({ path: path.join(SHOTS, '2-employees-filtered.png') });
await page.goto(URL + '/workforce/skills', { waitUntil: 'domcontentloaded' }); await page.getByRole('row', { name: new RegExp(`Billing ${run}`) }).waitFor({ timeout: 30000 });

// 6. delete is behind a menu and names who is affected
note(await page.getByRole('button', { name: 'Delete skill' }).count() === 0, 'there is no trash icon beside Edit');
await page.getByRole('button', { name: new RegExp(`More actions for French ${run}`) }).click();
await page.getByRole('menuitem', { name: /Delete skill/ }).click();
const dlg = page.getByRole('dialog', { name: /Delete the skill/ }); await dlg.waitFor(); await page.waitForTimeout(800);
const dt = (await dlg.innerText()).replace(/\s+/g, ' ');
note(/removed from 1 person: Sk1 Person/.test(dt), 'the dialog names who loses the skill', dt.slice(0, 110));
note(/A WFM group requires this skill \(SkG/.test(dt), 'and warns that a group loses its requirement');
await page.screenshot({ path: path.join(SHOTS, '3-delete.png') });
await dlg.getByRole('button', { name: 'Delete skill', exact: true }).click(); await page.waitForTimeout(2000);
note(!(await call(token, 'GET', '/workforce/skills')).json.some((s) => s.id === french.id), 'the skill is deleted');

// 7. the fix: say why, then fix it
const am = (await rowOf('Amharic').innerText()).replace(/\s+/g, ' ');
note(/2 people have it at level 3 or higher but are not eligible for SkG/.test(am), 'Amharic says WHY nobody is qualified: two people have it but are not eligible for the group', am.slice(0, 120));
note(!/Nobody is qualified/.test(am), 'and no longer says "Nobody is qualified" next to people who hold the skill');
await rowOf('Amharic').getByRole('button', { name: 'Fix…' }).click();
const fixd = page.getByRole('dialog', { name: /Fix coverage of Amharic/ }); await fixd.waitFor(); await page.waitForTimeout(1000);
const ft = (await fixd.innerText()).replace(/\s+/g, ' ');
note(/Sp5 Am/.test(ft) && /Sp3 Am/.test(ft) && /level 5/.test(ft) && /SkO/.test(ft), 'the dialog lists the two speakers with their level and home group');
note(/Lacks Am/.test(ft) && /does not have it/.test(ft) && /Low Am/.test(ft) && /has level 1/.test(ft), 'and the people in the group who lack it or have it too low');
const addBtn = fixd.getByRole('button', { name: /Add 2 people to SkG/ });
note(await addBtn.isDisabled(), 'nothing can be changed without a reason');
await page.screenshot({ path: path.join(SHOTS, '4-fix-dialog.png') });
await fixd.getByLabel('Reason').fill('QA: they speak Amharic');
await addBtn.click(); await page.waitForTimeout(2000);
note(/2 people can now be scheduled in SkG/.test((await fixd.innerText()).replace(/\s+/g, ' ')), 'adding them reports what changed');
const afterAdd = ((await call(token, 'GET', '/workforce/skills?thin=3')).json).find((x) => x.id === amharic.id);
note(afterAdd.requiredBy[0].qualified === 2, 'the group now has two qualified people');
// give the skill to the person without it, at level 3
const lacksBox = fixd.getByRole('list', { name: 'People who could be given the skill' }).getByText(/Lacks Am/).locator('..').getByRole('checkbox');
await lacksBox.check();
await fixd.getByRole('button', { name: /Give Amharic .* to 1 person/ }).click(); await page.waitForTimeout(2000);
const afterGive = ((await call(token, 'GET', '/workforce/skills?thin=3')).json).find((x) => x.id === amharic.id);
note(afterGive.requiredBy[0].qualified === 3, 'giving the skill to the person who lacked it makes three qualified');
await fixd.getByRole('button', { name: 'Done', exact: true }).click(); await page.waitForTimeout(1500);
note(!/Thin|Nobody/.test(await rowOf('Amharic').innerText()), 'the Amharic row is no longer flagged');

// 8. quality
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length})`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
