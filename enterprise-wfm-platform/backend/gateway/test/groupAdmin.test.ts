/**
 * WFM group administration end to end: sites, reasons for changes that move staffing numbers, the warning before a group with a running schedule is
 * switched off, deleting, queue aliases that imports honour, people with search and paging, history, cloning and creating groups from a file.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/groupAdmin.test.ts
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
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text, message: json?.error?.message as string | undefined };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

const ctx: Record<string, any> = {};
let admin = '';

describe('WFM group administration', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); assert.equal(r.status, 200, r.text); admin = r.json.token; });

  describe('creating and editing', () => {
    it('creates a group at a site, and refuses a repeated name or a bad time zone in plain words', async () => {
      const site = await call(admin, 'POST', '/config/sites', { name: `Chennai ${RUN}`, timezone: 'Asia/Kolkata', country: 'India' });
      assert.equal(site.status, 201, site.text); ctx.site = site.json;
      const g = await call(admin, 'POST', '/config/groups', { name: `Support ${RUN}`, description: 'Tier 1', siteId: ctx.site.id, timezone: 'Asia/Kolkata' });
      assert.equal(g.status, 201, g.text); ctx.g = g.json;
      assert.equal(g.json.siteId, ctx.site.id);
      const dup = await call(admin, 'POST', '/config/groups', { name: `support ${RUN}` });
      assert.equal(dup.status, 409, dup.text); assert.match(dup.message!, /already exists/);
      const tz = await call(admin, 'POST', '/config/groups', { name: `Bad zone ${RUN}`, timezone: 'Mars/Base' });
      assert.equal(tz.status, 400, tz.text); assert.match(tz.message!, /not a time zone/);
      assert.equal((await call(admin, 'POST', '/config/groups', { name: `No site ${RUN}`, siteId: '00000000-0000-4000-8000-000000000000' })).status, 400);
    });

    it('asks why when a change moves staffing or pay numbers, and keeps the reason', async () => {
      const no = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { serviceLevelGoal: 90 });
      assert.equal(no.status, 400, no.text); assert.match(no.message!, /service level goal/);
      const noPay = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { payWeekStart: 6, reason: 'ab' });
      assert.equal(noPay.status, 400, 'two letters is not a reason');
      const ok = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { serviceLevelGoal: 90, payWeekStart: 6, reason: 'New contract asks for 90/20' });
      assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.serviceLevelGoal, 90); assert.equal(ok.json.payWeekStart, 6);
      const same = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { serviceLevelGoal: 90, description: 'Tier 1 and 2' });
      assert.equal(same.status, 200, 'sending the same number back, with a harmless change, needs no reason'); assert.equal(same.json.description, 'Tier 1 and 2');
      const rename = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { name: `Support desk ${RUN}`, siteId: null });
      assert.equal(rename.status, 200, rename.text); assert.equal(rename.json.siteId, null, 'a group can be taken off its site');
      assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { siteId: ctx.site.id })).json.siteId, ctx.site.id);
    });

    it('will not rename a group to a name that is taken', async () => {
      const other = await call(admin, 'POST', '/config/groups', { name: `Other ${RUN}` }); assert.equal(other.status, 201, other.text);
      const r = await call(admin, 'PUT', `/config/groups/${other.json.id}`, { name: `SUPPORT DESK ${RUN}` });
      assert.equal(r.status, 409, r.text); assert.match(r.message!, /already exists/);
      ctx.other = other.json;
    });

    it('shows who changed what, with the reason, in the history', async () => {
      const h = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/history`)).json;
      assert.ok(h.length >= 3);
      const change = h.find((x: any) => x.reason === 'New contract asks for 90/20');
      assert.ok(change, JSON.stringify(h.map((x: any) => x.reason)));
      assert.equal(change.actor, 'Administrator');
      assert.ok(change.changes.some((c: any) => c.field === 'serviceLevelGoal' && c.from === 80 && c.to === 90), JSON.stringify(change.changes));
      assert.match(change.summary, /service level goal/);
    });
  });

  describe('queues and aliases', () => {
    it('gives a queue other names, and refuses a name another queue already answers to', async () => {
      const q = await call(admin, 'POST', '/config/queues', { name: `Voice ${RUN}`, channel: 'VOICE', wfmGroupId: ctx.g.id, aliases: [`TS_VOICE_${RUN}`, ` ts_voice_${RUN} `, `Tech Support Voice ${RUN}`] });
      assert.equal(q.status, 201, q.text); ctx.q = q.json;
      assert.deepEqual(q.json.aliases, [`TS_VOICE_${RUN}`, `Tech Support Voice ${RUN}`], 'repeats and spaces are tidied');
      const clash = await call(admin, 'POST', '/config/queues', { name: `Chat ${RUN}`, channel: 'CHAT', wfmGroupId: ctx.g.id, aliases: [`ts_voice_${RUN}`] });
      assert.equal(clash.status, 409, clash.text); assert.match(clash.message!, new RegExp(`Voice ${RUN}`));
      const asName = await call(admin, 'POST', '/config/queues', { name: `TS_VOICE_${RUN}`, channel: 'VOICE', wfmGroupId: ctx.g.id });
      assert.equal(asName.status, 409, asName.text);   // a queue cannot be named like another queue's alias
      const dupName = await call(admin, 'POST', '/config/queues', { name: `voice ${RUN}`, channel: 'VOICE', wfmGroupId: ctx.g.id });
      assert.equal(dupName.status, 409, dupName.text); assert.match(dupName.message!, /already exists/);
      const chat = await call(admin, 'POST', '/config/queues', { name: `Chat ${RUN}`, channel: 'CHAT', wfmGroupId: ctx.g.id });
      assert.equal(chat.status, 201, chat.text); ctx.chat = chat.json;
      const ed = await call(admin, 'PUT', `/config/queues/${ctx.chat.id}`, { aliases: [`Voice ${RUN}`] });
      assert.equal(ed.status, 409, ed.text);
      assert.deepEqual((await call(admin, 'PUT', `/config/queues/${ctx.chat.id}`, { aliases: [`Live chat ${RUN}`] })).json.aliases, [`Live chat ${RUN}`]);
      assert.deepEqual((await call(admin, 'PUT', `/config/queues/${ctx.chat.id}`, { name: `Chat ${RUN} 2` })).json.aliases, [`Live chat ${RUN}`], 'editing something else keeps them');
    });

    it('lands an imported row on the queue its alias names, and says how to fix an unknown name', async () => {
      const day = iso(addDays(new Date(), -3));
      const rows = ['queue,date,interval,volume,aht'];
      for (let s = 0; s < 4; s++) { const t = `0${8 + Math.floor(s / 4)}:${String((s % 4) * 15).padStart(2, '0')}`; rows.push(`TS_VOICE_${RUN},${day},${t},10,300`); rows.push(`Nowhere ${RUN},${day},${t},5,300`); }
      const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'alias.csv', csv: rows.join('\n') });
      assert.equal(up.status, 201, up.text);
      const detail = (await call(admin, 'GET', `/data/imports/${up.json.id}`)).json;
      const unknown = detail.errors.filter((e: any) => /Unknown queue/.test(e.message));
      assert.equal(unknown.length, 4, 'only the made-up name is rejected');
      assert.ok(unknown.every((e: any) => /alias/.test(e.message)), 'the message says how to fix it');
      assert.equal(detail.validRows ?? detail.rowsOk ?? 4, 4);
    });
  });

  describe('people with search and paging', () => {
    it('lists a group\'s people a page at a time, with search and team counts', async () => {
      const t = await call(admin, 'POST', '/workforce/teams', { name: `Alpha ${RUN}` }); assert.equal(t.status, 201, t.text);
      const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
      for (let i = 1; i <= 7; i++) lines.push(`GA${RUN}-${i},Pat${i},Lee${String.fromCharCode(96 + i)},${i <= 4 ? `Alpha ${RUN}` : ''},Support desk ${RUN},FULL_TIME,40,5`);
      const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
      assert.equal(imp.json.committed, true, imp.text);
      const page1 = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?limit=3&offset=0`)).json;
      assert.equal(page1.total, 7); assert.equal(page1.items.length, 3);
      const page3 = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?limit=3&offset=6`)).json;
      assert.equal(page3.items.length, 1);
      assert.deepEqual([...page1.items, ...(await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?limit=3&offset=3`)).json.items, ...page3.items].map((x: any) => x.name).length, 7);
      const found = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?q=pat5`)).json;
      assert.equal(found.total, 1); assert.equal(found.items[0].name, 'Pat5 Leee'); assert.equal(found.items[0].primary, true);
      const alpha = page1.teams.find((x: any) => x.name === `Alpha ${RUN}`);
      assert.equal(alpha.count, 4);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?teamId=${alpha.id}`)).json.total, 4);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?teamId=none`)).json.total, 3);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?q=zzzz`)).json.total, 0);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?limit=500`)).status, 400);
    });

    it('adds whole teams and named people in one request, and says what it did', async () => {
      const g = await call(admin, 'POST', '/config/groups', { name: `Bulk ${RUN}` }); assert.equal(g.status, 201, g.text);
      const team = (await call(admin, 'GET', `/workforce/teams?q=Alpha%20${RUN}`)).json.find((t: any) => t.name === `Alpha ${RUN}`);
      const lone = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?q=pat6`)).json.items[0];
      assert.equal((await call(admin, 'POST', `/config/groups/${g.json.id}/members`, {})).status, 400, 'something has to be chosen');
      const first = await call(admin, 'POST', `/config/groups/${g.json.id}/members`, { teamIds: [team.id], employeeIds: [lone.id] });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.added, 5, 'four in the team plus one named person'); assert.equal(first.json.alreadyIn, 0);
      const again = await call(admin, 'POST', `/config/groups/${g.json.id}/members`, { teamIds: [team.id] });
      assert.deepEqual([again.json.added, again.json.alreadyIn], [0, 4], 'a second run adds nobody twice');
      const list = (await call(admin, 'GET', `/config/groups/${g.json.id}/members`)).json;
      assert.equal(list.total, 5);
      assert.ok(list.items.every((m: any) => m.primary === false), 'they already had a primary group, so this one is only added as an extra');
      const keep = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?q=pat6`)).json.items[0];
      assert.equal(keep.primary, true, 'someone\'s existing primary group is not taken from them');
      assert.equal((await call(admin, 'POST', `/config/groups/00000000-0000-4000-8000-000000000000/members`, { teamIds: [team.id] })).status, 404);
      ctx.bulk = g.json;
    });

    it('a person who left is not counted', async () => {
      const one = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/members?q=pat7`)).json.items[0];
      assert.equal((await call(admin, 'PUT', `/workforce/employees/${one.id}`, { reason: 'Resigned', status: 'TERMINATED', terminationDate: new Date().toISOString().slice(0, 10), terminationReason: 'Resigned' })).status, 200);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.g.id}/members`)).json.total, 6);
    });
  });

  describe('the list summary', () => {
    it('gives every group\'s numbers in one request', async () => {
      const s = (await call(admin, 'GET', '/config/groups/summary')).json;
      assert.equal(s[ctx.g.id].queues, 2); assert.equal(s[ctx.g.id].people, 6); assert.equal(s[ctx.g.id].primaryPeople, 6);
      assert.equal(s[ctx.g.id].forecast, null); assert.equal(s[ctx.g.id].schedule, null);
      assert.equal(s[ctx.other.id].queues, 0); assert.equal(s[ctx.other.id].people, 0);
    });
  });

  describe('switching a group off and deleting it', () => {
    it('warns before a group with a running published schedule is switched off', async () => {
      const t = await call(admin, 'POST', '/scheduling/templates', { name: `Day ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '09:00', latestStart: '09:00', durationHours: 8, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 15 });
      assert.equal(t.status, 201, t.text);
      for (let d = 0; d < 7; d++) assert.equal((await call(admin, 'POST', `/config/groups/${ctx.g.id}/coverage-windows`, { dayOfWeek: d, startTime: '09:00', endTime: '17:00', headcount: 1 })).status, 201);
      const from = iso(addDays(new Date(), 8));
      const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.g.id, from, weeks: 1, timeLimitSec: 30, coverageSource: 'MANUAL', templateIds: [t.json.id] });
      assert.equal(v.status, 201, v.text);
      const pub = await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`);
      assert.equal(pub.status, 200, pub.text);
      const impact = (await call(admin, 'GET', `/config/groups/${ctx.g.id}/impact`)).json;
      assert.equal(impact.publishedSchedules, 1); assert.equal(impact.queues, 2); assert.equal(impact.people, 6); assert.ok(impact.rotationPatterns === 0);
      const noReason = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { status: 'INACTIVE' });
      assert.equal(noReason.status, 400, noReason.text); assert.match(noReason.message!, /status/);
      const warn = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { status: 'INACTIVE', reason: 'Closing the desk' });
      assert.equal(warn.status, 409, warn.text); assert.match(warn.message!, /1 published schedule/);
      const done = await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { status: 'INACTIVE', reason: 'Closing the desk', acknowledge: true });
      assert.equal(done.status, 200, done.text); assert.equal(done.json.status, 'INACTIVE');
      assert.equal((await call(admin, 'PUT', `/config/groups/${ctx.g.id}`, { status: 'ACTIVE', reason: 'Desk reopened' })).json.status, 'ACTIVE');
    });

    it('deletes only a group nothing was built on, and needs a reason', async () => {
      const used = await call(admin, 'DELETE', `/config/groups/${ctx.g.id}?reason=${encodeURIComponent('Tidy up')}`);
      assert.equal(used.status, 409, used.text); assert.match(used.message!, /2 queues/); assert.match(used.message!, /Switch it off instead/);
      assert.equal((await call(admin, 'DELETE', `/config/groups/${ctx.other.id}`)).status, 400, 'a reason is mandatory');
      assert.equal((await call(admin, 'DELETE', `/config/groups/${ctx.other.id}?reason=${encodeURIComponent('Created by mistake')}`)).status, 200);
      assert.equal((await call(admin, 'GET', `/config/groups/${ctx.other.id}`)).status, 404);
    });
  });

  describe('cloning', () => {
    it('copies the targets, shrinkage, coverage and queues of a group', async () => {
      await call(admin, 'POST', `/config/groups/${ctx.g.id}/shrinkage-categories`, { name: 'Training', pct: 5 });
      const c = await call(admin, 'POST', `/config/groups/${ctx.g.id}/clone`, { name: `Support copy ${RUN}` });
      assert.equal(c.status, 201, c.text);
      assert.equal(c.json.serviceLevelGoal, 90); assert.equal(c.json.payWeekStart, 6); assert.equal(c.json.siteId, ctx.site.id); assert.equal(c.json.copiedQueues, 2);
      const cats = (await call(admin, 'GET', `/config/groups/${c.json.id}/shrinkage-categories`)).json;
      assert.deepEqual(cats.map((x: any) => x.name), ['Training']);
      assert.equal((await call(admin, 'GET', `/config/groups/${c.json.id}/coverage-windows`)).json.length, 7);
      const queues = (await call(admin, 'GET', '/config/queues')).json.filter((q: any) => q.wfmGroupId === c.json.id);
      assert.equal(queues.length, 2); assert.ok(queues.every((q: any) => q.name.includes(`Support copy ${RUN}`) && q.aliases.length === 0), 'copies get their own names and no aliases');
      assert.equal((await call(admin, 'GET', `/config/groups/${c.json.id}/members`)).json.total, 0, 'people are not copied');
      assert.equal((await call(admin, 'POST', `/config/groups/${ctx.g.id}/clone`, { name: `support copy ${RUN}` })).status, 409);
      const bare = await call(admin, 'POST', `/config/groups/${ctx.g.id}/clone`, { name: `Bare copy ${RUN}`, queues: false, shrinkage: false, coverage: false });
      assert.equal(bare.json.copiedQueues, 0);
      assert.equal((await call(admin, 'GET', `/config/groups/${bare.json.id}/coverage-windows`)).json.length, 0);
    });
  });

  describe('creating groups from a file', () => {
    const file = (rows: string[]) => ['group,description,site,timezone,service_level_goal,answer_seconds,shrinkage_percent,occupancy_cap,queue,channel,handle_time_sec,queue_aliases', ...rows].join('\n');
    it('serves a template that reads back without errors', async () => {
      const r = await fetch(`${BASE}/api/v1/config/groups/import-template`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(r.status, 200); const text = await r.text();
      assert.match(text, /^group,description,site/);
      const dry = await call(admin, 'POST', '/config/groups/import', { csv: text.replace('Chennai', `Chennai ${RUN}`).replace('Technical support', `Tech ${RUN}`).replace('Technical support', `Tech ${RUN}`).replace('TS_VOICE|Tech Support Voice', `TV_${RUN}|Support line ${RUN}`).replace('Tech voice', `Tech voice ${RUN}`).replace('Tech chat', `Tech chat ${RUN}`), dryRun: true });
      assert.equal(dry.status, 200, dry.text); assert.equal(dry.json.errorCount, 0, dry.text); assert.equal(dry.json.committed, false);
      assert.equal(dry.json.groups[0].queues, 2);
    });
    it('checks the whole file first and creates nothing when any row is wrong', async () => {
      const csv = file([`Fresh ${RUN},,Nowhere,,,,,,Fresh voice ${RUN},VOICE,300,`, `Support desk ${RUN},,,,,,,,Fresh two ${RUN},VOICE,300,`, `Third ${RUN},,,,,,,,Voice ${RUN},VOICE,300,`, `Fourth ${RUN},,,,,,,,Fresh four ${RUN},VOICE,300,TS_VOICE_${RUN}`]);
      const r = await call(admin, 'POST', '/config/groups/import', { csv, dryRun: false });
      assert.equal(r.status, 200, r.text); assert.equal(r.json.committed, false);
      const m = r.json.errors.map((e: any) => `${e.line}: ${e.message}`).join('\n');
      assert.match(m, /There is no site called "Nowhere"/); assert.match(m, /group named "Support desk .*" already exists/); assert.match(m, /"Voice .*" is already the name, code or alias of a queue/); assert.match(m, /"TS_VOICE_.*" is already the name, code or alias of a queue/);
      assert.ok(!(await call(admin, 'GET', '/config/groups')).json.some((g: any) => g.name === `Fresh ${RUN}`), 'nothing was created');
    });
    it('creates the groups and queues of a good file, at the right site', async () => {
      const csv = file([`Sales ${RUN},Inbound sales,Chennai ${RUN},,85,30,25,80,Sales voice ${RUN},VOICE,360,SALES_V_${RUN}|Sales line ${RUN}`, `Sales ${RUN},,,,,,,,Sales chat ${RUN},CHAT,500,`, `Billing ${RUN},Invoices,,Europe/London,,,,,,,,`]);
      const r = await call(admin, 'POST', '/config/groups/import', { csv, dryRun: false });
      assert.equal(r.status, 201, r.text); assert.equal(r.json.committed, true); assert.equal(r.json.groups.length, 2);
      const gs = (await call(admin, 'GET', '/config/groups')).json;
      const sales = gs.find((g: any) => g.name === `Sales ${RUN}`), billing = gs.find((g: any) => g.name === `Billing ${RUN}`);
      assert.equal(sales.serviceLevelGoal, 85); assert.equal(sales.serviceLevelThresholdSec, 30); assert.equal(sales.shrinkagePercent, 25); assert.equal(sales.targetOccupancy, 80); assert.equal(sales.siteId, ctx.site.id);
      assert.equal(sales.queueIds.length, 2); assert.equal(billing.timezone, 'Europe/London'); assert.equal(billing.queueIds.length, 0);
      const q = (await call(admin, 'GET', '/config/queues')).json.find((x: any) => x.name === `Sales voice ${RUN}`);
      assert.deepEqual(q.aliases, [`SALES_V_${RUN}`, `Sales line ${RUN}`]); assert.equal(q.ahtDefault, 360);
      const again = await call(admin, 'POST', '/config/groups/import', { csv, dryRun: false });
      assert.equal(again.json.committed, false); assert.ok(again.json.errorCount >= 2, 'a second run is refused, not doubled');
    });
  });

  describe('who may do it', () => {
    it('lets an analyst read but not change', async () => {
      const an = await call(admin, 'POST', '/users', { username: `ga${RUN}`, displayName: 'Ga', role: 'ANALYST', password: 'Passw0rd!Passw0rd' });
      assert.ok([201, 409].includes(an.status), an.text);
      const tok = (await call(null, 'POST', '/auth/login', { username: `ga${RUN}`, password: 'Passw0rd!Passw0rd', tenant: TENANT })).json.token;
      assert.equal((await call(tok, 'GET', '/config/groups/summary')).status, 200);
      assert.equal((await call(tok, 'GET', `/config/groups/${ctx.g.id}/members`)).status, 200);
      assert.equal((await call(tok, 'GET', `/config/groups/${ctx.g.id}/history`)).status, 200);
      assert.equal((await call(tok, 'POST', `/config/groups/${ctx.g.id}/clone`, { name: `Nope ${RUN}` })).status, 403);
      assert.equal((await call(tok, 'POST', '/config/groups/import', { csv: 'group\nX', dryRun: true })).status, 403);
      assert.equal((await call(tok, 'DELETE', `/config/groups/${ctx.g.id}?reason=abc`)).status, 403);
    });
  });
});
