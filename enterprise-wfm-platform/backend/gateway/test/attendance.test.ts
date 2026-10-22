/**
 * Time & attendance: punches imported from a time-clock export, compared against the published schedule, rolled
 * into a payroll export (regular / overtime hours per person per day).
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json, e.g. a CSV export */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const mondayOnOrAfter = (d: Date) => addDays(d, (8 - d.getDay()) % 7 || 7);

const ctx: Record<string, any> = {};
let admin = '';

describe('time & attendance', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); admin = r.json.token; });

  it('prepares an employee', async () => {
    await call(admin, 'POST', '/workforce/teams', { name: `Att team ${RUN}` });
    const lines = ['employee_number,first_name,last_name,team,employment_type,weekly_hours', `AT${RUN},Att,Endance,Att team ${RUN},FULL_TIME,40`];
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    ctx.emp = (await call(admin, 'GET', '/workforce/employees')).json.find((e: any) => e.employeeNumber === `AT${RUN}`);
    assert.ok(ctx.emp);
    ctx.monday = mondayOnOrAfter(new Date());
  });

  it('imports a week of punches with a dry run first, then commits', async () => {
    const empNo = `AT${RUN}`;
    // Mon-Fri, 9h in the office each day (including a lunch, so 9h clocked but the schedule below has no matching shift: this person is "unscheduled" all week)
    const rows = ['employee_number,day,clock_in,clock_out'];
    for (let i = 0; i < 5; i++) rows.push(`${empNo},${iso(addDays(ctx.monday, i))},08:00,17:00`);
    const csv = rows.join('\n');

    const dry = await call(admin, 'POST', '/attendance/import', { csv, dryRun: true });
    assert.equal(dry.status, 200, dry.text);
    assert.equal(dry.json.committed, false);
    assert.equal(dry.json.newPunches, 5);
    assert.equal(dry.json.errorCount, 0);

    const committed = await call(admin, 'POST', '/attendance/import', { csv, dryRun: false });
    assert.equal(committed.json.committed, true);
    assert.equal(committed.json.newPunches, 5);

    const again = await call(admin, 'POST', '/attendance/import', { csv, dryRun: false });
    assert.equal(again.json.newPunches, 0, 'the same rows are not imported twice');
    assert.equal(again.json.alreadyImported, 5);
  });

  it('flags an unknown employee number instead of failing the whole file', async () => {
    const csv = `employee_number,day,clock_in,clock_out\nNO-SUCH-PERSON,${iso(ctx.monday)},08:00,17:00`;
    const r = await call(admin, 'POST', '/attendance/import', { csv, dryRun: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.errorCount, 1);
    assert.match(r.json.errors[0].message, /Unknown employee number/);
  });

  it('handles an overnight punch (clock-out earlier than clock-in means the next day)', async () => {
    const day = iso(addDays(ctx.monday, 7));
    const csv = `employee_number,day,clock_in,clock_out\nAT${RUN},${day},22:00,06:00`;
    assert.equal((await call(admin, 'POST', '/attendance/import', { csv, dryRun: false })).json.newPunches, 1);
    const p = (await call(admin, 'GET', `/attendance/punches?employeeId=${ctx.emp.id}&from=${day}&to=${day}`)).json[0];
    assert.equal(p.hours, 8);
  });

  it('summarises actual vs scheduled hours, and computes weekly overtime', async () => {
    const from = iso(ctx.monday), to = iso(addDays(ctx.monday, 6));
    const sum = await call(admin, 'GET', `/attendance/summary?from=${from}&to=${to}`);
    assert.equal(sum.status, 200, sum.text);
    const mine = sum.json.days.filter((d: any) => d.employeeId === ctx.emp.id);
    assert.equal(mine.length, 5, 'five days with punches');
    for (const d of mine) { assert.equal(d.actualHours, 9); assert.equal(d.scheduledHours, 0); assert.equal(d.status, 'UNSCHEDULED'); }
    const week = sum.json.weeks.find((w: any) => w.employeeId === ctx.emp.id && w.weekStart === from);
    assert.ok(week, JSON.stringify(sum.json.weeks));
    assert.equal(week.actualHours, 45);                 // 5 * 9h
    assert.equal(week.overtimeHours, 5);                // 45 - 40h contract
  });

  it('exports a payroll CSV whose overtime column adds back up to the weekly figure', async () => {
    const from = iso(ctx.monday), to = iso(addDays(ctx.monday, 6));
    const r = await call(admin, 'GET', `/attendance/payroll-export.csv?from=${from}&to=${to}`);
    assert.equal(r.status, 200, r.text);
    const lines = r.text.trim().split('\n');
    assert.equal(lines[0], 'employee_number,name,day,scheduled_hours,actual_hours,regular_hours,overtime_hours,status');
    const mine = lines.slice(1).filter((l) => l.startsWith(`AT${RUN},`));
    assert.equal(mine.length, 5);
    const otSum = mine.reduce((s, l) => s + Number(l.split(',')[6]), 0);
    assert.ok(Math.abs(otSum - 5) < 0.2, `overtime should apportion back to ~5h across the week, got ${otSum}`);
  });

  it('lets a manager add and remove a punch by hand', async () => {
    const day = iso(addDays(ctx.monday, 14));
    const add = await call(admin, 'POST', '/attendance/punches', { employeeId: ctx.emp.id, day, clockIn: `${day}T08:00:00Z`, clockOut: `${day}T12:00:00Z`, note: 'forgot to badge in the afternoon' });
    assert.equal(add.status, 201, add.text);
    assert.equal(add.json.hours, 4);
    assert.equal((await call(admin, 'DELETE', `/attendance/punches/${add.json.id}`)).status, 200);
  });
});
