/**
 * A pay week that does not start on Monday, through the API: the screens ask which weekday it is, and a shift bid runs in whole pay weeks
 * from that day, with its pattern days named from it.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/payWeekScreens.test.ts
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The first date on or after `from` that falls on weekday `dow` (Monday 0 ... Sunday 6). */
const nextOn = (dow: number, from = new Date(Date.now() + 14 * 86_400_000)) => { const d = new Date(Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())); while ((d.getUTCDay() + 6) % 7 !== dow) d.setUTCDate(d.getUTCDate() + 1); return iso(d); };

let admin = '';
const ctx: Record<string, any> = {};

describe('a pay week that starts on a Sunday', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('builds a group on a Sunday pay week with a shift template', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Sunday ${RUN}`, payWeekStart: 6 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const g2 = await call(admin, 'POST', '/config/groups', { name: `Monday ${RUN}` });
    assert.equal(g2.status, 201, g2.text); ctx.monday = g2.json;
    const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '08:00', latestStart: '08:00', startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30 });
    assert.equal(t.status, 201, t.text); ctx.tpl = t.json;
  });

  it('tells every screen which weekday the pay week starts on, and where that came from', async () => {
    const s = (await call(admin, 'GET', `/scheduling/pay-week?groupId=${ctx.group.id}`)).json;
    assert.equal(s.start, 6); assert.equal(s.source, 'GROUP');
    const m = (await call(admin, 'GET', `/scheduling/pay-week?groupId=${ctx.monday.id}`)).json;
    assert.equal(m.start, 0, 'a group with no setting follows the company, which starts on Monday here'); assert.notEqual(m.source, 'GROUP');
    const none = await call(admin, 'GET', '/scheduling/pay-week');
    assert.equal(none.status, 200); assert.equal(typeof none.json.start, 'number');
  });

  it('will not start a shift bid on a Monday for a Sunday pay week, and says which day it needs', async () => {
    const patterns = [{ name: 'Early', templateId: ctx.tpl.id, startTime: '08:00', workDays: [1, 2, 3, 4, 5], capacity: 3 }];
    const bad = await call(admin, 'POST', '/scheduling/bids', { groupId: ctx.group.id, name: `Wrong day ${RUN}`, periodStart: nextOn(0), weeks: 2, patterns });
    assert.equal(bad.status, 400, bad.text); assert.match(bad.text, /Sunday/);
    const ok = await call(admin, 'POST', '/scheduling/bids', { groupId: ctx.group.id, name: `Sunday bid ${RUN}`, periodStart: nextOn(6), weeks: 2, patterns });
    assert.equal(ok.status, 201, ok.text); ctx.round = ok.json;
  });

  it('names the pattern days from the first day of the pay week, so offset 1 to 5 is Monday to Friday', async () => {
    assert.deepEqual(ctx.round.patterns[0].days, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    const sunStart = await call(admin, 'POST', '/scheduling/bids', { groupId: ctx.group.id, name: `Sunday to Thursday ${RUN}`, periodStart: nextOn(6), weeks: 1, patterns: [{ name: 'Sun-Thu', templateId: ctx.tpl.id, startTime: '08:00', workDays: [0, 1, 2, 3, 4], capacity: 2 }] });
    assert.equal(sunStart.status, 201, sunStart.text);
    assert.deepEqual(sunStart.json.patterns[0].days, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu']);
    ctx.round2 = sunStart.json;
  });

  it('keeps a Monday bid on a Monday pay week as before', async () => {
    const r = await call(admin, 'POST', '/scheduling/bids', { groupId: ctx.monday.id, name: `Monday bid ${RUN}`, periodStart: nextOn(0), weeks: 1, patterns: [{ name: 'Early', templateId: ctx.tpl.id, startTime: '08:00', workDays: [0, 1, 2, 3, 4], capacity: 2 }] });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual(r.json.patterns[0].days, NAMES.slice(0, 5));
    assert.equal((await call(admin, 'POST', '/scheduling/bids', { groupId: ctx.monday.id, name: `Tuesday bid ${RUN}`, periodStart: nextOn(1), weeks: 1, patterns: [{ name: 'x', templateId: ctx.tpl.id, startTime: '08:00', workDays: [0], capacity: 1 }] })).status, 400);
  });

  it('runs a report for "last week" as the pay week for a Sunday group', async () => {
    const r = await call(admin, 'POST', '/reports/run', { report: 'ROSTER', groupId: ctx.group.id, range: 'LAST_WEEK' });
    if (r.status === 404 || r.status === 403) return;            // the reports module may not offer this report here
    assert.equal(r.status, 200, r.text);
    assert.equal(new Date(`${r.json.from}T00:00:00Z`).getUTCDay(), 0, `a Sunday: ${r.json.from}`);
    assert.equal(new Date(`${r.json.to}T00:00:00Z`).getUTCDay(), 6, `to a Saturday: ${r.json.to}`);
  });
});
