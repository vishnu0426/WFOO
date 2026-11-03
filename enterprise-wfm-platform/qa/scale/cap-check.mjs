// Proves what the LIMIT 2000 in loadEmployees does to bulk edit and re-import once a tenant has more than 2,000 people.
const API = 'http://localhost:4000/api/v1';
const call = async (t, m, p, b) => { const r = await fetch(API + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t }, body: b ? JSON.stringify(b) : undefined }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, j }; };
const tok = (await (await fetch(API + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.P, tenant: 'ORG' }) })).json()).token;
const all = (await call(tok, 'GET', '/workforce/employees')).j;
console.log('unfiltered list returns', all.length, 'people');
// people of S04 that are NOT in the capped list (by number, fetched via the q filter in pages of <=1000)
const s04 = [];
for (let k = 0; k <= 3; k++) s04.push(...(await call(tok, 'GET', `/workforce/employees?q=S04-0${k}`)).j);
const inCap = new Set(all.map((e) => e.id));
const outside = s04.filter((e) => !inCap.has(e.id)), inside = s04.filter((e) => inCap.has(e.id));
console.log('S04 people found via q pages:', s04.length, ' outside the 2,000 window:', outside.length, ' inside:', inside.length);
// 1) bulk edit someone outside the window
const pick = [outside[0], inside[0]].filter(Boolean);
const b = await call(tok, 'POST', '/workforce/employees/bulk', { ids: pick.map((e) => e.id), changes: { minRestHours: 12 }, reason: 'QA cap check' });
console.log('bulk edit ->', b.s, JSON.stringify(b.j).slice(0, 300));
for (const e of pick) { const g = await call(tok, 'GET', `/workforce/employees/${e.id}`); console.log(`  ${e.employeeNumber} (${inCap.has(e.id) ? 'inside' : 'outside'}) minRestHours now`, g.j.minRestHours); }
// 2) re-import (update) one person outside the window
const o = outside[1];
const csv = `employee_number,first_name,last_name,weekly_hours,max_weekly_hours,days_per_week\n${o.employeeNumber},${o.firstName},${o.lastName},38,48,5`;
const dry = await call(tok, 'POST', '/workforce/employees/import', { csv, dryRun: true });
console.log('re-import dry run for', o.employeeNumber, '->', dry.s, JSON.stringify({ diff: dry.j.diff, errors: dry.j.errors, sample: dry.j.sample }).slice(0, 300));
const real = await call(tok, 'POST', '/workforce/employees/import', { csv, dryRun: false });
console.log('re-import commit ->', real.s, JSON.stringify({ committed: real.j.committed, diff: real.j.diff, errors: real.j.errors, msg: real.j.error?.message }).slice(0, 300));
