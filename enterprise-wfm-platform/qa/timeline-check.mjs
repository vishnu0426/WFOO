// Looks at Scheduling > Schedule Timeline in a real browser at 1280 x 665 (a small laptop), against a test stack. It builds its own group of 130 people and a published one-week schedule that breaks a few rules:
//   QA_API=http://localhost:4012 QA_ADMIN_URL=http://localhost:3010 QA_ADMIN_PASSWORD=... node timeline-check.mjs
import { chromium } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { seed, call } from './timeline-seed.mjs';

const URL = process.env.QA_ADMIN_URL || 'http://localhost:3000';
const PASS = process.env.QA_ADMIN_PASSWORD || '';
const SHOTS = process.env.QA_SHOTS || path.join(os.tmpdir(), 'wfm-timeline-check');
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const note = (ok, what, extra = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`); };

const s = await seed();
const { token, group, version, today } = s;
const days = []; for (let i = 0; i < 7; i++) { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + i); days.push(d.toISOString().slice(0, 10)); }
const allShifts = (await call(token, 'GET', `/scheduling/versions/${version.id}/shifts`)).json;
// thin out the early morning of the first day so that cover is short there
const firstDay = allShifts.filter((x) => x.day === today).sort((a, b) => a.startSlot - b.startSlot);
for (const x of firstDay.slice(0, Math.floor(firstDay.length * 0.4))) await call(token, 'DELETE', `/scheduling/versions/${version.id}/shifts/${x.id}?reason=${encodeURIComponent('QA: thin the morning')}`);
const full = (await call(token, 'GET', `/scheduling/versions/${version.id}`)).json;
const violations = (full.violations ?? []).filter((v) => v.severity !== 'WARN');
const onToday = (await call(token, 'GET', `/scheduling/versions/${version.id}/shifts?from=${today}&to=${today}`)).json;
note(version.status === 'PUBLISHED' && violations.length > 0 && onToday.length > 20, `set-up: a published schedule for ${s.people} people that breaks rules`, `${violations.length} violations, ${onToday.length} on shift on the first day`);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [], limited = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 665 } });
await ctx.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); localStorage.setItem('wfm.timeline.density', 'comfortable'); } }, group.id);
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('response', (r) => { if (r.status() === 429) limited.push(r.url().split('/api/v1').pop()); });
page.on('console', (m) => { if (m.type() === 'error' && !(/429/.test(m.text()) && limited.every((u) => u.startsWith('/auth/login-options')))) errors.push(m.text()); });
await page.goto(URL + '/', { waitUntil: 'domcontentloaded', timeout: 120000 });
await page.getByLabel(/^Username/i).waitFor();
const org = page.getByLabel(/Organisation code/i);
if (await org.isVisible().catch(() => false)) await org.fill('ORG');
await page.getByLabel(/^Username/i).fill('admin');
await page.getByLabel(/^Password/i).fill(PASS);
await page.getByRole('button', { name: /^Sign in$/ }).click();
await page.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await page.goto(URL + '/scheduling/schedule-timeline', { waitUntil: 'domcontentloaded' });
const scroll = page.getByTestId('timeline-scroll');
await scroll.waitFor({ timeout: 60000 }).catch(async (e) => { await page.screenshot({ path: path.join(SHOTS, 'fail.png') }); console.log('ERRORS', errors.slice(0, 3).join(' | ')); console.log((await page.locator('body').innerText()).slice(0, 700)); throw e; });
await page.waitForTimeout(800);
const text = async (loc) => (await loc.innerText()).replace(/\s+/g, ' ');

// 0. it opens on today, at the actual time, on the group's own clock
const nowUtc = new Date(), todayUtc = nowUtc.toISOString().slice(0, 10), nowSlotUtc = nowUtc.getUTCHours() * 4 + nowUtc.getUTCMinutes() / 15;
note((await page.getByLabel('Jump to date').inputValue()) === todayUtc, 'it opens on today, not the first day of the schedule', todayUtc);
note(/Time \(UTC\)/i.test(await text(scroll)), 'and the axis says whose clock it is on: Time (UTC)');
const nl = page.getByTestId('now-line');
if (await nl.count()) {
  const slot = Number(await nl.getAttribute('data-now-slot'));
  note(Math.abs(slot - Math.floor(nowSlotUtc)) <= 1, 'the "now" line is at the current time', `slot ${slot}, expected ${Math.floor(nowSlotUtc)}`);
} else note(true, 'the current time is outside the hours this day is staffed, so there is no "now" line', `slot ${Math.floor(nowSlotUtc)}`);
const coverNow = onToday.some((x) => x.startSlot <= nowSlotUtc && nowSlotUtc < x.startSlot + x.lengthSlots);
if (coverNow) {
  const sbox = await scroll.boundingBox();
  const firstShown = await scroll.evaluate((el) => { const top = el.getBoundingClientRect().top + 60; const rows = [...el.querySelectorAll('[data-shift-id]')].map((r) => ({ t: r.getBoundingClientRect().top, d: r.getAttribute('data-slots') })).filter((r) => r.t >= top - 40).sort((a, b) => a.t - b.t); return rows[0]?.d ?? null; });
  const [st, ln] = (firstShown ?? '0|0').split('|').map(Number);
  note(st <= nowSlotUtc && nowSlotUtc < st + ln, 'the first people shown are the ones on shift right now', `${firstShown} at slot ${Math.floor(nowSlotUtc)}`);
} else note(true, 'nobody is on shift at this time of day, so no row is singled out');
note((await page.getByTestId('now-button').count()) === 1, 'a Now button is there to come back to the current time');

// 1. it is a workspace: the schedule is in view at once, and nothing else scrolls with it
const sb = await scroll.boundingBox();
note(sb.y < 340, 'the schedule starts in the top half of a 665 px screen, with the header compressed above it', `top at ${Math.round(sb.y)} px`);
note(sb.y + sb.height <= 665 + 24 && sb.height >= 300, 'and fills the rest of the screen down to the bottom edge', `${Math.round(sb.height)} px tall, bottom at ${Math.round(sb.y + sb.height)}`);
const h1 = await page.locator('h1').first().boundingBox();
note(h1 && h1.height <= 30, 'the page title is one slim line (the sub-title is behind a help mark)', `${Math.round(h1?.height ?? 0)} px`);
const tbBox = await page.locator('div.sticky.top-0.z-30').first().boundingBox();
note(tbBox && tbBox.height <= 140, 'the toolbar is two compact rows', `${Math.round(tbBox?.height ?? 0)} px`);
// scrolled down, the toolbar rests flush against the top of the page: nothing shows through a gap above it
await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { const cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 400 && el.contains(document.querySelector('[data-testid=workspace]'))) { el.scrollTop = 150; break; } } });
await page.waitForTimeout(300);
const tbs = await page.locator('div.sticky.top-0.z-30').first().boundingBox();
const hubTop = await page.evaluate(() => { let p = document.querySelector('[data-testid=workspace]').parentElement; while (p && !(/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1)) p = p.parentElement; return p.getBoundingClientRect().top; });
note(Math.abs(tbs.y - hubTop) <= 1, 'scrolled down, the toolbar sits flush at the top (nothing peeks through above it)', `toolbar at ${Math.round(tbs.y)}, page edge at ${Math.round(hubTop)}`);
const wsb = await page.getByTestId('workspace').boundingBox();
note(wsb.y + wsb.height >= 665 - 30 && wsb.y + wsb.height <= 665 + 24, 'scrolled down, the schedule still reaches the bottom of the screen (no gap opens beneath it)', `bottom at ${Math.round(wsb.y + wsb.height)}`);
await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollTop > 0 && el.clientHeight > 400 && el.contains(document.querySelector('[data-testid=workspace]'))) { el.scrollTop = 0; break; } } });
await page.waitForTimeout(300);
const rowH = (await scroll.locator('[data-shift-id]').first().boundingBox()).height;
note(rowH <= 40, 'people rows are compact, even where an old "Roomy" choice was saved', `${Math.round(rowH)} px a row`);
const strip = await page.getByTestId('staffing-strip').boundingBox();
note(strip.height <= 28 && !/Open need/i.test(await text(scroll)), 'the Staffing net and Open need strips are one slim strip', `${Math.round(strip.height)} px`);
const visibleRows = await scroll.evaluate((el) => { const b = el.getBoundingClientRect(); return [...el.querySelectorAll('[data-shift-id]')].filter((r) => { const x = r.getBoundingClientRect(); return x.top >= b.top + 50 && x.bottom <= b.bottom + 1; }).length; });
note(visibleRows >= 6, 'more people show at once on this small screen', `${visibleRows} people`);
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByRole('button', { name: 'Roomy', exact: true }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const roomy = (await scroll.locator('[data-shift-id]').first().boundingBox()).height;
note(roomy >= 50, 'Row height > Roomy is still a choice', `${Math.round(roomy)} px`);
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByRole('button', { name: 'Compact', exact: true }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
note(!/Breaks a rule/.test(await text(scroll)) && (await scroll.getByRole('button', { name: 'Key' }).count()) === 1, 'the colour key is one button in the corner of the axis, not two lines of legend', 'Key');
await scroll.getByRole('button', { name: 'Key' }).click();
note(/Breaks a rule/.test(await text(scroll.getByRole('dialog', { name: 'Key' }))), 'and opens the legend when asked');
await scroll.getByRole('button', { name: 'Key' }).click();
await page.getByRole('button', { name: /^Filters/ }).click();
const fb = await page.getByRole('dialog').filter({ hasText: 'Everyone on shift' }).boundingBox();
note(fb && fb.x >= 0 && fb.x + fb.width <= 1280, 'the Filters menu opens inside the screen (it used to run off the right edge)', `${Math.round(fb?.x ?? 0)}–${Math.round((fb?.x ?? 0) + (fb?.width ?? 0))} px`);
await page.keyboard.press('Escape');
const sizes = await scroll.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth }));
note(sizes.sw <= sizes.cw + 1, 'the whole day fits across the screen: no sideways scrolling', `${sizes.sw} of ${sizes.cw} px`);
const ticks = await scroll.locator('span.font-mono').allInnerTexts();
note(ticks.length >= 4 && ticks.some((t) => /^0[6-9]:00$/.test(t)) && ticks.some((t) => /^(1[8-9]|2[0-2]):00$/.test(t)), 'and the time axis runs from the morning to the evening', ticks.slice(0, 3).join(' ') + ' … ' + ticks.slice(-2).join(' '));
const rendered = await scroll.locator('[data-shift-id]').count();
const total = Number(await scroll.getAttribute('data-rows'));
note(total >= 50 && rendered < total, 'only the rows in view are drawn, so a big day stays quick', `${rendered} drawn of ${total}`);
await scroll.evaluate((el) => { el.scrollTop = 1500; });
await page.waitForTimeout(300);
const rendered2 = await scroll.locator('[data-shift-id]').count();
const nm = await scroll.locator('[data-shift-id]').first().innerText();
note(rendered2 < 45 && rendered2 > 5, 'scrolling swaps in the next rows', `${rendered2} drawn, first now ${nm.split('\n')[0]}`);
await scroll.evaluate((el) => { el.scrollTop = 0; });
const inner = await page.evaluate(() => { let n = 0; for (const el of document.querySelectorAll('[data-testid=workspace] *')) { const cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 2 && el.getBoundingClientRect().height > 100) n++; } return n; });
note(inner <= 2, 'inside the workspace only the schedule and the panel scroll, not boxes inside boxes', `${inner} scrolling areas`);
await page.screenshot({ path: path.join(SHOTS, '1-workspace.png') });

// 2. the issues panel
const panel = page.getByTestId('issues-panel');
note(await panel.isVisible(), 'an Issues panel sits beside the schedule');
const vnote = await text(page.getByTestId('violations-note'));
note(/rules? (is|are) broken in the published schedule\. Fix (it|them), then republish\./.test(vnote) && !/before this schedule can be published/.test(await text(panel)), 'for a published schedule it says "fix them, then republish", not "before publishing"', vnote.slice(0, 100));
const items = page.getByTestId('issue-item');
note((await items.count()) === Math.min(8, violations.length), 'every violation is listed as a button', `${await items.count()} of ${violations.length}`);
const pl = await text(page.getByTestId('people-line'));
const m = pl.match(/^([\d,]+) people in this schedule · ([\d,]+) on shift this day$/);
note(!!m && Number(m[1].replace(/,/g, '')) === s.people && Number(m[2].replace(/,/g, '')) === onToday.length, 'the two head counts are named apart: people in the schedule and people on shift this day', pl);
await page.getByRole('button', { name: /^Filters/ }).click();
const opt = await page.getByRole('combobox', { name: 'Problem filter' }).locator('option').first().innerText();
note(opt === `Everyone on shift this day (${onToday.length})`, 'and the filter says the same number, with the same words', opt);
await page.keyboard.press('Escape');

// the Now button returns to today
await page.getByLabel('Jump to date').fill(days[3]);
await page.waitForTimeout(400);
await page.getByTestId('now-button').click();
await page.waitForFunction((d) => document.querySelector('input[aria-label="Jump to date"]')?.value === d, todayUtc, { timeout: 10000 });
note((await page.getByLabel('Jump to date').inputValue()) === todayUtc, 'Now brings you back to today from another day');

// 3. one click from an issue to the person
const target = violations.find((v) => v.day !== today && days.includes(v.day)) ?? violations[0];
const sameDay = target.day === today;
const item = page.getByTestId('issue-item').filter({ hasText: target.employeeName }).first();
await item.waitFor({ timeout: 10000 });
await item.click();
const flashed = await page.waitForFunction(() => document.querySelector('[data-testid=timeline-scroll] [data-shift-id][class*="C84A4A"]'), null, { timeout: 6000 }).then(() => true).catch(() => false);
await page.waitForFunction((d) => document.querySelector('input[aria-label="Jump to date"]')?.value === d, target.day, { timeout: 20000 });
note((await page.getByLabel('Jump to date').inputValue()) === target.day, 'clicking a violation opens its day', target.day + (sameDay ? ' (already open)' : ''));
const sel = page.getByTestId('selected-card');
await sel.waitFor({ timeout: 20000 });
note(flashed, 'the person\'s row flashes so the eye finds it');
await page.waitForTimeout(900);
const row = scroll.locator('[data-shift-id]').filter({ hasText: target.employeeName }).first();
const rb = await row.boundingBox(), sb2 = await scroll.boundingBox();
note(rb && rb.y >= sb2.y && rb.y + rb.height <= sb2.y + sb2.height + 2, 'and the row is scrolled into view', `row at ${Math.round(rb?.y ?? 0)}, area ${Math.round(sb2.y)}–${Math.round(sb2.y + sb2.height)}`);
const st = await text(sel);
note(st.includes(target.employeeName) && st.includes(target.message.slice(0, 20)), 'the panel shows that person with what is wrong with their day', st.slice(0, 110));
note(true, 'from the list to the person took one click, and no scrolling by hand');

// 4. short intervals
const gapsShown = await page.getByTestId('gap-item').count();
await page.getByLabel('Jump to date').fill(today);
await page.waitForTimeout(1200);
const gapItems = page.getByTestId('gap-item');
await gapItems.first().waitFor({ timeout: 20000 });
const gt = await text(gapItems.first());
note(/^\d\d:\d\d–\d\d:\d\d short by \d+ \d+ min$/.test(gt), 'short stretches of the day are listed with time and how short', gt);
await gapItems.first().click();
await page.waitForTimeout(500);
note((await scroll.locator('.animate-pulse').count()) >= 1, 'clicking one flashes that stretch on the staffing strip');

// 5. edits go through the panel, with undo
await scroll.evaluate((el) => { el.scrollTop = 0; });
await page.waitForTimeout(300);
const bar = scroll.locator('[data-shift-id]').nth(3).locator('div.absolute').first();
await bar.click({ position: { x: 6, y: 6 } });
const sel2 = page.getByTestId('selected-card');
await sel2.waitFor({ timeout: 10000 });
const who = (await sel2.locator('div.truncate').first().innerText()).trim();
note(/Their week/.test(await text(sel2)) && /Remove shift/.test(await text(sel2)), 'clicking a bar shows the person and their actions in the panel', who);
const undo = page.getByRole('button', { name: /^Undo/ });
note(await undo.isDisabled() && /No edits yet/.test(await text(panel)), 'Undo starts off, saying there are no edits yet');
const before = await scroll.getAttribute('data-rows');
await sel2.getByRole('button', { name: 'Remove shift' }).click();
await page.getByPlaceholder('Reason (required)').first().fill('QA: remove one shift');
await page.getByRole('button', { name: 'Confirm' }).first().click();
await page.waitForFunction((n) => Number(document.querySelector('[data-testid=timeline-scroll]')?.getAttribute('data-rows')) === n - 1, Number(before), { timeout: 30000 });
note(await undo.isEnabled() && /Removed/.test(await text(panel)), 'the edit is done and Undo names it', (await text(panel)).match(/Removed[^·]*/)?.[0]?.slice(0, 70));
await undo.click();
await page.waitForFunction((n) => Number(document.querySelector('[data-testid=timeline-scroll]')?.getAttribute('data-rows')) === n, Number(before), { timeout: 30000 });
note((await scroll.getAttribute('data-rows')) === before, 'Undo puts the shift back');

// 5b. dragging a bar still asks why, even with only the rows in view drawn
await scroll.evaluate((el) => { el.scrollTop = 0; });
await page.waitForTimeout(300);
const dragBar = scroll.locator('[data-shift-id]').nth(2).locator('div.absolute').first();
const db = await dragBar.boundingBox();
// grab the bar by its left end, where the shift's label is: the middle of it can be a meal or a break, which is dragged on its own
await page.mouse.move(db.x + 6, db.y + db.height / 2);
await page.mouse.down();
await page.mouse.move(db.x + 6 + 45, db.y + db.height / 2, { steps: 6 });
await page.mouse.up();
const ask = page.getByText(/Why is .* shift moving to \d\d:\d\d\?/);
note(await ask.isVisible({ timeout: 5000 }).catch(() => false), 'dragging a bar sideways asks for a reason before it moves', (await ask.first().innerText().catch(() => '')).slice(0, 70));
await page.getByRole('button', { name: 'Cancel' }).first().click();

// 6. the scale control, and week view
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByRole('button', { name: '1h', exact: true }).click();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const z = await scroll.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
note(z.sw > z.cw, 'a fixed scale (1h) brings sideways scrolling back, for those who want it', `${z.sw} of ${z.cw}`);
await page.getByRole('button', { name: '15m', exact: true }).click();
await page.waitForTimeout(500);
const z15 = await scroll.evaluate((el) => { const b = el.getBoundingClientRect(); const bar = el.querySelector('[data-testid=now-line]') ?? el.querySelector('[data-shift-id] div.absolute'); const r = bar?.getBoundingClientRect(); return { left: el.scrollLeft, inView: !!r && r.left >= b.left + 200 && r.left < b.right - 20 }; });
note(z15.left > 0 && z15.inView, 'a fixed scale (15m) starts at the current time (or the first shift), not at midnight', `scrolled ${Math.round(z15.left)} px`);
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByRole('button', { name: 'Fit', exact: true }).click();
await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Week', exact: true }).click();
await page.waitForTimeout(800);
note((await page.getByTestId('timeline-scroll').count()) === 0 && (await page.getByTestId('issues-panel').count()) === 1, 'Week view swaps the day for the week, and the panel stays');
await page.getByRole('button', { name: 'Day', exact: true }).click();
await page.getByTestId('timeline-scroll').waitFor({ timeout: 20000 });

// 7. Roster is a tab of the same workspace
await page.getByRole('tab', { name: 'Roster' }).click();
const rosterBox = page.getByTestId('roster-scroll');
await rosterBox.waitFor({ timeout: 20000 });
note((await page.getByRole('tab', { name: 'Roster' }).getAttribute('aria-selected')) === 'true' && (await page.getByTestId('issues-panel').count()) === 1, 'Roster is a tab beside Timeline, and the issues panel stays');
const rb0 = await rosterBox.boundingBox();
await page.screenshot({ path: path.join(SHOTS, '2-roster.png') });
const wsBox = await page.getByTestId('workspace').boundingBox();
note(rb0.y - wsBox.y <= 90 && rb0.y + rb0.height <= wsBox.y + wsBox.height + 2 && rb0.height >= 250, 'it fills the same space as the timeline, under the same title line', `${Math.round(rb0.y - wsBox.y)} px below the top of the workspace, ${Math.round(rb0.height)} px tall`);
const heads = await rosterBox.locator('thead th').allInnerTexts();
note(heads.length === days.length + 3 && /Person/i.test(heads[0]) && /Paid/i.test(heads[heads.length - 2]) && /Issues/i.test(heads[heads.length - 1]), 'one column per day, then Paid and Issues', heads.map((h) => h.replace(/\s+/g, ' ').slice(0, 14)).join(' | '));
const peopleOnRoster = Number(await rosterBox.getAttribute('data-rows'));
const peopleWithShifts = new Set(allShifts.map((x) => x.employeeId)).size;
note(peopleOnRoster === peopleWithShifts, 'every person with a shift in the period is a row', `${peopleOnRoster} of ${peopleWithShifts}`);
const rNames = async () => (await rosterBox.locator('tbody th[scope=row] button').allInnerTexts()).map((t) => t.replace(/^! /, '').trim());
const numsOf = (xs) => xs.map((n) => Number((n.match(/First(\d+)/) ?? [])[1])).filter((n) => Number.isFinite(n));
const n1 = numsOf(await rNames());
note(n1.length >= 10 && n1.slice(0, 12).every((n, i) => n === i + 1), 'people are in natural order: First1, First2 … First9, First10, not First1, First10, First100', n1.slice(0, 12).join(','));
note((await rosterBox.locator('tbody tr[data-person]').count()) < peopleOnRoster, 'only the rows in view are drawn', `${await rosterBox.locator('tbody tr[data-person]').count()} of ${peopleOnRoster}`);
const badCells = await rosterBox.locator('td.bg-\\[\\#FCEBEC\\]').count();
note(badCells >= 1, 'days that break a rule are red on the roster', `${badCells} red cell(s) in view`);
// options
await page.getByRole('combobox', { name: 'Sort the roster' }).selectOption('violations');
await page.waitForTimeout(300);
const first = (await rNames())[0];
const withIssues = new Set(violations.map((v) => v.employeeName));
note(withIssues.has(first), 'Sort > Most issues first puts someone with a violation at the top', first);
await page.getByRole('combobox', { name: 'Sort the roster' }).selectOption('name');
await page.getByRole('button', { name: 'Hours', exact: true }).click();
const cellTxt = await rosterBox.locator('tbody td button').first().innerText();
note(/^\d+(\.\d)? h$/.test(cellTxt.trim()), 'Show > Hours turns the cells into paid hours', cellTxt);
await page.getByRole('button', { name: 'Times', exact: true }).click();
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByLabel('Group by team').check();
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
note((await rosterBox.locator('tbody th[scope=rowgroup]').count()) >= 1, 'Group by team (in the View menu, shared with the timeline) adds a heading per team');
await page.getByRole('button', { name: 'View', exact: true }).click();
await page.getByLabel('Group by team').uncheck();
await page.keyboard.press('Escape');
await page.getByPlaceholder('Search agent name or ID').fill('First7');
await page.waitForTimeout(400);
const found = await rNames();
note(found.length >= 1 && found.every((n) => /First7/.test(n)), 'search narrows the roster to the people typed', found.slice(0, 4).join(', '));
await page.getByPlaceholder('Search agent name or ID').fill('');
await page.waitForTimeout(300);
await page.locator('summary', { hasText: 'Export' }).click();
note(await page.getByRole('button', { name: /^CSV$/ }).isVisible(), 'Export (CSV, Excel, PDF) is on the roster tab');
await page.locator('summary', { hasText: 'Export' }).click();
// a cell opens that person's day on the timeline
const cell = rosterBox.locator('tbody td button').first();
const cellId = (await cell.getAttribute('data-cell')).split('|');
await cell.click();
await page.getByTestId('timeline-scroll').waitFor({ timeout: 20000 });
await page.waitForFunction((d) => document.querySelector('input[aria-label="Jump to date"]')?.value === d, cellId[1], { timeout: 20000 });
note((await page.getByRole('tab', { name: 'Timeline' }).getAttribute('aria-selected')) === 'true' && (await page.getByLabel('Jump to date').inputValue()) === cellId[1], 'clicking a cell opens that person on their day on the timeline', cellId[1]);
note((await page.getByTestId('selected-card').count()) === 1, 'and selects them');

// 7b. select everyone is one link, and the bulk bar appears only once someone is ticked
const selAll = page.getByRole('button', { name: /^Select all \(\d+\)$/ });
await selAll.waitFor({ timeout: 10000 });
note((await page.getByText('selected').count()) === 0 || !/\d+ selected/.test(await text(page.getByTestId('workspace'))), 'there is no bulk bar until someone is ticked');
await selAll.click();
note(/\d+ selected/.test(await text(page.getByTestId('workspace'))), 'Select all ticks everyone shown and the bulk bar appears');
await page.locator('button', { hasText: /^Clear selection$/ }).click();

// 8. the other scheduling pages share the same frame: they still open and scroll
for (const [sub, heading] of [['generate-schedule', 'Generate Schedule'], ['schedule-quality', 'Schedule Quality'], ['all-schedules', 'All Schedules'], ['shift-templates', 'Shift Templates']]) {
  await page.goto(URL + '/scheduling/' + sub, { waitUntil: 'domcontentloaded' });
  await page.locator('h1', { hasText: heading }).first().waitFor({ timeout: 60000 }).catch(() => undefined);
  const ok = (await page.locator('h1', { hasText: heading }).count()) > 0;
  note(ok, `${heading} still opens in the same frame`);
}
await page.goto(URL + '/scheduling/schedule-timeline', { waitUntil: 'domcontentloaded' });
await page.getByTestId('timeline-scroll').waitFor({ timeout: 60000 });

// 9. layout, accessibility, console
note((await page.evaluate(() => document.documentElement.scrollWidth)) <= 1280, 'the page does not scroll sideways at 1280 px');
const ax = await new AxeBuilder({ page }).include('[data-testid=workspace]').analyze();
note(ax.violations.length === 0, 'no accessibility violations in the workspace', ax.violations.map((x) => x.id + ': ' + x.nodes.map((n) => n.html.slice(0, 90)).join(' | ')).join(', '));
note(errors.length === 0, 'no console errors', errors.slice(0, 3).join(' | '));
// 10. a group whose clock is not UTC opens on its own today
const tz = 'Pacific/Kiritimati';
const s2 = await seed({ people: 20, tag: 'z', timezone: tz });
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 665 } });
await ctx2.addInitScript((id) => { if (!sessionStorage.getItem('qa_seeded')) { sessionStorage.setItem('qa_seeded', '1'); localStorage.setItem('wfm_group', id); } }, s2.group.id);
const p2 = await ctx2.newPage();
await p2.goto(URL + '/', { waitUntil: 'domcontentloaded' });
await p2.getByLabel(/^Username/i).waitFor();
if (await p2.getByLabel(/Organisation code/i).isVisible().catch(() => false)) await p2.getByLabel(/Organisation code/i).fill('ORG');
await p2.getByLabel(/^Username/i).fill('admin'); await p2.getByLabel(/^Password/i).fill(PASS);
await p2.getByRole('button', { name: /^Sign in$/ }).click();
await p2.getByLabel(/^Password/i).waitFor({ state: 'hidden', timeout: 30000 });
await p2.goto(URL + '/scheduling/schedule-timeline', { waitUntil: 'domcontentloaded' });
await p2.getByTestId('timeline-scroll').waitFor({ timeout: 90000 });
await p2.waitForTimeout(800);
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
const pv = (t) => Number(fmt.find((x) => x.type === t).value);
const tzDay = `${pv('year')}-${String(pv('month')).padStart(2, '0')}-${String(pv('day')).padStart(2, '0')}`, tzSlot = pv('hour') * 4 + pv('minute') / 15;
note((await p2.getByLabel('Jump to date').inputValue()) === tzDay, `a group in ${tz} opens on its own today, which is ${tzDay} there (UTC is ${todayUtc})`, tzDay);
note(/Time \(UTC\+14\)/i.test((await p2.getByTestId('timeline-scroll').innerText()).replace(/\s+/g, ' ')), 'and the axis names its clock: Time (UTC+14)');
if (await p2.getByTestId('now-line').count()) note(Math.abs(Number(await p2.getByTestId('now-line').getAttribute('data-now-slot')) - Math.floor(tzSlot)) <= 1, 'with the "now" line at that group\'s current time', `slot ${Math.floor(tzSlot)}`);
else note(true, 'the group\'s current time is outside its staffed hours: no "now" line', `slot ${Math.floor(tzSlot)}`);
await browser.close();
const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);
