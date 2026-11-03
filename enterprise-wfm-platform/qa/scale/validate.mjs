#!/usr/bin/env node
/**
 * Independent check of every scale schedule against each person's own rules (does not trust the solver's stats).
 *   $env:QA_ADMIN_PASSWORD='...'; node qa/scale/validate.mjs [S01,S02]
 * Writes one row per group to <tmp>/wfm-qa/scale/results.jsonl (phase "validate").
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SCENARIOS, WEEK_FROM } from './scenarios.mjs';

const BASE = process.env.QA_API ?? 'http://localhost:4000';
const OUT = path.join(process.env.QA_OUT ?? path.join(os.tmpdir(), 'wfm-qa'), 'scale');
const ONLY = process.argv[2]?.split(',');
const log = (row) => { fs.appendFileSync(path.join(OUT, 'results.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n'); console.log(JSON.stringify(row).slice(0, 600)); };
async function call(token, m, p) {
  const t0 = performance.now();
  const r = await fetch(`${BASE}/api/v1${p}`, { method: m, signal: AbortSignal.timeout(300_000), headers: { Authorization: `Bearer ${token}` } });
  const txt = await r.text(); if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${txt.slice(0, 200)}`);
  return Object.assign(JSON.parse(txt), { __ms: Math.round(performance.now() - t0), __kb: Math.round(txt.length / 1024) });
}
const tok = (await (await fetch(`${BASE}/api/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: process.env.QA_ADMIN_PASSWORD, tenant: 'ORG' }) })).json()).token;
const pickV = (list, k) => (Array.isArray(list) ? list : []).filter((x) => x.name?.startsWith(`SCALE ${k} ${process.env.QA_SCHED_TAG ?? 'schedule'}`)).sort((a, b) => String(b.createdAt ?? b.created_at ?? '').localeCompare(String(a.createdAt ?? a.created_at ?? '')))[0];
const dayNum = (d) => Date.parse(d + 'T00:00:00Z') / 864e5;
const dow = (d) => (new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7;      // 0 = Monday

const groups = Object.fromEntries((await call(tok, 'GET', '/config/groups')).map((g) => [g.name, g]));
const timeOff = await call(tok, 'GET', '/workforce/time-off');
const leave = new Map();       // employeeId -> Set(day)
for (const r of (Array.isArray(timeOff) ? timeOff : timeOff.requests ?? [])) if (r.status === 'APPROVED') for (let d = r.startDate; d <= r.endDate; d = new Date(dayNum(d) * 864e5 + 864e5).toISOString().slice(0, 10)) (leave.get(r.employeeId) ?? leave.set(r.employeeId, new Set()).get(r.employeeId)).add(d);
const avail = await call(tok, 'GET', '/workforce/availability');
const unavailable = new Map();
for (const a of avail) if (a.kind === 'UNAVAILABLE') (unavailable.get(a.employeeId) ?? unavailable.set(a.employeeId, []).get(a.employeeId)).push(a);
const slot = (hhmm) => (hhmm === '24:00' ? 96 : Number(hhmm.slice(0, 2)) * 4 + Number(hhmm.slice(3, 5)) / 15);

for (const s of SCENARIOS.filter((x) => !ONLY || ONLY.includes(x.key))) {
  const g = groups[`SCALE ${s.key} ${s.name}`];
  if (!g) { log({ phase: 'validate', key: s.key, error: 'group missing' }); continue; }
  const v = pickV(await call(tok, 'GET', `/scheduling/versions?groupId=${g.id}`), s.key);
  if (!v) { log({ phase: 'validate', key: s.key, error: 'no schedule version' }); continue; }
  const people = []; for (let k = 0; k * 1000 <= s.size; k++) people.push(...(await call(tok, 'GET', `/workforce/employees?q=${s.key}-0${k}`)));
  const emp = new Map(people.map((e) => [e.id, e]));
  const shifts = await call(tok, 'GET', `/scheduling/versions/${v.id}/shifts`);
  const firstWeekEnd = new Date(dayNum(WEEK_FROM) * 864e5 + 7 * 864e5).toISOString().slice(0, 10);
  const byEmp = new Map();
  for (const sh of shifts) (byEmp.get(sh.employeeId) ?? byEmp.set(sh.employeeId, []).get(sh.employeeId)).push(sh);
  const v_ = { overlap: [], rest: [], weeklyMax: [], daysPerWeek: [], consecutive: [], onLeave: [], unavailable: [], weekend: [], night: [], outsideGroup: [], length: [] };
  const hoursWeek1 = []; let ftHours = [], ptHours = [], zero = 0;
  for (const [id, list] of byEmp) {
    const e = emp.get(id);
    if (!e) { v_.outsideGroup.push(id); continue; }
    list.sort((a, b) => (a.day === b.day ? a.startSlot - b.startSlot : a.day < b.day ? -1 : 1));
    const abs = (x) => dayNum(x.day) * 96 + x.startSlot;
    const minRest = (e.minRestHours ?? 11) * 4, maxRun = e.maxConsecutiveDays ?? 6;
    let run = 1;
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      if (x.lengthSlots < 16 || x.lengthSlots > 52) v_.length.push(`${e.employeeNumber} ${x.day} ${x.lengthSlots / 4}h`);
      if (i) {
        const p = list[i - 1], gap = abs(x) - (abs(p) + p.lengthSlots);
        if (gap < 0) v_.overlap.push(`${e.employeeNumber} ${p.day}/${x.day}`);
        else if (gap < minRest) v_.rest.push(`${e.employeeNumber} ${p.day}->${x.day} ${gap / 4}h`);
        const dd = dayNum(x.day) - dayNum(p.day); run = dd === 1 ? run + 1 : dd === 0 ? run : 1;
        if (run > maxRun) v_.consecutive.push(`${e.employeeNumber} ${x.day} run ${run}`);
      }
      if (leave.get(id)?.has(x.day)) v_.onLeave.push(`${e.employeeNumber} ${x.day}`);
      if (e.allowWeekend === false && dow(x.day) >= 5) v_.weekend.push(`${e.employeeNumber} ${x.day}`);
      const end = x.startSlot + x.lengthSlots;
      if (end > 96 && !(e.allowOvernight && e.nightShiftConsent !== false)) v_.night.push(`${e.employeeNumber} ${x.day} ends ${(end - 96) / 4}h after midnight`);
      for (const u of unavailable.get(id) ?? []) if (u.dayOfWeek === dow(x.day) && x.startSlot < slot(u.endTime) && end > slot(u.startTime)) v_.unavailable.push(`${e.employeeNumber} ${x.day} ${u.startTime}-${u.endTime}`);
    }
    // weekly limits (pay weeks from Monday)
    const weeks = new Map();
    for (const x of list) { const w = Math.floor((dayNum(x.day) - dayNum(WEEK_FROM)) / 7); const o = weeks.get(w) ?? { h: 0, d: new Set() }; o.h += (x.paidHours ?? (x.lengthSlots / 4 - 0.5)); o.d.add(x.day); weeks.set(w, o); }
    for (const [w, o] of weeks) {
      if (o.h > (e.maxWeeklyHours ?? 48) + 0.01) v_.weeklyMax.push(`${e.employeeNumber} wk${w} ${o.h}h > ${e.maxWeeklyHours}`);
      if (o.d.size > (e.workDaysPerWeek ?? 5)) v_.daysPerWeek.push(`${e.employeeNumber} wk${w} ${o.d.size} days > ${e.workDaysPerWeek}`);
    }
    const w0 = weeks.get(0)?.h ?? 0; hoursWeek1.push(w0);
    (e.employmentType === 'PART_TIME' ? ptHours : ftHours).push(w0);
  }
  for (const e of people) if (!byEmp.has(e.id)) zero++;
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const counts = Object.fromEntries(Object.entries(v_).map(([k, a]) => [k, a.length]));
  log({
    phase: 'validate', key: s.key, versionId: v.id, people: people.length, shifts: shifts.length, shiftsKb: shifts.__kb, shiftsMs: shifts.__ms,
    peopleWithShifts: byEmp.size, peopleWithoutShifts: zero, avgWeek1HoursFT: avg(ftHours), avgWeek1HoursPT: avg(ptHours),
    firstDay: shifts.reduce((m, x) => (x.day < m ? x.day : m), '9999'), lastDay: shifts.reduce((m, x) => (x.day > m ? x.day : m), '0000'),
    violations: counts, totalViolations: Object.values(counts).reduce((a, b) => a + b, 0), examples: Object.fromEntries(Object.entries(v_).filter(([, a]) => a.length).map(([k, a]) => [k, a.slice(0, 3)])),
    leavePeople: people.filter((e) => leave.has(e.id)).length, unavailablePeople: people.filter((e) => unavailable.has(e.id)).length,
    nightConsent: people.filter((e) => e.allowOvernight && e.nightShiftConsent).length, noWeekendPeople: people.filter((e) => e.allowWeekend === false).length,
  });
}
