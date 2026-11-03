#!/usr/bin/env node
/**
 * Finishes scripts/demo-seed.mjs when it stopped after the "Demo Support" group was created
 * (it refuses to run twice). Generates + publishes a schedule, sets self-service rules,
 * creates the three demo app logins and opens a giveaway, a VTO and an overtime offer.
 *
 *   QA_ADMIN_PASSWORD=... node qa/seed-finish.mjs
 */
const API = (process.env.QA_API ?? 'http://localhost:4000') + '/api/v1';
const TENANT = process.env.QA_TENANT ?? 'ORG';
const PASS = process.env.QA_ADMIN_PASSWORD;
if (!PASS) { console.error('Set QA_ADMIN_PASSWORD'); process.exit(1); }

const call = async (t, m, p, b) => {
  const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; }
  if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${typeof j === 'string' ? j : j?.error?.message ?? ''}`);
  return j;
};
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const hh = (s) => `${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')}`;

const tok = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASS, tenant: TENANT })).token;
const g = (await call(tok, 'GET', '/config/groups')).find((x) => x.name === 'Demo Support');
if (!g) { console.error('Run scripts/demo-seed.mjs first'); process.exit(1); }
const today = new Date(); today.setHours(0, 0, 0, 0);

let v = (await call(tok, 'GET', '/scheduling/versions')).find((x) => x.wfmGroupId === g.id && x.status === 'PUBLISHED');
if (!v) {
  console.log('- generating schedule');
  const t0 = Date.now();
  v = await call(tok, 'POST', '/scheduling/versions', { groupId: g.id, from: iso(addDays(today, 1)), weeks: 2, timeLimitSec: 45 });
  console.log(`  generated in ${((Date.now() - t0) / 1000).toFixed(1)}s, status ${v.status}`);
  await call(tok, 'POST', `/scheduling/versions/${v.id}/publish`);
}
const shifts = await call(tok, 'GET', `/scheduling/versions/${v.id}/shifts`);
console.log(`- ${shifts.length} shifts in published version ${v.id}`);

const pol = await call(tok, 'GET', '/self-service/policy');
await call(tok, 'PUT', '/self-service/policy', { ...pol, timeOffAutoApprove: true, timeOffMinNoticeDays: 3, swapAutoApprove: false, swapMinNoticeHours: 2, swapMaxExtraGapSlots: 8 });

const people = [...new Set(shifts.map((s) => s.employeeId))];
for (let i = 0; i < 3; i++) {
  await call(tok, 'POST', '/self-service/logins', { employeeId: people[i], username: `demo.agent${i + 1}`, password: 'Demo-Pass-123' })
    .then((c) => console.log(`- login ${c.username}`)).catch((e) => console.log(`  (login ${i + 1}: ${e.message})`));
}

const t2 = (await call(null, 'POST', '/auth/login', { username: 'demo.agent2', password: 'Demo-Pass-123', tenant: TENANT }));
console.log(`- demo.agent2 mustChangePassword=${t2.mustChangePassword}`);
const theirs = shifts.filter((s) => s.employeeId === people[1]).sort((a, b) => (a.day < b.day ? -1 : 1))[1];
if (theirs) await call(t2.token, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: theirs.id, note: 'QA giveaway' }).catch((e) => console.log('  (giveaway:', e.message, ')'));
const mine = shifts.filter((s) => s.employeeId === people[0]).sort((a, b) => (a.day < b.day ? -1 : 1))[0];
if (mine) {
  const end = mine.startSlot + mine.lengthSlots;
  await call(tok, 'POST', '/scheduling/offers', { groupId: g.id, kind: 'VTO', day: mine.day, startTime: hh(end - 8), endTime: hh(end), spots: 2, ordering: 'FIRST_COME', note: 'QA VTO' }).catch((e) => console.log('  (VTO:', e.message, ')'));
  await call(tok, 'POST', '/scheduling/offers', { groupId: g.id, kind: 'OVERTIME', day: mine.day, startTime: hh(end), endTime: hh(end + 8), spots: 1, ordering: 'FIRST_COME', note: 'QA OT' }).catch((e) => console.log('  (OT:', e.message, ')'));
}
console.log('done');
