/**
 * Connector pulls, schedules and run history; opening-hours-aware feed verdicts.
 *   DATABASE_URL=... BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ORG npx tsx --test test/connectorRuns.test.ts
 * The pure rules run anywhere. The API half needs a running gateway AND DATABASE_URL (to start from an empty feed and to bring a schedule forward).
 * It hosts a real SFTP server and a REST endpoint inside this process for the gateway to pull from.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import pg from 'pg';
import ssh2 from 'ssh2';
import { feedState, openMinutesBetween, isOpenAt, slotAt } from '../src/modules/feedHealth.ts';
import { checkDbValue, checkQuery, findRows, parseRemotePath, prepareQuery, pullSupport } from '../src/modules/integrations/pullRules.ts';
import { presetById } from '../src/modules/integrations/presets.ts';
import { firstRunAt, nextRunAfter } from '../src/modules/integrations/schedule.ts';

describe('opening hours', () => {
  const day = [{ open: 32, close: 80 }];                                   // 08:00 to 20:00
  const at = (iso: string) => new Date(iso);
  it('reads the slot of the day in the organisation time zone', () => {
    assert.equal(slotAt(at('2026-03-31T09:15:00Z'), 'UTC'), 37);
    assert.equal(slotAt(at('2026-03-31T09:15:00Z'), 'Asia/Kolkata'), 59);   // 14:45 local
  });
  it('knows whether a queue is open', () => {
    assert.equal(isOpenAt(at('2026-03-31T09:00:00Z'), 'UTC', day), true);
    assert.equal(isOpenAt(at('2026-03-31T22:00:00Z'), 'UTC', day), false);
    assert.equal(isOpenAt(at('2026-03-31T22:00:00Z'), 'UTC', []), true, 'no hours means around the clock');
  });
  it('counts only the minutes the queues were open', () => {
    assert.equal(openMinutesBetween(at('2026-03-31T19:00:00Z'), at('2026-04-01T09:00:00Z'), 'UTC', day), 120);
    assert.equal(openMinutesBetween(at('2026-03-31T19:00:00Z'), at('2026-04-01T09:00:00Z'), 'UTC', []), 840);
    assert.equal(openMinutesBetween(at('2026-03-31T21:00:00Z'), at('2026-04-01T07:00:00Z'), 'UTC', day), 0, 'a whole closed night is not silence');
  });
  it('uses the time zone, so a night in India is not a day in London', () => {
    const w = [{ open: 36, close: 76 }];                                    // 09:00 to 19:00
    assert.equal(openMinutesBetween(at('2026-03-31T10:00:00Z'), at('2026-03-31T14:00:00Z'), 'Asia/Kolkata', w), 210);   // 15:30-19:30 local, open until 19:00
  });
  it('stops early once past the cap', () => {
    assert.ok(openMinutesBetween(at('2026-01-01T00:00:00Z'), at('2026-03-31T00:00:00Z'), 'UTC', [], 30) > 30);
  });
  it('an overnight closure is "closed", not "late"; silence while open is still late', () => {
    assert.equal(feedState({ everReceived: true, minutesSilent: 0, lateAfterMin: 30, closedNow: true }), 'CLOSED');
    assert.equal(feedState({ everReceived: true, minutesSilent: 45, lateAfterMin: 30, closedNow: true }), 'LATE');
    assert.equal(feedState({ everReceived: true, minutesSilent: 0, lateAfterMin: 30, closedNow: false }), 'HEALTHY');
  });
});

describe('database query rules', () => {
  it('accepts one SELECT, with or without a WITH, and drops a trailing semicolon', () => {
    assert.equal(checkQuery('  SELECT 1;  '), 'SELECT 1');
    assert.equal(checkQuery('with x as (select 1) select * from x'), 'with x as (select 1) select * from x');
  });
  it('refuses anything else, up front', () => {
    for (const q of ['', 'UPDATE t SET a = 1', 'DELETE FROM t', 'SELECT 1; DROP TABLE t', 'SELECT 1 -- hi', 'SELECT /* x */ 1', 'selection']) assert.throws(() => checkQuery(q), Error, q);
  });
  it('turns {from} and {to} into parameters, passing only those used', () => {
    const both = prepareQuery('SELECT * FROM t WHERE d BETWEEN {from} AND {to}', '2026-03-01', '2026-03-07');
    assert.deepEqual(both.params, ['2026-03-01', '2026-03-07']);
    assert.match(both.text, /BETWEEN \$1::date AND \$2::date\) AS wfm_pull LIMIT 150001$/);
    const onlyTo = prepareQuery('SELECT * FROM t WHERE d <= {to} AND e <= {to}', '2026-03-01', '2026-03-07', 10);
    assert.deepEqual(onlyTo.params, ['2026-03-07']);
    assert.match(onlyTo.text, /<= \$1::date AND e <= \$1::date/);
    assert.match(onlyTo.text, /LIMIT 11$/);
    assert.deepEqual(prepareQuery('SELECT 1', 'a', 'b').params, []);
  });
  it('refuses a timestamp where text was expected, and says how to fix it', () => {
    assert.match(checkDbValue('time', new Date()) ?? '', /to_char/);
    assert.equal(checkDbValue('time', '09:15'), null);
  });
});

describe('what the server can pull', () => {
  it('pulls a generic REST source and an SFTP folder the customer hosts', () => {
    assert.equal(pullSupport(presetById('GENERIC_ACD_API'), {}).canPull, true);
    assert.equal(pullSupport(presetById('GENERIC_SFTP'), { direction: 'they_host' }).canPull, true);
    assert.equal(pullSupport(presetById('DATABASE_POSTGRES_PULL'), {}).canPull, true);
    assert.equal(pullSupport(presetById('GENERIC_DATABASE'), {}).canPull, false, 'the relay database connector is read on the customer side');
  });
  it('says plainly when it cannot, and why', () => {
    const we = pullSupport(presetById('GENERIC_SFTP'), { direction: 'we_host' });
    assert.equal(we.canPull, false); assert.match(we.note, /do not host/);
    const g = pullSupport(presetById('GENESYS_CLOUD'), {});
    assert.equal(g.canPull, false); assert.match(g.note, /not available yet/);
    assert.deepEqual(pullSupport(presetById('GENERIC_ACD_RELAY'), {}), { canPull: false, note: '' }, 'a pushed source needs no explanation');
  });
  it('finds the list of rows in the usual response shapes', () => {
    assert.deepEqual(findRows([{ a: 1 }]), [{ a: 1 }]);
    assert.deepEqual(findRows({ data: [{ a: 1 }] }), [{ a: 1 }]);
    assert.deepEqual(findRows({ meta: {}, entries: [{ a: 2 }] }), [{ a: 2 }]);
    assert.throws(() => findRows({ ok: true }), /list of rows/);
  });
  it('reads a folder or a filename pattern', () => {
    assert.deepEqual(parseRemotePath('/exports/').dir, '/exports');
    assert.equal(parseRemotePath('/exports').match.test('a.CSV'), true);
    assert.equal(parseRemotePath('/exports').match.test('a.pdf'), false);
    const p = parseRemotePath('/exports/queue_*.csv');
    assert.equal(p.dir, '/exports'); assert.equal(p.match.test('queue_2026.csv'), true); assert.equal(p.match.test('other.csv'), false);
    assert.equal(parseRemotePath(undefined).dir, '/');
  });
});

// ---------------------------------------------------------------- API half

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const RUN = Date.now().toString(36);
const call = async (token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
};
const ctx: Record<string, any> = {};
const freePort = () => new Promise<number>((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => ok(p)); }); });

/** A small in-memory SFTP server: one folder of files, one login. */
function sftpServer(files: Map<string, { data: Buffer; mtime: number }>, user: string, pass: string) {
  const { STATUS_CODE } = ssh2.utils.sftp;
  const hostKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === user && ctx.password === pass ? ctx.accept() : ctx.reject(['password'])));
    client.on('error', () => {});
    client.on('ready', () => client.on('session', (accept) => accept().on('sftp', (acceptSftp) => {
      const sftp = acceptSftp();
      const handles = new Map<string, { kind: 'dir' | 'file'; name?: string; sent?: boolean }>();
      let n = 0;
      const fileAttrs = (f: { data: Buffer; mtime: number }) => ({ mode: 0o100644, uid: 0, gid: 0, size: f.data.length, atime: f.mtime, mtime: f.mtime });
      const base = (p: string) => p.split('/').filter(Boolean).pop() ?? '';
      sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: p || '/', longname: p || '/', attrs: {} as any }]));
      sftp.on('STAT', (id, p) => { const f = files.get(base(p)); f ? sftp.attrs(id, fileAttrs(f)) : sftp.attrs(id, { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }); });
      sftp.on('LSTAT', (id, p) => { const f = files.get(base(p)); f ? sftp.attrs(id, fileAttrs(f)) : sftp.attrs(id, { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }); });
      sftp.on('OPENDIR', (id) => { const h = Buffer.from(`d${++n}`); handles.set(h.toString(), { kind: 'dir' }); sftp.handle(id, h); });
      sftp.on('READDIR', (id, h) => {
        const st = handles.get(h.toString());
        if (!st || st.sent) return sftp.status(id, STATUS_CODE.EOF);
        st.sent = true;
        sftp.name(id, [...files].map(([filename, f]) => ({ filename, longname: `-rw-r--r--    1 0        0        ${f.data.length} Jan  1 00:00 ${filename}`, attrs: fileAttrs(f) as any })));   // clients read the file type from the first character of this ls-style line
      });
      sftp.on('OPEN', (id, filename) => { const f = files.get(base(filename)); if (!f) return sftp.status(id, STATUS_CODE.NO_SUCH_FILE); const h = Buffer.from(`f${++n}`); handles.set(h.toString(), { kind: 'file', name: base(filename) }); sftp.handle(id, h); });
      sftp.on('FSTAT', (id, h) => { const st = handles.get(h.toString()); const f = st?.name ? files.get(st.name) : undefined; f ? sftp.attrs(id, fileAttrs(f)) : sftp.status(id, STATUS_CODE.FAILURE); });
      sftp.on('READ', (id, h, offset, length) => {
        const st = handles.get(h.toString()); const f = st?.name ? files.get(st.name) : undefined;
        if (!f || offset >= f.data.length) return sftp.status(id, STATUS_CODE.EOF);
        sftp.data(id, f.data.subarray(offset, offset + length));
      });
      sftp.on('CLOSE', (id, h) => { handles.delete(h.toString()); sftp.status(id, STATUS_CODE.OK); });
    })));
  });
  return server;
}

describe('connector pulls and run history', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = ''; let queueId = ''; const queue = `Pull Voice ${RUN}`;
  const today = new Date().toISOString().slice(0, 10);
  const files = new Map<string, { data: Buffer; mtime: number }>();
  let sftp: ssh2.Server; let sftpPort = 0; let rest: http.Server; let restPort = 0;
  let restRows: any = [];
  const db = () => new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' });

  const goodCsv = ['queue,date,interval,volume,aht', ...Array.from({ length: 12 }, (_, i) => `${queue},${today},${String(Math.floor(i * 15 / 60)).padStart(2, '0')}:${String(i * 15 % 60).padStart(2, '0')},10,300`)].join('\n');
  const connector = async (body: any) => { const r = await call(admin, 'POST', '/integrations', body); assert.equal(r.status, 201, r.text); return r.json; };
  const activate = async (id: string, extra: any = {}) => assert.equal((await call(admin, 'PUT', `/integrations/${id}`, { status: 'ACTIVE', ...extra })).status, 200);

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    const c = db(); await c.connect(); await c.query('DELETE FROM feed_receipts'); await c.end();
    const g = await call(admin, 'POST', '/config/groups', { name: `Pull ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
    const q = await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', ahtDefault: 300, wfmGroupId: g.json.id });
    assert.equal(q.status, 201, q.text); queueId = q.json.id;

    files.set('queue_ok.csv', { data: Buffer.from(goodCsv), mtime: 1_760_000_000 });
    files.set('no_volume.csv', { data: Buffer.from(`queue,date,interval\n${queue},${today},09:00`), mtime: 1_760_000_100 });
    files.set('notes.pdf', { data: Buffer.from('%PDF'), mtime: 1_760_000_200 });
    sftpPort = await freePort(); sftp = sftpServer(files, 'feeder', 'pw-123'); await new Promise<void>((ok) => sftp.listen(sftpPort, '127.0.0.1', ok));
    restPort = await freePort();
    rest = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer rest-key-1') { res.statusCode = 401; return res.end('no'); }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(restRows));
    });
    await new Promise<void>((ok) => rest.listen(restPort, '127.0.0.1', ok));
  });
  after(async () => { sftp?.close(); rest?.close(); });

  const sftpConfig = (over: any = {}) => ({ direction: 'they_host', host: '127.0.0.1', port: String(sftpPort), username: 'feeder', password: 'pw-123', remotePath: '/exports', ...over });

  it('picks up new files over SFTP, stages the good one, and leaves the unreadable one for a person', async () => {
    const c = await connector({ category: 'SFTP', preset: 'GENERIC_SFTP', name: `Nightly files ${RUN}`, config: sftpConfig() });
    assert.equal(c.canPull, true);
    assert.equal((await call(admin, 'POST', `/integrations/${c.id}/run`)).status, 400, 'a draft connector cannot be run');
    await activate(c.id);
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'PARTIAL', r.text); assert.equal(r.json.rowsOk, 12); assert.match(r.json.message, /Staged 1 file/); assert.match(r.json.message, /no_volume\.csv/);
    const jobs = await call(admin, 'GET', '/data/imports');
    const job = jobs.json.find((j: any) => j.fileName === 'queue_ok.csv');
    assert.ok(job, 'the file is on the Staged Ingestion page'); assert.equal(job.status, 'READY'); assert.equal(job.createdBy, `Connector: Nightly files ${RUN}`);
    const cov = await call(admin, 'GET', '/data/coverage');
    assert.equal(cov.json.find((x: any) => x.name === queue).intervals, 0, 'staged, not live');
    ctx.sftp = c.id;
  });

  it('does not pick the same file up twice, but does pick up a changed one', async () => {
    const again = await call(admin, 'POST', `/integrations/${ctx.sftp}/run`);
    assert.equal(again.json.status, 'OK'); assert.match(again.json.message, /No new files/);
    files.set('queue_ok.csv', { data: Buffer.from(goodCsv + `\n${queue},${today},03:00,5,300`), mtime: 1_760_000_999 });
    const changed = await call(admin, 'POST', `/integrations/${ctx.sftp}/run`);
    assert.match(changed.json.message, /Staged 1 file/);
  });

  it('records every run and the files it saw', async () => {
    const h = await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`);
    assert.equal(h.status, 200, h.text);
    assert.deepEqual(h.json.runs.map((r: any) => r.status), ['OK', 'OK', 'PARTIAL'], 'newest first; the unreadable file is reported once, not on every run');
    assert.equal(h.json.runs.length, 3); assert.ok(h.json.runs.every((r: any) => r.trigger === 'MANUAL' && r.kind === 'FILE'));
    const byName = Object.fromEntries(h.json.files.map((f: any) => [f.fileName + f.status, true]));
    assert.ok(byName['queue_ok.csvSTAGED'] && byName['no_volume.csvNEEDS_ATTENTION']);
  });

  it('shows a source that cannot be signed in to as failing, with the reason', async () => {
    const c = await connector({ category: 'SFTP', preset: 'GENERIC_SFTP', name: `Wrong password ${RUN}`, config: sftpConfig({ password: 'nope' }) });
    await activate(c.id);
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`);
    assert.equal(r.json.status, 'FAILED'); assert.match(r.json.message, /Could not sign in/);
    const s = (await call(admin, 'GET', '/data/ingest/status')).json.connectors.find((x: any) => x.id === c.id);
    assert.equal(s.state, 'FAILING'); assert.match(s.lastError, /Could not sign in/);
  });

  it('pulls from a REST source with the connector key and saves the rows to history', async () => {
    const c = await connector({ category: 'ACD', preset: 'GENERIC_ACD_API', name: `REST ${RUN}`, config: { apiKey: 'rest-key-1', baseUrl: `http://127.0.0.1:${restPort}`, volumeEndpoint: '/stats?from={from}&to={to}' } });
    assert.equal((await call(admin, 'PUT', `/integrations/${c.id}/field-maps`, [{ targetField: 'day', sourcePath: 'day' }, { targetField: 'time', sourcePath: 'time' }, { targetField: 'volume', sourcePath: 'offered' }])).status, 200);
    await activate(c.id);
    restRows = { data: [{ queueId, day: today, time: '09:00', offered: 17 }, { queueId, day: today, time: '09:15', offered: 21 }, { queueId: 'unknown', day: today, time: '09:30', offered: 3 }] };
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`);
    assert.equal(r.status, 200, r.text); assert.equal(r.json.rowsOk, 2, r.text);
    const cov = await call(admin, 'GET', '/data/coverage');
    assert.equal(cov.json.find((x: any) => x.name === queue).intervals, 2, 'pulled rows are live');
    const feed = (await call(admin, 'GET', '/data/ingest/status')).json;
    assert.equal(feed.direct.state, 'WAITING', 'a connector is not the direct feed');
    ctx.rest = c.id;
  });

  it('turns a rejected key into a failed run, not a crash', async () => {
    await call(admin, 'PUT', `/integrations/${ctx.rest}`, { config: { apiKey: 'wrong', baseUrl: `http://127.0.0.1:${restPort}`, volumeEndpoint: '/stats' } });
    const r = await call(admin, 'POST', `/integrations/${ctx.rest}/run`);
    assert.equal(r.json.status, 'FAILED'); assert.match(r.json.message, /401/);
  });

  it('refuses to schedule a source that sends to us, or a vendor pull that is not built', async () => {
    const relay = await connector({ category: 'ACD', preset: 'GENERIC_ACD_RELAY', name: `Relay ${RUN}`, config: {} });
    await call(admin, 'PUT', `/integrations/${relay.id}/field-maps`, [{ targetField: 'day', sourcePath: 'day' }, { targetField: 'time', sourcePath: 'time' }, { targetField: 'volume', sourcePath: 'volume' }]);
    assert.equal((await call(admin, 'PUT', `/integrations/${relay.id}`, { scheduleMin: 15 })).status, 400);
    const gen = await connector({ category: 'ACD', preset: 'NICE_CXONE', name: `NICE ${RUN}`, config: { clientId: 'a', clientSecret: 'b', cluster: 'na1' } });
    assert.equal(gen.canPull, false); assert.match(gen.note, /not available yet/);
    assert.equal((await call(admin, 'PUT', `/integrations/${gen.id}`, { scheduleMin: 15 })).status, 400);
    ctx.relay = relay;
  });

  it('records a delivery pushed by the source as a run too', async () => {
    const r = await call(null, 'POST', `/integrations/${ctx.relay.id}/live`, { rows: [{ queueId, day: today, time: '10:00', volume: 5 }] }, { Authorization: `Bearer ${ctx.relay.apiKey}` });
    assert.equal(r.status, 200, r.text);
    const h = await call(admin, 'GET', `/integrations/${ctx.relay.id}/runs`);
    assert.equal(h.json.runs.length, 1); assert.equal(h.json.runs[0].trigger, 'PUSH'); assert.equal(h.json.runs[0].kind, 'LIVE');
  });

  it('runs a scheduled connector on its own when it is due', async () => {
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleMin: 5 })).status, 200);
    const list = (await call(admin, 'GET', '/integrations')).json.find((x: any) => x.id === ctx.sftp);
    assert.equal(list.scheduleMin, 5); assert.ok(list.nextRunAt);
    const before = (await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`)).json.runs.length;
    const c = db(); await c.connect(); await c.query("UPDATE integration_connectors SET next_run_at = now() - interval '1 minute' WHERE id = $1", [ctx.sftp]); await c.end();
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) { await new Promise((ok) => setTimeout(ok, 1500)); after = (await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`)).json.runs.length; }
    assert.equal(after, before + 1, 'the scheduler ran it');
    const h = (await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`)).json.runs[0];
    assert.equal(h.trigger, 'SCHEDULE');
    const next = (await call(admin, 'GET', '/integrations')).json.find((x: any) => x.id === ctx.sftp).nextRunAt;
    assert.ok(new Date(next).getTime() > Date.now() + 3 * 60_000, 'the next run moved on');
    assert.equal((await call(admin, 'GET', '/data/ingest/status')).json.connectors.find((x: any) => x.id === ctx.sftp).state, 'HEALTHY');
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleMin: null })).status, 200);
  });

  const orgTz = async () => { const c = db(); await c.connect(); try { return (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0].timezone as string; } finally { await c.end(); } };
  const WEEKDAYS = [1, 2, 3, 4, 5];

  it('saves a time of day and weekdays, and works out the next run on the organisation clock', async () => {
    const r = await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleAt: '02:00', scheduleDays: WEEKDAYS });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scheduleMin, 1440); assert.equal(r.json.scheduleAt, '02:00'); assert.deepEqual(r.json.scheduleDays, WEEKDAYS);
    const expected = firstRunAt({ everyMin: 1440, at: '02:00', days: WEEKDAYS }, new Date(), await orgTz());
    assert.equal(new Date(r.json.nextRunAt).toISOString(), expected.toISOString());
    const s = (await call(admin, 'GET', '/data/ingest/status')).json;
    const row = s.connectors.find((x: any) => x.id === ctx.sftp);
    assert.equal(row.scheduleAt, '02:00'); assert.deepEqual(row.scheduleDays, WEEKDAYS); assert.equal(typeof s.timezone, 'string');
  });

  it('refuses a schedule that makes no sense', async () => {
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleAt: '25:00' })).status, 400);
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleAt: '2:00' })).status, 400);
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleMin: 15, scheduleDays: [] })).status, 400);
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleMin: 15, scheduleDays: [8] })).status, 400);
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.relay.id}`, { scheduleAt: '02:00' })).status, 400, 'a source that sends to us cannot be scheduled');
  });

  it('does not call a weekday-only source late over a weekend it was never meant to run', async () => {
    const c = db(); await c.connect();
    try {
      await c.query("UPDATE integration_runs SET started_at = now() - interval '70 hours' WHERE connector_id = $1", [ctx.sftp]);
      const state = async () => (await call(admin, 'GET', '/data/ingest/status')).json.connectors.find((x: any) => x.id === ctx.sftp).state;
      assert.equal(await state(), 'HEALTHY', 'Friday evening to Monday morning is a normal gap');
      assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleAt: '02:00', scheduleDays: null })).status, 200);
      await c.query("UPDATE integration_runs SET started_at = now() - interval '70 hours' WHERE connector_id = $1", [ctx.sftp]);
      assert.equal(await state(), 'LATE', 'the same silence on a every-day schedule means a missed run');
    } finally { await c.end(); }
  });

  it('runs a daily connector when it is due and moves it to its next day and time', async () => {
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleAt: '02:00', scheduleDays: WEEKDAYS })).status, 200);
    const before = (await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`)).json.runs.length;
    const c = db(); await c.connect(); await c.query("UPDATE integration_connectors SET next_run_at = now() - interval '1 minute' WHERE id = $1", [ctx.sftp]); await c.end();
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) { await new Promise((ok) => setTimeout(ok, 1500)); after = (await call(admin, 'GET', `/integrations/${ctx.sftp}/runs`)).json.runs.length; }
    assert.equal(after, before + 1, 'the scheduler ran it');
    const next = (await call(admin, 'GET', '/integrations')).json.find((x: any) => x.id === ctx.sftp).nextRunAt;
    const expected = nextRunAfter({ everyMin: 1440, at: '02:00', days: WEEKDAYS }, new Date(), await orgTz());
    assert.equal(new Date(next).toISOString(), expected.toISOString());
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx.sftp}`, { scheduleMin: null })).json.scheduleAt, null, 'clearing the interval clears the whole schedule');
  });

  it('lists only forecast history sources on the Data Feeds page, each with its kind and next step', async () => {
    const hr = await connector({ category: 'HRMS', preset: 'GENERIC_HRMS_API', name: `HR only ${RUN}`, config: { apiKey: 'k', baseUrl: 'http://127.0.0.1:1' } });
    const db = await call(admin, 'POST', '/integrations', { category: 'DATABASE', preset: 'DATABASE_POSTGRES_PULL', name: `DB kind ${RUN}`, config: { host: 'h', database: 'd', username: 'u', password: 'p', query: 'SELECT 1' } });
    assert.equal(db.status, 201, db.text);
    const list = (await call(admin, 'GET', '/data/ingest/status')).json.connectors;
    assert.ok(!list.some((x: any) => x.id === hr.id), 'an HR connector is not forecast history');
    assert.ok(list.some((x: any) => x.id === ctx.sftp) && list.some((x: any) => x.id === ctx.relay.id), 'file and script sources are');
    const mine = list.find((x: any) => x.id === db.json.id);
    assert.equal(mine.kind, 'DATABASE'); assert.match(mine.nextStep, /Active/, 'a draft source is told to start');
    await call(admin, 'PUT', `/integrations/${db.json.id}`, { status: 'ACTIVE' });
    const active = (await call(admin, 'GET', '/data/ingest/status')).json.connectors.find((x: any) => x.id === db.json.id);
    assert.match(active.nextStep, /load history/i);
    assert.equal(list.find((x: any) => x.id === ctx.relay.id).kind, 'PUSH');
  });

  it('takes a schedule when the connector is created, and says which providers can be scheduled', async () => {
    const made = await call(admin, 'POST', '/integrations', { category: 'SFTP', preset: 'GENERIC_SFTP', name: `Sched on create ${RUN}`, config: sftpConfig(), scheduleAt: '03:30', scheduleDays: [6, 7] });
    assert.equal(made.status, 201, made.text); assert.equal(made.json.scheduleAt, '03:30'); assert.deepEqual(made.json.scheduleDays, [6, 7]);
    assert.equal((await call(admin, 'POST', '/integrations', { category: 'ACD', preset: 'GENERIC_ACD_RELAY', name: `Relay sched ${RUN}`, config: {}, scheduleMin: 15 })).status, 400);
    const cat = (await call(admin, 'GET', '/integrations/catalog')).json;
    const find = (cat2: string, id: string) => cat[cat2].find((p: any) => p.id === id);
    assert.equal(find('DATABASE', 'DATABASE_POSTGRES_PULL').canPull, true);
    assert.equal(find('DATABASE', 'GENERIC_DATABASE').canPull, false);
    assert.equal(find('SFTP', 'GENERIC_SFTP').canPull, true);
    assert.equal(find('ACD', 'GENESYS_CLOUD').canPull, false);
  });
});

describe('database pull', { skip: !process.env.ADMIN_PASSWORD || !process.env.DATABASE_URL }, () => {
  let admin = ''; const queue = `Pg Voice ${RUN}`, half = `Pg Half ${RUN}`; const alias = `Alias Q ${RUN}`;
  const url = new URL(process.env.DATABASE_URL ?? 'postgres://x@localhost/x');
  const conn = (over: any = {}) => ({
    host: url.hostname, port: url.port || '5432', database: url.pathname.slice(1), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), ssl: 'off',
    query: `SELECT queue_name AS queue, to_char(d, 'YYYY-MM-DD') AS day, t AS time, offered AS volume, aht AS "ahtSec", abn AS abandoned FROM ext_interval_stats WHERE d BETWEEN {from} AND {to}`, ...over,
  });
  const create = async (name: string, config: any) => call(admin, 'POST', '/integrations', { category: 'DATABASE', preset: 'DATABASE_POSTGRES_PULL', name, config });
  const iso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const sql = async (text: string, params: unknown[] = []) => { const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: '-c search_path=wfm,public' }); await c.connect(); try { return (await c.query(text, params)).rows; } finally { await c.end(); } };
  const live = async (name: string) => (await sql('SELECT slot, volume FROM interval_history h JOIN queues q ON q.id = h.queue_id WHERE q.name = $1 ORDER BY day, slot', [name]));
  const activate = async (id: string) => assert.equal((await call(admin, 'PUT', `/integrations/${id}`, { status: 'ACTIVE' })).status, 200);
  const ctx2: Record<string, any> = {};

  before(async () => {
    const r = await call(null, 'POST', '/auth/login', { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD, tenant: TENANT });
    admin = r.json.token;
    const g = await call(admin, 'POST', '/config/groups', { name: `Pg ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 30, targetOccupancy: 88 });
    for (const name of [queue, half]) assert.equal((await call(admin, 'POST', '/config/queues', { name, channel: 'VOICE', ahtDefault: 300, wfmGroupId: g.json.id })).status, 201);
    await sql('DROP TABLE IF EXISTS public.ext_interval_stats');
    await sql('CREATE TABLE public.ext_interval_stats (queue_name text, d date, t text, offered int, aht int, abn int)');
    const rows: any[] = [];
    for (let n = 1; n <= 20; n++) for (const t of ['09:00', '09:15', '09:30', '09:45']) rows.push([queue, iso(n), t, 10 + n, 300, 1]);
    for (const t of ['09:00', '10:00']) rows.push([half, iso(1), t, 40, 300, 2]);          // hourly rows
    rows.push([alias, iso(1), '09:00', 7, 300, 0]);                                       // a name nobody has matched yet
    for (const r2 of rows) await sql('INSERT INTO public.ext_interval_stats VALUES ($1,$2,$3,$4,$5,$6)', r2);
  });
  after(async () => { await sql('DROP TABLE IF EXISTS public.ext_interval_stats'); });

  it('refuses a query that could change anything, when it is saved', async () => {
    for (const q of ['UPDATE ext_interval_stats SET offered = 0', 'SELECT 1; DELETE FROM ext_interval_stats']) {
      const r = await create(`Bad ${RUN}`, conn({ query: q })); assert.equal(r.status, 400, q); assert.match(r.text, /SELECT|semicolon/i);
    }
    assert.equal((await create(`Weeks ${RUN}`, conn({ backfillWeeks: '0' }))).status, 400);
  });

  it('tests the query without saving anything, and names what is wrong', async () => {
    const c = (await create(`Pg ${RUN}`, conn())).json; ctx2.c = c; assert.equal(c.canPull, true);
    await activate(c.id);
    const t = await call(admin, 'POST', `/integrations/${c.id}/test-pull`);
    assert.equal(t.status, 200, t.text); assert.ok(t.json.rowCount > 0); assert.deepEqual(t.json.columns.slice(0, 3), ['queue', 'day', 'time']);
    assert.ok(t.json.problems.some((p: string) => p.includes(alias)), t.text);
    assert.equal((await live(queue)).length, 0, 'a test saves nothing');
  });

  it('keeps recent days up to date: the last two days go live, matched by queue name, and unmatched names are reported', async () => {
    const r = await call(admin, 'POST', `/integrations/${ctx2.c.id}/run`, {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'PARTIAL', r.text); assert.match(r.json.message, new RegExp(`No queue match for '${alias}'`));
    assert.equal((await live(queue)).length, 8, 'two full days of four intervals');
    assert.equal(r.json.rowsOk, 10, 'the queue rows plus the hourly queue rows, which this connector reads as 15-minute');
  });

  it('loads history as a staged import for review, not straight to live', async () => {
    const before = (await sql('SELECT count(*)::int AS n FROM interval_history'))[0].n;
    const r = await call(admin, 'POST', `/integrations/${ctx2.c.id}/run`, { mode: 'backfill' });
    assert.equal(r.status, 200, r.text); assert.match(r.json.message, /Loaded \d+ rows from the last 8 weeks into 1 staged import/);
    assert.equal((await sql('SELECT count(*)::int AS n FROM interval_history'))[0].n, before, 'nothing live changed');
    const job = (await call(admin, 'GET', '/data/imports')).json.find((j: any) => /-history-/.test(j.fileName));
    assert.ok(job && job.status === 'READY', 'the history is waiting on Staged Ingestion'); assert.ok(job.validRecords >= 80);
    assert.equal((await call(admin, 'GET', `/integrations/${ctx2.c.id}`)).json.backfillStatus, 'IN_PROGRESS');
  });

  it('spreads hourly rows over four 15-minute slots', async () => {
    const c = (await create(`Pg hourly ${RUN}`, conn({ intervalMinutes: '60', query: `SELECT queue_name AS queue, to_char(d, 'YYYY-MM-DD') AS day, t AS time, offered AS volume FROM ext_interval_stats WHERE d BETWEEN {from} AND {to} AND queue_name = '${half}'` }))).json;
    await activate(c.id);
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`, {});
    assert.equal(r.json.status, 'OK', r.text);
    const rows = await live(half);
    assert.deepEqual(rows.map((x: any) => x.slot), [36, 37, 38, 39, 40, 41, 42, 43]); assert.ok(rows.every((x: any) => x.volume === 10));
  });

  it('cannot change the customer database even if the query tries to', async () => {
    await sql("CREATE OR REPLACE FUNCTION public.wipe_ext() RETURNS int LANGUAGE plpgsql AS $$ BEGIN DELETE FROM ext_interval_stats; RETURN 1; END $$");
    const attempts: [string, RegExp][] = [
      [`SELECT queue_name AS queue, 'x' AS day, 'y' AS time, public.wipe_ext() AS volume FROM ext_interval_stats`, /read-only/i],           // a function that writes
      [`WITH gone AS (DELETE FROM ext_interval_stats RETURNING *) SELECT queue_name AS queue, 'x' AS day, 'y' AS time, 1 AS volume FROM gone`, /data-modifying/i],   // a write hidden in a WITH
    ];
    const before = (await sql('SELECT count(*)::int AS n FROM ext_interval_stats'))[0].n;
    for (const [query, expected] of attempts) {
      const c = (await create(`Pg evil ${RUN} ${expected.source.length}`, conn({ query }))).json;
      await activate(c.id);
      const r = await call(admin, 'POST', `/integrations/${c.id}/run`, {});
      assert.equal(r.json.status, 'FAILED'); assert.match(r.json.message, expected);
    }
    assert.equal((await sql('SELECT count(*)::int AS n FROM ext_interval_stats'))[0].n, before, 'the table is untouched');
    await sql('DROP FUNCTION public.wipe_ext()');
  });

  it('refuses timestamps that would lose their time zone', async () => {
    const c = (await create(`Pg ts ${RUN}`, conn({ query: `SELECT queue_name AS queue, d::timestamp AS day, t AS time, offered AS volume FROM ext_interval_stats WHERE d BETWEEN {from} AND {to}` }))).json;
    await activate(c.id);
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`, {});
    assert.equal(r.json.status, 'FAILED'); assert.match(r.json.message, /to_char/);
  });

  it('says plainly when the database cannot be reached', async () => {
    const c = (await create(`Pg down ${RUN}`, conn({ port: String(await freePort()) }))).json;
    await activate(c.id);
    const r = await call(admin, 'POST', `/integrations/${c.id}/run`, {});
    assert.equal(r.json.status, 'FAILED'); assert.match(r.json.message, /Could not connect to/);
  });

  it('can be scheduled like the other pulled sources', async () => {
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx2.c.id}`, { scheduleMin: 15 })).status, 200);
    assert.equal((await call(admin, 'PUT', `/integrations/${ctx2.c.id}`, { scheduleMin: null })).status, 200);
  });
});
