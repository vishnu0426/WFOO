/**
 * The live figures on the Today page, recomputed from scratch and compared: a real forecast, a real published schedule with meals, and the coverage the page reports checked against a
 * count made here with no shared code. Needs a running gateway and engine:
 *   BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test --test-force-exit test/overviewLive.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || '';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('Today: live figures match an independent count', { skip: !BASE || !PASSWORD }, () => {
  let admin = '', group: any, day = '', sched: any;
  before(async () => {
    admin = (await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT })).json.token;
    group = (await call(admin, 'POST', '/config/groups', { name: `Live ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30 })).json;
    assert.ok(group.id, JSON.stringify(group));
    assert.equal((await call(admin, 'POST', '/config/queues', { name: `LiveQ ${RUN}`, channel: 'VOICE', ahtDefault: 300, wfmGroupId: group.id })).status, 201);
    // twelve weeks of history ending yesterday
    const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const rows = ['queue,date,interval,volume,aht'];
    for (let n = 84; n >= 1; n--) { const d = new Date(today); d.setDate(d.getDate() - n); const f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
      for (let s = 0; s < 96; s++) rows.push(`LiveQ ${RUN},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.round((curve[Math.floor(s / 4)] * f * 0.6) / 4)},300`); }
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: rows.join('\n') });
    assert.equal(up.status, 201, up.text);
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const fc = await call(admin, 'POST', '/forecast/versions', { groupId: group.id, kind: 'SHORT', weeks: 2 });
    assert.equal(fc.status, 201, fc.text);
    assert.equal((await call(admin, 'POST', `/forecast/versions/${fc.json.id}/submit`)).status, 200);
    assert.equal((await call(admin, 'POST', `/forecast/versions/${fc.json.id}/approve`)).status, 200);
    assert.equal((await call(admin, 'POST', `/forecast/versions/${fc.json.id}/publish`)).status, 200);
    const tmpl = await call(admin, 'POST', '/scheduling/templates', { name: `LT${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], breakCount: 0, breakMinutes: 15, flexMinutes: 0, earliestStart: '07:00', latestStart: '15:00', durationHours: 9, mealMinutes: 60 });
    for (let i = 1; i <= 14; i++) await call(admin, 'POST', '/workforce/employees', { employeeNumber: `LV${RUN}-${i}`, firstName: `L${i}`, lastName: 'Person', primaryGroupId: group.id, weeklyContractHours: 40, maxWeeklyHours: 48 });
    const from = iso(today);
    sched = await call(admin, 'POST', '/scheduling/versions', { groupId: group.id, from, weeks: 1, timeLimitSec: 20, coverageSource: 'FORECAST', templateIds: [tmpl.json.id], useHistory: false });
    assert.equal(sched.status, 201, sched.text);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${sched.json.id}/publish`, {})).status, 200);
    day = from;
  });

  it('counts people scheduled without their meals, and reports coverage as people-time met over people-time needed', async () => {
    const cov = await call(admin, 'GET', `/intraday/coverage?groupId=${group.id}&day=${day}`);
    assert.equal(cov.status, 200, cov.text);
    assert.equal(cov.json.ready, true, cov.text);
    // an independent count of the people scheduled in each quarter hour, from the shifts as saved: on shift, less the meal
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${sched.json.id}/shifts`)).json as any[];
    const mine = new Array(96).fill(0);
    let sawMeal = false;
    for (const s of shifts.filter((x) => x.day === day)) {
      for (let k = s.startSlot; k < Math.min(96, s.startSlot + s.lengthSlots); k++) {
        const eating = (s.activities ?? []).some((a: any) => a.type === 'MEAL' && k >= a.startSlot && k < a.startSlot + a.slots);
        sawMeal ||= eating;
        if (!eating) mine[k]++;
      }
    }
    assert.ok(sawMeal, 'the scenario has meals to leave out');
    for (const s of cov.json.slots) assert.equal(s.scheduled, mine[s.slot], `people scheduled at ${s.time}`);
    // coverage: sum of min(scheduled, needed) over sum of needed, over the quarter hours that need people
    let need = 0, met = 0, short = 0, over = 0;
    for (const s of cov.json.slots) { const r = s.requiredReforecast ?? s.required; need += r; met += Math.min(r, s.scheduled); short += Math.max(0, r - s.scheduled); over += Math.max(0, s.scheduled - r); }
    const slots = cov.json.slots as any[];
    const rq = (s: any) => s.required; // the page uses the planned requirement for the day figures
    const needP = slots.reduce((t, s) => t + rq(s), 0), metP = slots.reduce((t, s) => t + Math.min(rq(s), s.scheduled), 0);
    assert.ok(needP > 0);
    assert.ok(Math.abs(cov.json.stats.coveragePercent - Math.round((1000 * metP) / needP) / 10) <= 0.1, `${cov.json.stats.coveragePercent} vs ${Math.round((1000 * metP) / needP) / 10}`);
    assert.ok(Math.abs(cov.json.stats.requiredHours - Math.round((needP / 4) * 10) / 10) <= 0.1);
    assert.ok(Math.abs(cov.json.stats.scheduledHours - Math.round((slots.reduce((t, s) => t + s.scheduled, 0) / 4) * 10) / 10) <= 0.1);
    assert.ok(need >= 0 && met >= 0 && short >= 0 && over >= 0);
  });

  it('weights the service level by contacts, not by interval', async () => {
    const cov = (await call(admin, 'GET', `/intraday/coverage?groupId=${group.id}&day=${day}`)).json;
    const slots = (cov.slots as any[]).filter((s) => s.serviceLevel !== null && s.forecast > 0);
    const w = slots.reduce((t, s) => t + s.forecast, 0);
    const expected = slots.reduce((t, s) => t + s.serviceLevel * s.forecast, 0) / w;
    assert.ok(Math.abs(cov.stats.serviceLevel - expected) < 0.01, `${cov.stats.serviceLevel} vs ${expected}`);
  });

  it('shows the same coverage on the Today page as on live coverage, with the day figures it comes from', async () => {
    const t = (await call(admin, 'GET', `/overview/today?groupId=${group.id}`)).json;
    const cov = (await call(admin, 'GET', `/intraday/coverage?groupId=${group.id}`)).json;
    const k = t.kpis.find((x: any) => x.key === 'coverage');
    assert.equal(k.value, cov.stats.coveragePercent);
    assert.equal(t.dayTotals.requiredHours, cov.stats.requiredHours);
    assert.ok(t.chart.length > 0 && t.chart.every((c: any) => typeof c.required === 'number' && typeof c.scheduled === 'number'));
    assert.ok(t.verdict.checked.includes("today's live coverage"));
  });
});
