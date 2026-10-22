#!/usr/bin/env node
/**
 * Demo data for trying the mobile app (and the self-service features in the web app) without setting everything up by hand.
 * It creates one WFM group with a queue, 10 weeks of call history, a published forecast, 30 people, shift templates and a published
 * two-week schedule, turns on automatic approval, gives three people an app login, and leaves a shift on the board and two offers open.
 *
 *   node scripts/demo-seed.mjs --api http://localhost:4000 --user admin --password <admin password> --tenant ORG
 *
 * It only ADDS things (a group called "Demo Support" and the people in it) and stops if that group already exists.
 * Run it against a test or demo database, not against real data.
 */
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const API = `${arg('api', 'http://localhost:4000').replace(/\/+$/, '')}/api/v1`;
const USER = arg('user', 'admin'), PASS = arg('password'), TENANT = arg('tenant');
if (!PASS) { console.error('Usage: node scripts/demo-seed.mjs --api http://localhost:4000 --user admin --password <password> [--tenant ORG]'); process.exit(1); }

const call = async (t, m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; }
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${typeof j === 'string' ? j : j?.error?.message ?? ''}`);
  return j;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hh = (s) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;
const step = (m) => console.log(`- ${m}`);

const tok = (await call(null, 'POST', '/auth/login', { username: USER, password: PASS, ...(TENANT ? { tenant: TENANT } : {}) })).token;
if ((await call(tok, 'GET', '/config/groups')).some((g) => g.name === 'Demo Support')) { console.log('The group "Demo Support" already exists, so nothing was changed.'); process.exit(0); }

step('creating the group, queue and call history');
const g = await call(tok, 'POST', '/config/groups', { name: 'Demo Support', serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
const q = await call(tok, 'POST', '/config/queues', { name: 'Demo Voice', channel: 'VOICE', wfmGroupId: g.id, ahtDefault: 400 });
const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const today = new Date(); today.setHours(0, 0, 0, 0);
const rows = ['queue,date,interval,volume,aht'];
for (let n = 70; n >= 1; n--) {
  const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.45 : 1;
  for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.6) / 4; rows.push(`${q.name},${iso(d)},${hh(s)},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${390 + Math.round(rnd() * 40)}`); }
}
const up = await call(tok, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'demo-history.csv', csv: rows.join('\n') });
await call(tok, 'POST', `/data/imports/${up.id}/commit`);

step('building and publishing a four-week forecast');
const f = await call(tok, 'POST', '/forecast/versions', { groupId: g.id, kind: 'SHORT', weeks: 4 });
for (const s of ['submit', 'approve', 'publish']) await call(tok, 'POST', `/forecast/versions/${f.id}/${s}`, {});

step('adding a team, shift templates and 30 people');
await call(tok, 'POST', '/workforce/teams', { name: 'Demo Team' });
for (const [n, a, b] of [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '11:30', '13:30']]) {
  await call(tok, 'POST', '/scheduling/templates', { name: `Demo ${n}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
}
const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week,hire_date'];
for (let i = 1; i <= 30; i++) lines.push(`D${String(i).padStart(3, '0')},Agent${i},Demo${i},Demo Team,Demo Support,FULL_TIME,40,5,${2015 + (i % 9)}-0${1 + (i % 9)}-15`);
await call(tok, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });

step('generating and publishing a two-week schedule (this can take up to a minute)');
const v = await call(tok, 'POST', '/scheduling/versions', { groupId: g.id, from: iso(addDays(today, 1)), weeks: 2, timeLimitSec: 45 });
await call(tok, 'POST', `/scheduling/versions/${v.id}/publish`);
const shifts = await call(tok, 'GET', `/scheduling/versions/${v.id}/shifts`);

step('setting the self-service rules');
const pol = await call(tok, 'GET', '/self-service/policy');
await call(tok, 'PUT', '/self-service/policy', { ...pol, timeOffAutoApprove: true, timeOffMinNoticeDays: 3, swapAutoApprove: false, swapMinNoticeHours: 2, swapMaxExtraGapSlots: 8 });

step('creating app logins');
const people = [...new Set(shifts.map((s) => s.employeeId))];
const logins = [];
for (let i = 0; i < 3; i++) {
  const c = await call(tok, 'POST', '/self-service/logins', { employeeId: people[i], username: `demo.agent${i + 1}`, password: 'Demo-Pass-123' });
  logins.push(c.username);
}

step('leaving something to act on: a shift on the board and a VTO and an overtime offer');
const t2 = (await call(null, 'POST', '/auth/login', { username: 'demo.agent2', password: 'Demo-Pass-123', ...(TENANT ? { tenant: TENANT } : {}) })).token;
const theirs = shifts.filter((s) => s.employeeId === people[1]).sort((a, b) => (a.day < b.day ? -1 : 1))[1];
if (theirs) await call(t2, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: theirs.id, note: 'Dentist appointment' }).catch(() => {});
const mine = shifts.filter((s) => s.employeeId === people[0]).sort((a, b) => (a.day < b.day ? -1 : 1))[0];
if (mine) {
  const end = mine.startSlot + mine.lengthSlots;
  await call(tok, 'POST', '/scheduling/offers', { groupId: g.id, kind: 'VTO', day: mine.day, startTime: hh(end - 8), endTime: hh(end), spots: 2, ordering: 'FIRST_COME', note: 'Quiet afternoon, leave when you like' }).catch((e) => console.log('  (no VTO offer:', e.message, ')'));
  await call(tok, 'POST', '/scheduling/offers', { groupId: g.id, kind: 'OVERTIME', day: mine.day, startTime: hh(end), endTime: hh(end + 8), spots: 1, ordering: 'FIRST_COME', note: 'Busy evening' }).catch((e) => console.log('  (no overtime offer:', e.message, ')'));
}

console.log('\nDone. Sign in to the mobile app with:');
console.log(`  organisation: ${TENANT ?? '(your organisation code)'}`);
for (const u of logins) console.log(`  username: ${u}    password: Demo-Pass-123`);
console.log('\nSee mobile/TESTING.md for what to try.');
