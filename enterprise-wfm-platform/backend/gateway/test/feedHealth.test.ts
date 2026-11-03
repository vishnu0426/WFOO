/**
 * Direct interval feed health: receipts, late/rejecting verdicts, the dry-run check, rejected rows.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/feedHealth.test.ts
 * Needs a running gateway. Set DATABASE_URL too so the run starts from an empty feed history (receipts are per organisation and
 * accumulate across runs); without it the "never sent anything" check is skipped and the verdict checks may see earlier runs.
 * The pure verdict rules are tested first and need nothing.
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { feedState, nextStep, sourceKind } from '../src/modules/feedHealth.ts';

describe('feed verdict', () => {
  const base = { everReceived: true, minutesSilent: 5, lateAfterMin: 30 };
  it('waits until the first data arrives', () => assert.equal(feedState({ ...base, everReceived: false, minutesSilent: null }), 'WAITING'));
  it('is healthy while data keeps arriving', () => assert.equal(feedState(base), 'HEALTHY'));
  it('is late once silent past the limit, and not before', () => {
    assert.equal(feedState({ ...base, minutesSilent: 30 }), 'HEALTHY');
    assert.equal(feedState({ ...base, minutesSilent: 31 }), 'LATE');
  });
  it('is late when only rejected messages ever arrived', () => assert.equal(feedState({ ...base, minutesSilent: null }), 'LATE'));
  it('flags a feed that is mostly rejected, but not the odd bad row', () => {
    assert.equal(feedState({ ...base, received24h: 100, rejected24h: 20 }), 'REJECTING');
    assert.equal(feedState({ ...base, received24h: 100, rejected24h: 19 }), 'HEALTHY');
  });
  it('silence outranks rejections', () => assert.equal(feedState({ ...base, minutesSilent: 90, received24h: 10, rejected24h: 10 }), 'LATE'));
});

describe('history source wording', () => {
  it('names the kind of source from its preset', () => {
    assert.equal(sourceKind('DATABASE_POSTGRES_PULL'), 'DATABASE');
    assert.equal(sourceKind('GENERIC_DATABASE'), 'DATABASE_RELAY');
    assert.equal(sourceKind('GENERIC_ACD_API'), 'API');
    assert.equal(sourceKind('GENERIC_SFTP'), 'FILES');
    assert.equal(sourceKind('GENERIC_ACD_RELAY'), 'PUSH');
    assert.equal(sourceKind('AVAYA_CMS'), 'PUSH');
  });
  it('says the one thing to do next, in order', () => {
    const base = { kind: 'DATABASE' as const, status: 'ACTIVE', backfillStatus: 'DONE', scheduled: true, canPull: true, everReceived: true };
    assert.match(nextStep({ ...base, status: 'DRAFT' }) ?? '', /Active/);
    assert.match(nextStep({ ...base, backfillStatus: 'NOT_STARTED', scheduled: false }) ?? '', /load history/i, 'history comes before the schedule');
    assert.match(nextStep({ ...base, scheduled: false }) ?? '', /when we should fetch/);
    assert.equal(nextStep(base), null, 'nothing left to do');
    assert.equal(nextStep({ ...base, kind: 'FILES', backfillStatus: 'NOT_STARTED', scheduled: false }), 'Choose when we should fetch it.', 'only a database needs a history load');
    assert.match(nextStep({ ...base, kind: 'PUSH', canPull: false, everReceived: false, scheduled: false }) ?? '', /first delivery/);
    assert.match(nextStep({ ...base, kind: 'DATABASE_RELAY', canPull: false, everReceived: false, scheduled: false }) ?? '', /relay/);
    assert.equal(nextStep({ ...base, status: 'PAUSED', scheduled: false }), null, 'a paused source is left alone');
  });
});

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};

describe('feed health API', { skip: !process.env.ADMIN_PASSWORD }, () => {
  let admin = ''; const queue = `Feed Voice ${RUN}`;
  const today = new Date().toISOString().slice(0, 10);
  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    if (process.env.DATABASE_URL) {
      const db = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' });
      await db.connect(); await db.query('DELETE FROM feed_receipts'); await db.end();
    }
    const g = await call(admin, 'POST', '/config/groups', { name: `Feed ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text);
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', ahtDefault: 300, wfmGroupId: g.json.id })).status, 201);
  });

  it('shows a feed that has never sent anything as waiting', { skip: !process.env.DATABASE_URL }, async () => {
    const s = await call(admin, 'GET', '/data/ingest/status');
    assert.equal(s.status, 200, s.text); assert.equal(s.json.direct.state, 'WAITING'); assert.equal(s.json.lateAfterMin, 30); assert.deepEqual(s.json.rejects, []);
  });

  it('checks a message without saving it or leaving a receipt', async () => {
    const ok = await call(admin, 'POST', '/data/ingest/check', { rows: [{ queue, day: today, time: '09:15', volume: 5 }, { queue: 'Nope', day: today, time: '09:15', volume: 1 }] });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.accepted, 1); assert.equal(ok.json.errors.length, 1);
    const s = await call(admin, 'GET', '/data/ingest/status');
    assert.equal(s.json.direct.state, 'WAITING', 'a check is not a delivery');
    const cov = await call(admin, 'GET', '/data/coverage');
    assert.equal(cov.json.find((c: any) => c.name === queue).intervals, 0, 'nothing was saved');
  });

  it('records a delivery, counts what was kept and turns away the rest with the reason', async () => {
    const r = await call(admin, 'POST', '/data/ingest', { rows: [{ queue, day: today, time: '09:15', volume: 42, ahtSec: 310 }, { queue: 'Unknown Q', day: today, time: '09:30', volume: 3 }, { queue, day: today, volume: 3 }] });
    assert.equal(r.status, 200, r.text); assert.equal(r.json.accepted, 1); assert.equal(r.json.errors.length, 2);
    const s = (await call(admin, 'GET', '/data/ingest/status')).json;
    assert.equal(s.direct.state, 'REJECTING', 'two of three rows were turned away'); assert.equal(s.direct.accepted24h, 1); assert.equal(s.direct.rejected24h, 2);
    assert.equal(s.recent[0].rowsReceived, 3); assert.equal(s.recent[0].source, 'API');
    const why = s.rejects.map((x: any) => `${x.rowIndex}:${x.queue}:${x.message}`);
    assert.ok(why.some((w: string) => w.startsWith("1:Unknown Q:Unknown queue 'Unknown Q'")), why.join(' | '));
    assert.ok(why.some((w: string) => w.startsWith(`2:${queue}:Give a slot`)), why.join(' | '));
  });

  it('goes back to healthy once good data outweighs the odd bad row', async () => {
    const good = Array.from({ length: 30 }, (_, i) => ({ queue, day: today, slot: 20 + i, volume: 10 }));
    assert.equal((await call(admin, 'POST', '/data/ingest', { rows: good })).json.accepted, 30);
    assert.equal((await call(admin, 'GET', '/data/ingest/status')).json.direct.state, 'HEALTHY');
  });

  it('turns a feed that sends mostly bad rows into "rejecting"', async () => {
    await call(admin, 'POST', '/data/ingest', { rows: Array.from({ length: 6 }, () => ({ queue: 'Nobody', day: today, time: '10:00', volume: 1 })) });
    assert.equal((await call(admin, 'GET', '/data/ingest/status')).json.direct.state, 'REJECTING');
  });

  it('lets the late limit be changed, and rejects silly values', async () => {
    assert.equal((await call(admin, 'PUT', '/data/ingest/settings', { lateAfterMin: 120 })).status, 200);
    assert.equal((await call(admin, 'GET', '/data/ingest/status')).json.lateAfterMin, 120);
    assert.equal((await call(admin, 'PUT', '/data/ingest/settings', { lateAfterMin: 1 })).status, 400);
    await call(admin, 'PUT', '/data/ingest/settings', { lateAfterMin: 30 });
  });

  it('does not call the feed late for silence while every queue was closed', { skip: !process.env.DATABASE_URL }, async () => {
    const db = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' });
    await db.connect();
    try {
      const tz = (await db.query('SELECT timezone FROM tenants LIMIT 1')).rows[0].timezone as string;
      const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
      const cur = Math.floor((Number(parts.find((p) => p.type === 'hour')!.value) * 60 + Number(parts.find((p) => p.type === 'minute')!.value)) / 15);
      const open = (cur + 40) % 92;                                              // an hour well away from now and from the last three hours
      await db.query('UPDATE queues SET open_slot = $1, close_slot = $2', [open, open + 4]);
      await db.query("UPDATE feed_receipts SET received_at = now() - interval '3 hours', rows_rejected = 0, errors = '[]'");   // earlier tests left bad rows behind; rejections outrank "closed"
      const closed = (await call(admin, 'GET', '/data/ingest/status')).json;
      assert.equal(closed.closedNow, true);
      assert.equal(closed.direct.state, 'CLOSED', 'three hours of quiet, all of it outside opening hours');
      const issues = (await call(admin, 'GET', '/data/quality')).json;
      assert.ok(!issues.some((i: any) => i.id === 'feed-late'), 'no late warning for a closed night');
      await db.query('UPDATE queues SET open_slot = 0, close_slot = 96');
      assert.equal((await call(admin, 'GET', '/data/ingest/status')).json.direct.state, 'LATE', 'the same silence while open is late');
      assert.ok((await call(admin, 'GET', '/data/quality')).json.some((i: any) => i.id === 'feed-late'));
    } finally { await db.query('UPDATE queues SET open_slot = 0, close_slot = 96'); await db.end(); }
  });

  it('needs sign-in', async () => {
    assert.equal((await call(null, 'GET', '/data/ingest/status')).status, 401);
    assert.equal((await call(null, 'POST', '/data/ingest/check', { rows: [] })).status, 401);
  });
});
