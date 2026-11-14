// Looks at Forecasting > Adjustments in a real browser, against a test stack (it creates its own group and a published forecast):
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node adjustments-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const API = (process.env.QA_API || 'http://localhost:4000') + '/api/v1';
const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-adjustments-check');
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
  let seed = 13 + queue.length; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) { const d = addDays(today, -n), f = ((d.getUTCDay() + 6) % 7) >= 5 ? 0.4 : 1; for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 1.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${240 + Math.round(rnd() * 40)}`); } }
  return rows.join('\n');
}
const today = new Date(); today.setUTCHours(0, 0, 0, 0);
const day = iso(today);
const g = (await call(token, 'POST', '/config/groups', { name: `ADJ ${run}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 })).json;
const q = (await call(token, 'POST', '/config/queues', { name: `Adj Q ${run}`, channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 300 })).json;
const up = await call(token, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.name, 56) });
await call(token, 'POST', `/data/imports/${up.json.id}/commit`);
const v1 = (await call(token, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 2, fromDay: iso(addDays(today, -1)) })).json;
for (const s of ['submit', 'approve', 'publish']) await call(token, 'POST', `/forecast/versions/${v1.id}/${s}`, {});
const versions = async () => (await call(token, 'GET', `/forecast/versions?groupId=${g.id}`)).json;
const volumes = async (id) => { const d = (await call(token, 'GET', `/forecast/versions/${id}/data?grain=15&from=${day}&to=${day}`)).json; return new Map(d.buckets.map((b) => [b.slot, b.volume])); };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); localStorage.removeItem('wfm_fc_view'); } }, g.id);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// the sign-in screen's organisation lookup is rate-limited after many sign-ins on one test stack: that is not what is being checked
const limited = [];
page.on('response', (r) => { if (r.status() === 429) limited.push(r.url().split('/api/v1').pop()); });
page.on('console', (m) => { if (m.type() === 'error' && !(/429/.test(m.text()) && limited.every((u) => u.startsWith('/auth/login-options')))) errors.push(m.text()); });
const text = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.goto(URL + '/forecasting/adjustments', { waitUntil: 'domcontentloaded' });
await page.getByText(/is live, so it is locked/).waitFor({ timeout: 60000 });
const bar = page.getByRole('group', { name: 'What this page is showing' });

// 1. the filters are the shared bar, in day mode, not four boxes declared again
const names = await bar.locator('select, input, button').evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean));
note(['Group', 'Forecast', 'Day'].every((n) => names.includes(n)) && names.some((n) => /^Advanced/.test(n)), 'the page uses the shared context bar: Group, Forecast, Day, Advanced', names.join(' | '));
note(!names.includes('Week') && !names.includes('Custom') && (await page.getByLabel('Type', { exact: true }).count()) === 0 && (await page.getByLabel('Queue').count()) === 0, 'no date-range switch, no Type box, and Queue is behind Advanced rather than another box');

// 2. the locked banner has the way out, and there is no dead form
const clone = page.getByRole('button', { name: 'Clone to edit' });
note(await clone.isVisible(), 'a live forecast says it is locked and offers "Clone to edit" right there');
note((await page.getByRole('button', { name: 'Apply adjustment' }).count()) === 0 && (await page.getByLabel('From day').count()) === 0, 'and no form of disabled boxes is shown');
note(await page.locator('.recharts-surface').first().isVisible(), 'the chart and the numbers are still there to look at');
await page.screenshot({ path: path.join(SHOTS, '1-locked.png') });
await clone.click();
await page.getByRole('button', { name: 'Apply adjustment' }).waitFor({ timeout: 30000 });
const draft = (await versions()).find((v) => v.status === 'DRAFT');
note(!!draft && draft.parentVersionId === v1.id, 'Clone to edit makes a draft and opens it, with the form ready');

// 3. what to do, in words
const modeNames = ['Change by %', 'Add contacts', 'Set total', 'Zero out', 'Undo adjustments'];
const present = await Promise.all(modeNames.map((n) => page.getByRole('button', { name: n, exact: true }).isVisible()));
note(present.every(Boolean), 'the five choices are in words: Change by %, Add contacts, Set total, Zero out, Undo adjustments');
await page.getByRole('button', { name: 'Zero out', exact: true }).click();
note(await page.getByRole('button', { name: 'Zero out', exact: true }).getAttribute('aria-pressed') === 'true' && /Expect no contacts/.test(await text()), 'choosing one marks it and explains it, with a sentence of what will happen');
await page.getByRole('button', { name: 'Change by %', exact: true }).click();
await page.getByLabel('Change (%)').fill('20');

// 4. drag across the chart to pick the intervals
const before = await volumes(draft.id);
const chart = page.locator('[aria-label^="Forecast chart"]');
const box = await chart.boundingBox();
const y = box.y + box.height * 0.45;
await page.mouse.move(box.x + box.width * 0.36, y);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.44, y, { steps: 6 });
await page.mouse.move(box.x + box.width * 0.52, y, { steps: 6 });
note(await page.locator('.recharts-reference-area').count() > 0, 'while dragging the chosen part of the chart is shaded');
await page.mouse.up();
await page.waitForTimeout(400);
const sel = (await text()).match(/Selected (\d\d:\d\d) to (\d\d:\d\d) on [^.]+ \((\d+) intervals?\)/);
note(!!sel && Number(sel[3]) >= 3, 'letting go says what was selected', sel ? sel[0] : 'no "Selected" line');
const tFrom = await page.getByLabel('From time').inputValue(), tTo = await page.getByLabel('To time (last interval)').inputValue();
note(sel && tFrom === sel[1] && tTo === sel[2], 'and the From and To times in the form are filled in from it', `${tFrom} to ${tTo}`);
const sentence = (await page.getByTestId('adjustment-sentence').innerText()).replace(/\s+/g, ' ');
note(new RegExp(`^Increase the forecast by 20% on ${day} between ${tFrom} and ${tTo} for all queues\\.$`).test(sentence), 'the sentence says exactly what applying will do', sentence);
await page.screenshot({ path: path.join(SHOTS, '2-selected.png') });
note(await page.getByRole('button', { name: 'Apply adjustment' }).isDisabled(), 'Apply waits for a reason');
await page.getByLabel('Reason (required)').fill('campaign test');
await page.getByRole('button', { name: 'Apply adjustment' }).click();
await page.getByText(/Adjusted \d+ rows/).waitFor({ timeout: 30000 });
const after = await volumes(draft.id);
const slotA = Math.floor(Number(tFrom.slice(0, 2)) * 4 + Number(tFrom.slice(3)) / 15), slotB = Math.floor(Number(tTo.slice(0, 2)) * 4 + Number(tTo.slice(3)) / 15);
let inside = true, outside = true;
for (const [slot, v0] of before) { const v1x = after.get(slot); if (slot >= slotA && slot <= slotB) { if (v0 > 1 && Math.abs(v1x / v0 - 1.2) > 0.02) inside = false; } else if (Math.abs(v1x - v0) > 0.001) outside = false; }
note(inside && outside, 'only the intervals dragged over went up by 20%, nothing else changed', `slots ${slotA} to ${slotB}`);
await page.waitForTimeout(800);
note(/campaign test/.test(await text()), 'and the change is in the history with its reason');

// 5. zero out and undo
await page.waitForTimeout(1500);                       // the numbers are being refreshed after the change, and the notice has moved the chart down
await page.evaluate(() => { const w = document.querySelector('.ref-ui'); if (w) w.scrollTop = 0; });       // applying scrolled the page down to the form
await page.waitForTimeout(300);
const box2 = await chart.boundingBox(), y2 = box2.y + box2.height * 0.45;
await page.mouse.move(box2.x + box2.width * 0.62, y2);
await page.mouse.down(); await page.mouse.move(box2.x + box2.width * 0.7, y2, { steps: 8 }); await page.mouse.up();
await page.waitForTimeout(400);
const sel2 = (await text()).match(/Selected (\d\d:\d\d) to (\d\d:\d\d)/);
note(!!sel2 && sel2[1] !== sel[1] && sel2[1] > sel[2], 'a second drag picks a different part of the day', sel2 ? `${sel2[1]} to ${sel2[2]}` : 'none');
await page.getByRole('button', { name: 'Zero out', exact: true }).click();
const z0 = await page.getByLabel('From time').inputValue(), z1 = await page.getByLabel('To time (last interval)').inputValue();
await page.getByLabel('Reason (required)').fill('closed for a meeting');
await page.getByRole('button', { name: 'Apply adjustment' }).click();
await page.waitForTimeout(2500);
const zeroed = await volumes(draft.id);
const za = Number(z0.slice(0, 2)) * 4 + Number(z0.slice(3)) / 15, zb = Number(z1.slice(0, 2)) * 4 + Number(z1.slice(3)) / 15;
note([...zeroed].filter(([s]) => s >= za && s <= zb).every(([, v]) => v === 0), 'Zero out empties the dragged intervals', `${z0} to ${z1}`);
await page.getByRole('button', { name: 'Undo adjustments', exact: true }).click();
await page.getByLabel('From time').fill('00:00'); await page.getByLabel('To time (last interval)').fill('23:45');
await page.getByLabel('Reason (required)').fill('back to the model');
await page.getByRole('button', { name: 'Apply adjustment' }).click();
await page.waitForTimeout(2500);
const restored = await volumes(draft.id);
note([...before].every(([s, v]) => Math.abs((restored.get(s) ?? 0) - v) < 0.001), 'Undo adjustments takes everything back to the model\'s own numbers');

// 6. a forecast waiting for review: return it to draft, with a reason
await call(token, 'POST', `/forecast/versions/${draft.id}/submit`, {});
await page.reload({ waitUntil: 'domcontentloaded' });
await bar.getByLabel('Forecast').waitFor({ timeout: 60000 });
await bar.getByLabel('Forecast').selectOption(draft.id);          // after a reload the live version is the one shown
await page.getByText(/waiting to be approved, so it is locked/).waitFor({ timeout: 60000 });
const back = page.getByRole('button', { name: 'Return to draft…' });
note(await back.isVisible() && (await page.getByRole('button', { name: 'Apply adjustment' }).count()) === 0, 'a forecast waiting for approval offers "Return to draft…" in its banner');
await back.click();
const dlg = page.getByRole('dialog', { name: /Return v\d+ to draft/ });
await dlg.waitFor();
note(await dlg.getByRole('button', { name: 'Return to draft', exact: true }).isDisabled(), 'it asks for a reason first');
await dlg.getByRole('textbox').fill('one more change');
await dlg.getByRole('button', { name: 'Return to draft', exact: true }).click();
await page.getByRole('button', { name: 'Apply adjustment' }).waitFor({ timeout: 30000 });
note((await versions()).find((v) => v.id === draft.id).status === 'DRAFT', 'and it is a draft again, with the form ready');

// 7. quality
await page.waitForTimeout(500);
const axe = await new AxeBuilder({ page }).analyze();
const bad = axe.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
note(bad.length === 0, 'no serious or critical accessibility violations', bad.map((v) => `${v.id} (${v.nodes.length}): ${v.nodes.slice(0, 2).map((x) => x.html.slice(0, 260)).join(' ## ')}`).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 2).join(' | '));
await browser.close();
console.log(`${results.filter(Boolean).length}/${results.length} checks passed; screenshots in ${SHOTS}`);
process.exit(results.every(Boolean) ? 0 : 1);
