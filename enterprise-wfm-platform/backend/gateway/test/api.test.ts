/**
 * End-to-end API tests against a running stack (gateway + engine + Postgres + Redis + NATS).
 *   BASE_URL=http://localhost:4000 ADMIN_PASSWORD=... DATABASE_URL=... npm test
 * Uses only its own tenant data. The second tenant test needs DATABASE_URL to create tenant B directly.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import bcrypt from 'bcryptjs';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const ADMIN = { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD || '' };
const RUN = Date.now().toString(36);      // unique names, so the suite can be re-run against the same database
const api = (p: string) => `${BASE}/api/v1${p}`;

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(api(path), { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* csv */ }
  return { status: r.status, json, text };
}
async function login(username: string, password: string, tenant: string | null = TENANT) {
  const r = await call(null, 'POST', '/auth/login', { username, password, tenant: tenant ?? undefined });
  return r;
}

// a realistic 12-week history: weekday/weekend shape, an afternoon peak, trend and noise
function makeCsv(queues: { name: string; scale: number; aht: number }[], days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = new Date(today); d.setDate(d.getDate() - n);
    const f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (const q of queues) for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * q.scale) / 4;
      const v = Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)));
      rows.push(`${q.name},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${v},${q.aht + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

let admin = '', planner = '', analyst = '';
const ctx: Record<string, any> = {};

describe('platform', () => {
  before(() => { assert.ok(ADMIN.password, 'set ADMIN_PASSWORD'); });

  it('health reports every dependency', async () => {
    const r = await fetch(`${BASE}/health`); const j: any = await r.json();
    assert.equal(j.status, 'ok', JSON.stringify(j)); assert.equal(j.rowLevelSecurity, true); assert.equal(j.engine, true);
  });

  it('rejects bad credentials and unauthenticated calls', async () => {
    assert.equal((await login(ADMIN.username, 'wrong-password')).status, 401);
    assert.equal((await call(null, 'GET', '/config/groups')).status, 401);
  });

  it('signs in and returns the permission set', async () => {
    const r = await login(ADMIN.username, ADMIN.password);
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    assert.equal(r.json.user.role, 'WFM_ADMIN'); assert.ok(r.json.permissions.includes('forecast:publish'));
    const me = await call(admin, 'GET', '/auth/me'); assert.equal(me.json.user.username, 'admin');
  });

  it('creates users per role and enforces the RBAC matrix', async () => {
    for (const [username, role] of [['planner1', 'FORECAST_PLANNER'], ['analyst1', 'ANALYST']] as const) {
      const c = await call(admin, 'POST', '/users', { username, displayName: username, role, password: 'Passw0rd!Passw0rd' });
      assert.ok([201, 409].includes(c.status), c.text);
    }
    planner = (await login('planner1', 'Passw0rd!Passw0rd')).json.token;
    analyst = (await login('analyst1', 'Passw0rd!Passw0rd')).json.token;
    assert.equal((await call(planner, 'POST', '/users', { username: 'x1234', displayName: 'x', role: 'AGENT', password: 'Passw0rd!Passw0rd' })).status, 403);
    assert.equal((await call(analyst, 'POST', '/config/groups', { name: 'nope' })).status, 403);
    assert.equal((await call(analyst, 'GET', '/config/groups')).status, 200, 'analysts can read');
  });
});

describe('configuration', () => {
  it('creates a WFM group with queues and validates targets', async () => {
    assert.equal((await call(admin, 'POST', '/config/groups', { name: 'Bad', serviceLevelGoal: 150 })).status, 400);
    const g = await call(admin, 'POST', '/config/groups', { name: `Support ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88, blended: true });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    assert.equal(g.json.serviceLevelGoal, 80); assert.equal(g.json.shrinkagePercent, 30);
    for (const q of [{ name: `Support Voice ${RUN}`, channel: 'VOICE', ahtDefault: 300 }, { name: `Support Chat ${RUN}`, channel: 'CHAT', ahtDefault: 540, concurrency: 3 }]) {
      const r = await call(admin, 'POST', '/config/queues', { ...q, wfmGroupId: ctx.group.id }); assert.equal(r.status, 201, r.text);
    }
    const list = await call(admin, 'GET', '/config/groups'); ctx.group = list.json.find((x: any) => x.id === ctx.group.id); assert.equal(ctx.group.queueNames.length, 2);
  });
});

describe('staged ingestion', () => {
  it('stages, diffs, audits quality, then commits atomically', async () => {
    ctx.csv = makeCsv([{ name: `Support Voice ${RUN}`, scale: 0.9, aht: 300 }, { name: `Support Chat ${RUN}`, scale: 0.5, aht: 540 }], 84);
    const bad = ctx.csv + `\nSupport Voice ${RUN},13/45/2026,09:00,5,300\nNo Such Queue,2026-01-05,09:00,5,300\nSupport Voice ${RUN},2026-01-05,09:00,abc,300`;
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'history.csv', csv: bad });
    assert.equal(up.status, 201, up.text); ctx.job = up.json;
    assert.equal(up.json.status, 'READY'); assert.equal(up.json.errorRecords, 3);
    assert.equal(up.json.summary.diff.new, up.json.validRecords + up.json.warningRecords, 'everything is new on an empty history');
    const detail = await call(admin, 'GET', `/data/imports/${ctx.job.id}`);
    assert.equal(detail.json.errors.length, 3); assert.ok(detail.json.errors.some((e: any) => /Unknown queue/.test(e.message)));
    const before = await call(admin, 'GET', '/data/coverage'); assert.equal(before.json.filter((c: any) => ctx.group.queueIds.includes(c.queueId)).every((c: any) => c.intervals === 0), true, 'staging must not touch live data');
    assert.equal((await call(planner, 'POST', `/data/imports/${ctx.job.id}/rollback`, { reason: 'x' })).status, 403, 'planners cannot roll back');
    const commit = await call(planner, 'POST', `/data/imports/${ctx.job.id}/commit`);
    assert.equal(commit.status, 200, commit.text); assert.match(commit.json.status, /COMPLETED/); assert.equal(commit.json.createdRecords, 84 * 96 * 2);
    const cov = await call(admin, 'GET', '/data/coverage'); assert.equal(cov.json.find((c: any) => c.queueId === ctx.group.queueIds[0]).days, 84);
    assert.equal((await call(admin, 'POST', `/data/imports/${ctx.job.id}/commit`)).status, 409, 'cannot commit twice');
  });

  it('restores exactly what a later import changed, and refuses out-of-order rollback', async () => {
    const one = 'queue,date,interval,volume,aht\n' + ctx.csv.split('\n').slice(1, 41).map((l: string) => l.replace(/,(\d+),(\d+)$/, (_m: string, v: string, a: string) => `,${+v + 100},${a}`)).join('\n');
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'ACTUALS', fileName: 'fix.csv', csv: one }); assert.equal(up.status, 201, up.text);
    assert.ok(up.json.summary.diff.updated > 0, 'changed rows are detected as updates');
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    assert.equal((await call(admin, 'POST', `/data/imports/${ctx.job.id}/rollback`, { reason: 'try' })).status, 409, 'the first import was partly overwritten');
    const rb = await call(admin, 'POST', `/data/imports/${up.json.id}/rollback`, { reason: 'wrong file' });
    assert.equal(rb.status, 200, rb.text); assert.equal(rb.json.status, 'ROLLED_BACK');
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/rollback`, { reason: 'again' })).status, 409);
  });

  it('accepts live interval rows and reports bad ones', async () => {
    const r = await call(admin, 'POST', '/data/ingest', { rows: [{ queue: `Support Voice ${RUN}`, day: '2026-01-05', time: '09:15', volume: 40, ahtSec: 310 }, { queue: 'Nope', day: '2026-01-05', slot: 1, volume: 1 }] });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.accepted, 1); assert.equal(r.json.errors.length, 1);
  });
});

describe('forecasting workflow', () => {
  it('creates numbered versions', async () => {
    const a = await call(planner, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'SHORT', weeks: 2 });
    assert.equal(a.status, 201, a.text); ctx.v1 = a.json; assert.equal(a.json.seq, 1); assert.match(a.json.name, /^Short-term v1 · 2 wk/);
    assert.equal(a.json.status, 'DRAFT');
    const b = await call(planner, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'SHORT', weeks: 4, model: 'ets' });
    assert.equal(b.json.seq, 2); ctx.v2 = b.json;
    const long = await call(planner, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'LONG', days: 120 });
    assert.equal(long.status, 201, long.text); assert.equal(long.json.seq, 1); ctx.vLong = long.json;
    const list = await call(planner, 'GET', `/forecast/versions?groupId=${ctx.group.id}`);
    assert.deepEqual(list.json.map((v: any) => `${v.kind}${v.seq}`), ['LONG1', 'SHORT2', 'SHORT1'], 'newest first within each type');
  });

  it('serves the dashboard, leaderboard and staffing', async () => {
    const d = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/data?grain=60&from=${ctx.v1.fromDay}&to=${ctx.v1.fromDay}`);
    assert.equal(d.json.buckets.length, 24); assert.ok(d.json.buckets.some((b: any) => b.required > 0)); assert.ok(d.json.buckets.every((b: any) => b.p10 <= b.volume && b.volume <= b.p90 + 0.01));
    const day = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/data?grain=day`); assert.equal(day.json.buckets.length, 14);
    const lb = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/leaderboard`);
    assert.equal(lb.status, 200, lb.text); assert.equal(lb.json.rows[0].rank, 1); assert.ok(lb.json.rows.some((r: any) => r.isRecommended));
    assert.ok(lb.json.rows.every((r: any) => ['HIGH', 'MEDIUM', 'VARIABLE'].includes(r.stabilityScore) && r.rmse >= r.mae));
    const sel = lb.json.rows.find((r: any) => r.isRecommended);
    const naive = lb.json.rows.find((r: any) => r.modelId === 'snaive');
    assert.ok(sel.modelId === 'snaive' || sel.wapePercent < naive.wapePercent, 'the chosen model must beat seasonal naive');
    const q = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/data?grain=day&queueId=${ctx.group.queueIds[0]}`); assert.ok(q.json.buckets[0].volume > 0);
  });

  it('requires a reason to adjust, and audits it', async () => {
    const body = { mode: 'pct', value: 10, from: ctx.v1.fromDay, to: ctx.v1.fromDay, slotFrom: 36, slotTo: 47 };
    assert.equal((await call(planner, 'PATCH', `/forecast/versions/${ctx.v1.id}/adjustments`, body)).status, 400, 'no reason');
    assert.equal((await call(analyst, 'PATCH', `/forecast/versions/${ctx.v1.id}/adjustments`, { ...body, reason: 'x1x' })).status, 403);
    const before = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/data?grain=day&from=${ctx.v1.fromDay}&to=${ctx.v1.fromDay}`);
    const r = await call(planner, 'PATCH', `/forecast/versions/${ctx.v1.id}/adjustments`, { ...body, reason: 'Fall promo email blast' });
    assert.equal(r.status, 200, r.text); assert.ok(r.json.afterVolume > r.json.beforeVolume);
    const after = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}/data?grain=day&from=${ctx.v1.fromDay}&to=${ctx.v1.fromDay}`);
    assert.ok(after.json.buckets[0].volume > before.json.buckets[0].volume); assert.equal(after.json.buckets[0].edited, true);
    const detail = await call(planner, 'GET', `/forecast/versions/${ctx.v1.id}`);
    const adj = detail.json.audit.find((a: any) => a.action === 'ADJUST'); assert.equal(adj.reason, 'Fall promo email blast'); assert.equal(adj.by, 'planner1');
    assert.equal(detail.json.type, 'ADJUSTED');
  });

  it('runs Draft -> Submitted -> Approved -> Published with separate permissions', async () => {
    const id = ctx.v1.id;
    assert.equal((await call(planner, 'POST', `/forecast/versions/${id}/publish`)).status, 403, 'planner cannot publish');
    assert.equal((await call(admin, 'POST', `/forecast/versions/${id}/publish`)).status, 409, 'cannot skip approval');
    assert.equal((await call(planner, 'POST', `/forecast/versions/${id}/submit`)).json.status, 'SUBMITTED');
    assert.equal((await call(planner, 'PATCH', `/forecast/versions/${id}/adjustments`, { mode: 'reset', reason: 'undo it' })).status, 409, 'locked once submitted');
    assert.equal((await call(planner, 'POST', `/forecast/versions/${id}/approve`)).status, 403, 'planner cannot approve');
    assert.equal((await call(admin, 'POST', `/forecast/versions/${id}/reject`, {})).status, 400, 'rejection needs a reason');
    assert.equal((await call(admin, 'POST', `/forecast/versions/${id}/reject`, { reason: 'Check the promo uplift' })).json.status, 'DRAFT');
    await call(planner, 'POST', `/forecast/versions/${id}/submit`);
    assert.equal((await call(admin, 'POST', `/forecast/versions/${id}/approve`)).json.status, 'APPROVED');
    const pub = await call(admin, 'POST', `/forecast/versions/${id}/publish`); assert.equal(pub.json.status, 'PUBLISHED'); assert.equal(pub.json.publishedBy, 'Administrator');
    assert.equal((await call(admin, 'DELETE', `/forecast/versions/${id}`)).status, 409, 'a published forecast cannot be deleted');
    // publishing a newer one archives this one
    for (const step of ['submit', 'approve', 'publish']) await call(admin, 'POST', `/forecast/versions/${ctx.v2.id}/${step}`);
    const list = await call(admin, 'GET', `/forecast/versions?groupId=${ctx.group.id}&kind=SHORT`);
    assert.deepEqual(list.json.filter((v: any) => v.kind === 'SHORT').map((v: any) => v.status), ['PUBLISHED', 'ARCHIVED']);
  });

  it('clones into a numbered draft', async () => {
    const c = await call(planner, 'POST', `/forecast/versions/${ctx.v1.id}/clone`);
    assert.equal(c.status, 201, c.text); assert.equal(c.json.seq, 3); assert.match(c.json.name, /copy of v1/); assert.equal(c.json.status, 'DRAFT'); assert.equal(c.json.parentVersionId, ctx.v1.id);
    const csv = await call(planner, 'GET', `/forecast/versions/${c.json.id}/export.csv`); assert.match(csv.text.split('\n')[0], /^queue,date,interval,forecast_contacts/);
  });

  it('compares what-if scenarios and builds a capacity plan', async () => {
    const r = await call(planner, 'POST', `/forecast/versions/${ctx.v2.id}/scenarios/compare`, { scenarios: [{ name: '+20% volume', params: { volumePct: 20 } }, { name: 'Erlang A', params: { method: 'erlang_a' } }] });
    assert.equal(r.status, 200, r.text); const [base, up, ea] = r.json.results;
    assert.ok(up.agentHours > base.agentHours, 'more volume needs more agent hours'); assert.ok(ea.agentHours <= base.agentHours + 0.5, 'Erlang A never needs more than Erlang C'); assert.ok(up.impactRequiredFteDelta > 0);
    const saved = await call(planner, 'POST', `/forecast/versions/${ctx.v2.id}/scenarios`, { name: 'Campaign', params: { volumePct: 25 } }); assert.equal(saved.status, 201);
    assert.equal((await call(planner, 'GET', `/forecast/versions/${ctx.v2.id}/scenarios`)).json.length, 1);
    const cap = await call(planner, 'GET', `/forecast/versions/${ctx.vLong.id}/capacity`); assert.equal(cap.status, 200, cap.text); assert.ok(cap.json.periods.length >= 3 && cap.json.periods.every((p: any) => p.fte > 0));
  });

  it('shows accuracy by day and hour, and explains a staffing number', async () => {
    const a = await call(planner, 'GET', `/forecast/accuracy?groupId=${ctx.group.id}&days=14`);
    assert.equal(a.status, 200, a.text); assert.ok(a.json.byDayHour.length > 100); assert.ok(a.json.total.daily.wape < 0.25, `daily error too high: ${a.json.total.daily.wape}`); assert.equal(a.json.byHour.length, 24);
    const t = await call(planner, 'POST', '/forecast/trace-staffing', { groupId: ctx.group.id, volume: 30, ahtSec: 300 });
    assert.equal(t.status, 200, t.text); assert.equal(t.json.steps.length, 5); assert.ok(t.json.onSchedule >= t.json.agents && t.json.agents >= t.json.rawAgents);
    assert.equal(t.json.sensitivity.length, 5);
  });

  it('records special events and uses them for the next forecast', async () => {
    const e = await call(planner, 'POST', '/forecast/events', { groupId: ctx.group.id, name: 'Autumn promo', kind: 'campaign', startDay: ctx.v1.fromDay, upliftPct: 30 }); assert.equal(e.status, 201, e.text);
    const ramped = await call(planner, 'POST', '/forecast/events', { groupId: ctx.group.id, name: 'Ramped promo', kind: 'campaign', startDay: ctx.v1.fromDay, upliftPct: 40, leadDays: 5, lagDays: 3 });
    assert.equal(ramped.status, 201, ramped.text);
    const list = (await call(planner, 'GET', `/forecast/events?groupId=${ctx.group.id}`)).json;
    assert.equal(list.length, 2);
    const found = list.find((x: any) => x.name === 'Ramped promo');
    assert.equal(found.leadDays, 5); assert.equal(found.lagDays, 3);
    const plain = list.find((x: any) => x.name === 'Autumn promo');
    assert.equal(plain.leadDays, 0, 'ramp defaults to 0 (the old hard on/off behaviour) when not given');
    assert.equal(plain.lagDays, 0);
  });

  it('breaks shrinkage into named categories, whose sum drives staffing instead of the flat percentage', async () => {
    assert.equal((await call(planner, 'GET', `/config/groups/${ctx.group.id}/shrinkage-categories`)).json.length, 0);
    const before = await call(planner, 'POST', '/forecast/trace-staffing', { groupId: ctx.group.id, volume: 30, ahtSec: 300 });
    assert.equal(before.json.shrinkage, 0.3, 'starts from the flat 30% set on the group');

    const breaks = await call(admin, 'POST', `/config/groups/${ctx.group.id}/shrinkage-categories`, { name: 'Breaks', pct: 12 });
    assert.equal(breaks.status, 201, breaks.text);
    assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/shrinkage-categories`, { name: 'Training', pct: 8 })).status, 201);
    assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/shrinkage-categories`, { name: 'Absence', pct: 5 })).status, 201);
    assert.equal((await call(admin, 'POST', `/config/groups/${ctx.group.id}/shrinkage-categories`, { name: 'Over cap', pct: 80 })).status, 400, 'the sum may not exceed the 90% cap');
    assert.equal((await call(planner, 'POST', `/config/groups/${ctx.group.id}/shrinkage-categories`, { name: 'Nope', pct: 1 })).status, 403, 'needs config:write, same as editing the group');

    const list = (await call(planner, 'GET', `/config/groups/${ctx.group.id}/shrinkage-categories`)).json;
    assert.equal(list.length, 3);

    const after = await call(planner, 'POST', '/forecast/trace-staffing', { groupId: ctx.group.id, volume: 30, ahtSec: 300 });
    assert.equal(after.json.shrinkage, 0.25, '12 + 8 + 5 = 25%, now used instead of the flat 30%');
    assert.ok(after.json.onSchedule < before.json.onSchedule, 'less shrinkage means fewer people need to be on schedule for the same workload');

    const renamed = await call(admin, 'PUT', `/config/groups/${ctx.group.id}/shrinkage-categories/${breaks.json.id}`, { pct: 20 });
    assert.equal(renamed.status, 200, renamed.text); assert.equal(renamed.json.pct, 20);
    assert.equal((await call(planner, 'POST', '/forecast/trace-staffing', { groupId: ctx.group.id, volume: 30, ahtSec: 300 })).json.shrinkage, 0.33, '20 + 8 + 5 = 33%');

    for (const c of list) assert.equal((await call(admin, 'DELETE', `/config/groups/${ctx.group.id}/shrinkage-categories/${c.id}`)).status, 200);
    const restored = await call(planner, 'POST', '/forecast/trace-staffing', { groupId: ctx.group.id, volume: 30, ahtSec: 300 });
    assert.equal(restored.json.shrinkage, 0.3, 'with no categories left, staffing falls back to the flat percentage again');
  });
});

describe('audit and isolation', () => {
  it('keeps an append-only ledger with actors and reasons', async () => {
    const r = await call(admin, 'GET', '/audit?limit=200'); assert.equal(r.status, 200);
    const actions = new Set(r.json.map((x: any) => x.action)); for (const a of ['LOGIN', 'CREATE', 'ADJUST', 'SUBMIT', 'APPROVE', 'PUBLISH', 'REJECT', 'IMPORT', 'ROLLBACK']) assert.ok(actions.has(a), `missing ${a}`);
    assert.ok(r.json.every((x: any) => x.actorName && x.timestamp));
    assert.equal((await call(planner, 'GET', '/audit')).status, 403);
  });

  it('never shows one tenant another tenant\'s data', async () => {
    const url = process.env.DATABASE_URL; if (!url) return;                     // needs direct DB access to create tenant B
    const c = new pg.Client({ connectionString: url, options: '-c search_path=wfm,public' }); await c.connect();
    try {
      const t = (await c.query(`INSERT INTO tenants (name, code, timezone) VALUES ('Other Co', 'OTHER', 'UTC') ON CONFLICT (code) DO UPDATE SET name = 'Other Co' RETURNING id`)).rows[0].id;
      await c.query(`INSERT INTO role_permissions (tenant_id, role, permission) SELECT $1, 'WFM_ADMIN', permission FROM role_permissions WHERE role = 'WFM_ADMIN' AND tenant_id <> $1 ON CONFLICT DO NOTHING`, [t]);
      await c.query(`INSERT INTO users (tenant_id, username, display_name, password_hash, role) VALUES ($1, 'boss', 'Boss', $2, 'WFM_ADMIN') ON CONFLICT DO NOTHING`, [t, await bcrypt.hash('Passw0rd!Passw0rd', 10)]);
    } finally { await c.end(); }
    assert.equal((await login('boss', 'Passw0rd!Passw0rd', null)).status, 400, 'with two tenants the sign-in must name one');
    const b = (await login('boss', 'Passw0rd!Passw0rd', 'OTHER')).json.token;
    assert.equal((await call(b, 'GET', '/config/groups')).json.length, 0, 'tenant B sees no groups');
    assert.equal((await call(b, 'GET', `/forecast/versions/${ctx.v1.id}`)).status, 404, 'tenant B cannot open tenant A\'s forecast');
    assert.equal((await call(b, 'GET', `/data/imports/${ctx.job.id}`)).status, 404);
    assert.equal((await call(b, 'GET', '/forecast/versions')).json.length, 0);
    assert.equal((await call(b, 'GET', '/audit')).json.every((x: any) => x.actorName === 'Boss'), true, 'audit is per tenant');
  });
});
