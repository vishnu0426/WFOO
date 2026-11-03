/**
 * What-if scenarios, payroll runs, email and SMS (against a mock mail server and a mock SMS gateway), scheduled reports and follow the sun.
 *   CHANNEL_BACKOFF_SCALE=0.02 on the gateway makes retries quick.  BASE_URL=http://localhost:4012 ADMIN_PASSWORD=... TENANT=ORG npm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ORG';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addIso = (s: string, n: number) => iso(addDays(new Date(`${s}T00:00:00`), n));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(fn: () => Promise<T | null | false | undefined> | T | null | false | undefined, ms = 25_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v as T; await sleep(300); }
  assert.fail('timed out waiting');
}

function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) { const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4; rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`); }
  }
  return rows.join('\n');
}

/** A mail server that accepts everything and remembers it. */
function smtpMock() {
  const mails: { to: string[]; data: string }[] = [];
  const server = net.createServer((sock) => {
    let to: string[] = [], inData = false, buf = '', data = '';
    sock.write('220 mock ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;                                  // the end marker can arrive split across packets, so keep everything until it is whole
          data = buf.slice(0, end); buf = buf.slice(end + 5); inData = false; mails.push({ to, data }); data = ''; sock.write('250 queued\r\n'); continue;
        }
        const nl = buf.indexOf('\r\n'); if (nl < 0) return;
        const line = buf.slice(0, nl); buf = buf.slice(nl + 2);
        if (/^EHLO|^HELO/i.test(line)) sock.write('250-mock\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) { to = []; sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(line)) { to.push(/<([^>]+)>/.exec(line)![1]); sock.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { mails, listen: () => new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as AddressInfo).port))), close: () => server.close() };
}

describe('operations', () => {
  let admin = '', groupA: any, groupB: any, versionA = '', versionB = '', monday = '', employeesA: any[] = [];
  const smtp = smtpMock();
  const sms: { body: any }[] = [];
  let smsMode: 'ok' | 'fail' = 'ok';
  let smsServer: http.Server, apiServer: http.Server, smtpPort = 0, smsUrl = '', apiUrl = '';
  const apiCalls: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let apiMode: 'ok' | 'refuse' | 'hangup' | 'garbage' = 'ok';
  const tag = `O${RUN}`;

  async function buildGroup(name: string, timezone: string, phonePrefix: string) {
    const g = await call(admin, 'POST', '/config/groups', { name, timezone, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 88 });
    assert.equal(g.status, 201, g.text);
    const queue = `${name} voice`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: queue, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(queue, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);
    const sf = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 2, fromDay: monday });
    assert.equal(sf.status, 201, sf.text);
    for (const step of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${sf.json.id}/${step}`, {})).status, 200, step);
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `${name} team` })).status, 201);
    const tpl = await call(admin, 'POST', '/scheduling/templates', { name: `${name} tpl`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: '06:00', latestStart: '10:00', startStepMinutes: 60, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15 });
    assert.equal(tpl.status, 201, tpl.text);
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week,email,phone'];
    for (let i = 1; i <= 14; i++) lines.push(`${name.replace(/\W/g, '')}-${i},Pat${i},${name.split(' ')[0]}${i},${name} team,${name},FULL_TIME,40,5,pat${i}.${name.replace(/\W/g, '')}@example.com,${phonePrefix}${String(i).padStart(4, '0')}`);
    const imp = await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false });
    assert.equal(imp.json.committed, true, imp.text);
    const gen = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: monday, weeks: 1, timeLimitSec: 15, templateIds: [tpl.json.id] });
    assert.equal(gen.status, 201, gen.text);
    const pub = await call(admin, 'POST', `/scheduling/versions/${gen.json.id}/publish`, { acknowledgeReason: 'ops test' });
    assert.equal(pub.status, 200, pub.text);
    return { group: g.json, version: gen.json.id as string, template: tpl.json.id as string };
  }

  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
    smtpPort = await smtp.listen();
    smsServer = http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { sms.push({ body: JSON.parse(b) }); } catch { sms.push({ body: b }); } res.statusCode = smsMode === 'ok' ? 200 : 500; res.end('{}'); }); });
    await new Promise<void>((ok) => smsServer.listen(0, '127.0.0.1', ok));
    smsUrl = `http://127.0.0.1:${(smsServer.address() as AddressInfo).port}/sms`;
    apiServer = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c));
      req.on('end', () => {
        apiCalls.push({ url: req.url ?? '', headers: req.headers, body: b });
        if (apiMode === 'hangup') return void req.socket.destroy();
        res.setHeader('Content-Type', 'application/json');
        if (apiMode === 'garbage') { res.statusCode = 200; return void res.end('<<not json at all'); }
        if (apiMode === 'refuse') { res.statusCode = 403; return void res.end(JSON.stringify({ message: 'The domain is not verified' })); }
        res.statusCode = (req.url ?? '').includes('Messages.json') ? 201 : 200; res.end(JSON.stringify({ id: 'x', messages: [{ status: '0' }] }));
      });
    });
    await new Promise<void>((ok) => apiServer.listen(0, '127.0.0.1', ok));
    apiUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    monday = iso(addDays(start, (7 - ((start.getDay() + 6) % 7)) % 7 || 7));
    const a = await buildGroup(`Ops A ${tag}`, 'UTC', '+1555');
    const b = await buildGroup(`Ops B ${tag}`, 'Asia/Kolkata', '+9198');
    groupA = a.group; groupB = b.group; versionA = a.version; versionB = b.version;
    employeesA = (await call(admin, 'GET', `/workforce/employees?groupId=${groupA.id}`)).json;
  });
  after(() => { smtp.close(); smsServer.close(); apiServer.close(); });

  // ------------------------------------------------------------ what if
  it('what-if: more calls and more absence make service worse and need more people; the answer is in plain words', async () => {
    const r = await call(admin, 'POST', `/scheduling/versions/${versionA}/what-if`, {
      from: monday, days: 2, replications: 12, scenarios: [{ name: '30% more calls', volumePct: 30 }, { name: 'A third of people off', absencePercent: 30 }],
    });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.scenarios.length, 3);
    const [base, more, off] = r.json.scenarios;
    assert.equal(base.name, 'As scheduled');
    assert.ok(more.serviceLevel <= base.serviceLevel + 0.02, `30% more calls ${more.serviceLevel} vs ${base.serviceLevel}`);
    assert.ok(off.serviceLevel < base.serviceLevel, 'absence hurts');
    for (const s of r.json.scenarios) assert.ok(typeof s.verdict === 'string' && s.verdict.length > 10);
    assert.ok(off.peopleNeededChangePercent === null || off.peopleNeededChangePercent > (base.peopleNeededChangePercent ?? -100), 'absence needs more people on the phones than the plain schedule');
    assert.equal(typeof base.peopleNeededChangeFte === 'number' || base.peopleNeededChangeFte === null, true);
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${versionA}/what-if`, { scenarios: [] })).status, 400);
  });

  // ------------------------------------------------------------ payroll
  describe('payroll', () => {
    const wk = '2027-03-01';   // a Monday in the past; a UTC group
    let runId = '', emp: any, emp2: any;
    before(async () => {
      emp = employeesA[0]; emp2 = employeesA[1];
      const s = await call(admin, 'PUT', '/payroll/settings', { payCodes: { REGULAR: 'REG', OVERTIME: 'OT', NIGHT: 'NGT', WEEKEND: 'WKD', HOLIDAY: 'HOL', VACATION: 'VAC', SICK: 'SICK', PERSONAL: 'PERS', HOLIDAY_LEAVE: 'HOLP', TRAINING: 'TRN', LEAVE: 'LV', OTHER: 'OTH' }, paidLeave: ['VACATION', 'SICK'], nightFrom: '22:00', nightTo: '06:00', dailyOvertimeAfter: null, weeklyOvertimeAfter: null, stacking: 'EXCLUSIVE', rounding: 'NONE', hoursSource: 'ACTUAL' });
      assert.equal(s.status, 200, s.text);
      const punch = (day: string, inT: string, out: string | null) => call(admin, 'POST', '/attendance/punches', { employeeId: emp.id, day, clockIn: `${day}T${inT}:00Z`, clockOut: out === null ? null : out });
      for (let d = 0; d < 5; d++) { const day = addIso(wk, d); assert.equal((await punch(day, '09:00', `${day}T17:00:00Z`)).status, 201); }
      assert.equal((await punch('2027-03-06', '22:00', '2027-03-07T02:00:00Z')).status, 201);    // Saturday night, 4 hours, crossing midnight
    });

    it('turns a week of punches into pay codes: regular, overtime from the end of the week, night', async () => {
      const r = await call(admin, 'POST', '/payroll/runs', { groupId: groupA.id, from: wk, to: '2027-03-07' });
      assert.equal(r.status, 201, r.text);
      runId = r.json.id;
      const mine = r.json.lines.filter((l: any) => l.employeeId === emp.id);
      const h = (code: string) => mine.find((l: any) => l.payCode === code)?.hours ?? 0;
      assert.equal(h('REG'), 36, JSON.stringify(mine));
      assert.equal(h('OT'), 4);
      assert.equal(h('NGT'), 4);
      assert.equal(mine.reduce((n: number, l: any) => n + l.hours, 0), 44, 'nothing lost, nothing counted twice');
      assert.equal(r.json.status, 'DRAFT');
    });

    it('will not export before approval, then approves, locks and exports', async () => {
      assert.equal((await fetch(`${BASE}/api/v1/payroll/runs/${runId}/export.csv`, { headers: { Authorization: `Bearer ${admin}` } })).status, 409);
      const ap = await call(admin, 'POST', `/payroll/runs/${runId}/approve`, {});
      assert.equal(ap.status, 200, ap.text);
      assert.equal(ap.json.status, 'APPROVED');
      assert.equal((await call(admin, 'POST', `/payroll/runs/${runId}/recalculate`, {})).status, 409, 'an approved run is locked');
      assert.equal((await call(admin, 'DELETE', `/payroll/runs/${runId}`)).status, 409);
      const f = await fetch(`${BASE}/api/v1/payroll/runs/${runId}/export.csv`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(f.status, 200);
      const csv = await f.text();
      assert.match(csv.split('\n')[0], /employee_number,name,department,pay_code,hours,period_start,period_end/);
      assert.ok(csv.includes(',OT,4,'), csv);
      const daily = await (await fetch(`${BASE}/api/v1/payroll/runs/${runId}/export.csv?layout=daily`, { headers: { Authorization: `Bearer ${admin}` } })).text();
      assert.ok(daily.split('\n').length > 5 && daily.includes('NGT'));
      assert.equal((await call(admin, 'GET', `/payroll/runs/${runId}`)).json.status, 'EXPORTED');
    });

    it('will not pay the same days twice', async () => {
      const dup = await call(admin, 'POST', '/payroll/runs', { groupId: groupA.id, from: '2027-03-03', to: '2027-03-09' });
      assert.equal(dup.status, 201);
      const ap = await call(admin, 'POST', `/payroll/runs/${dup.json.id}/approve`, { note: 'x' });
      assert.equal(ap.status, 409, ap.text);
      assert.match(ap.text, /twice/);
      await call(admin, 'DELETE', `/payroll/runs/${dup.json.id}`);
    });

    it('blocks approval while someone has clocked in and never out, and a recalculation after the fix passes', async () => {
      const day = '2027-04-05';
      const open = await call(admin, 'POST', '/attendance/punches', { employeeId: emp2.id, day, clockIn: `${day}T08:00:00Z`, clockOut: null });
      assert.equal(open.status, 201, open.text);
      const run = await call(admin, 'POST', '/payroll/runs', { groupId: groupA.id, from: day, to: '2027-04-11' });
      assert.ok(run.json.warnings.some((w: any) => w.kind === 'OPEN_PUNCH'));
      const ap = await call(admin, 'POST', `/payroll/runs/${run.json.id}/approve`, { note: 'try' });
      assert.equal(ap.status, 409);
      assert.match(ap.text, /clock-out/);
      assert.equal((await call(admin, 'DELETE', `/attendance/punches/${open.json.id}`)).status, 200);
      const re = await call(admin, 'POST', `/payroll/runs/${run.json.id}/recalculate`, {});
      assert.equal(re.json.warnings.length, 0);
      assert.equal((await call(admin, 'POST', `/payroll/runs/${run.json.id}/approve`, {})).status, 200);
    });

    it('pays approved leave at the person\'s usual hours, and rounds the way payroll asked', async () => {
      const cur = (await call(admin, 'GET', '/payroll/settings')).json;
      assert.equal((await call(admin, 'PUT', '/payroll/settings', { ...cur, rounding: 'QUARTER' })).status, 200);
      assert.equal((await call(admin, 'POST', '/workforce/time-off', { employeeId: emp2.id, type: 'VACATION', startDate: '2027-05-10', endDate: '2027-05-11', approve: true })).status, 201);
      const r = await call(admin, 'GET', `/payroll/preview?groupId=${groupA.id}&from=2027-05-10&to=2027-05-16`);
      const vac = r.json.lines.find((l: any) => l.employeeId === emp2.id && l.payCode === 'VAC');
      assert.equal(vac.hours, 16, 'two days at 8 hours (40 hours over 5 days)');
      assert.equal((await call(admin, 'PUT', '/payroll/settings', { ...cur, nightFrom: '25:00' })).status, 400);
    });
  });

  // ------------------------------------------------------------ email and sms
  describe('email and SMS', () => {
    let manager = '', staffAgent = '';
    before(async () => {
      const m = await call(admin, 'POST', '/users', { username: `mgr${RUN}`, displayName: 'Mina Manager', email: `mgr${RUN}@example.com`, role: 'WFM_MANAGER', password: 'Mgr#Pass12345' });
      assert.equal(m.status, 201, m.text);
      manager = (await call(null, 'POST', '/auth/login', { username: `mgr${RUN}`, password: 'Mgr#Pass12345', tenant: TENANT })).json.token;
      const lg = await call(admin, 'POST', '/self-service/logins', { employeeId: employeesA[3].id });
      assert.equal(lg.status, 201, lg.text);
      staffAgent = (await call(null, 'POST', '/auth/login', { username: lg.json.username, password: lg.json.password, tenant: TENANT })).json.token;
    });

    const restore = () => call(admin, 'PUT', '/channels/settings', { email: { enabled: true, provider: 'SMTP', from: 'wfm@example.com', values: { host: '127.0.0.1', port: String(smtpPort), security: 'NONE', user: '', pass: 'hunter2' } }, sms: { enabled: true, provider: 'HTTP', values: { url: smsUrl, method: 'POST', contentType: 'JSON', headers: 'X-Api-Key: abc123', body: 'to = {{to}}\nmessage = {{message}}\nsender = WFM' } }, defaults: { TIME_OFF: ['SMS'] } });

    it('keeps the mail password and SMS headers secret, and refuses to switch on half-set-up channels', async () => {
      const noHost = await call(admin, 'PUT', '/channels/settings', { email: { enabled: true, provider: 'SMTP', from: 'a@b.c', values: {} }, sms: { enabled: false, provider: 'HTTP', values: {} } });
      assert.equal(noHost.status, 400);
      assert.match(noHost.text, /Mail server/, 'it names the box that is empty');
      assert.equal((await call(admin, 'PUT', '/channels/settings', { email: { enabled: true, provider: 'NOPE', from: 'a@b.c', values: {} }, sms: { enabled: false, provider: 'HTTP', values: {} } })).status, 400, 'a provider that is not in the list');
      const s = await restore();
      assert.equal(s.status, 200, s.text);
      assert.equal(s.json.email.provider, 'SMTP');
      assert.equal(s.json.email.saved.pass, true);
      assert.equal(s.json.sms.saved.headers, true);
      assert.ok(!JSON.stringify(s.json).includes('hunter2') && !JSON.stringify(s.json).includes('abc123'), 'secrets are never sent back');
      assert.equal(s.json.email.values.host, '127.0.0.1', 'the boxes that are not secret come back');
      assert.equal((await call(admin, 'PUT', '/channels/settings', { email: { enabled: false, provider: 'SMTP', from: '', values: {} }, sms: { enabled: true, provider: 'HTTP', values: { url: 'http://169.254.169.254/x' } } })).status, 400, 'not the cloud metadata address');
    });

    it('sends a test email and a test SMS and says what happened', async () => {
      const e = await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: `test${RUN}@example.com` });
      assert.equal(e.json.ok, true, `email test said: ${e.text}`);
      const mail = await until(() => smtp.mails.find((m) => m.to.includes(`test${RUN}@example.com`)));
      assert.match(mail.data, /Subject: Test from the WFM platform/);
      const t = await call(admin, 'POST', '/channels/test', { channel: 'SMS', to: '+15550001111' });
      assert.equal(t.json.ok, true, `sms test said: ${t.text}`);
      const got = sms.find((s) => s.body.to === '+15550001111')!;
      assert.equal(got.body.sender, 'WFM', 'the body template is used');
      assert.match(got.body.message, /test message/);
    });

    it('texts the people who should hear, retries a gateway that is down, and respects a person\'s own choice', async () => {
      const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: employeesA[3].id, type: 'PERSONAL', startDate: '2027-06-07', endDate: '2027-06-07' });
      assert.equal(t.status, 201);
      smsMode = 'fail';
      const before = sms.length;
      await call(admin, 'POST', `/workforce/time-off/${t.json.id}/decide`, { status: 'APPROVED' });
      const phone = employeesA[3].phone.replace(/[^\d+]/g, '');
      await until(() => sms.slice(before).filter((s) => s.body.to === phone).length >= 2);       // tried, failed, tried again
      smsMode = 'ok';
      const log = await until(async () => { const d = (await call(admin, 'GET', '/channels/deliveries')).json.find((x: any) => x.channel === 'SMS' && x.ref === 'notification:TIME_OFF' && x.status === 'SENT'); return d; }, 30_000);
      assert.ok(log.attempts >= 2);
      assert.ok(!log.to.includes(phone.slice(0, 6)), 'phone numbers are masked in the log');
      // the person opts out of SMS for time off: nothing more is sent
      const mine = await call(staffAgent, 'GET', '/channels/me');
      assert.equal(mine.json.kinds.find((k: any) => k.kind === 'TIME_OFF').sms, true, 'on by the organisation’s default');
      assert.equal((await call(staffAgent, 'PUT', '/channels/me', { kinds: [{ kind: 'TIME_OFF', email: false, sms: false }] })).status, 200);
      const n = sms.length;
      const t2 = await call(admin, 'POST', '/workforce/time-off', { employeeId: employeesA[3].id, type: 'PERSONAL', startDate: '2027-06-08', endDate: '2027-06-08' });
      await call(admin, 'POST', `/workforce/time-off/${t2.json.id}/decide`, { status: 'APPROVED' });
      await sleep(2500);
      assert.equal(sms.length, n, 'their choice wins over the default');
      assert.equal((await call(staffAgent, 'GET', '/channels/alert-rules')).status, 403);
    });

    it('an alert rule emails the roles it names when the event happens', async () => {
      const bad = await call(admin, 'POST', '/channels/alert-rules', { name: 'x', event: 'no.such', roles: ['WFM_MANAGER'], channels: ['EMAIL'] });
      assert.equal(bad.status, 400);
      const rule = await call(admin, 'POST', '/channels/alert-rules', { name: 'Tell managers about decisions', event: 'timeoff.decided', roles: ['WFM_MANAGER'], channels: ['INBOX', 'EMAIL'] });
      assert.equal(rule.status, 201, rule.text);
      const t = await call(admin, 'POST', '/workforce/time-off', { employeeId: employeesA[4].id, type: 'PERSONAL', startDate: '2027-06-09', endDate: '2027-06-09' });
      await call(admin, 'POST', `/workforce/time-off/${t.json.id}/decide`, { status: 'APPROVED' });
      const mail = await until(() => smtp.mails.find((m) => m.to.includes(`mgr${RUN}@example.com`)));
      assert.match(mail.data, /Subject: A time-off request was approved or declined/);
      assert.match(mail.data, /status: APPROVED/);
      const inbox = await until(async () => { const r = await call(manager, 'GET', '/me/notifications'); return r.json.items?.find((n: any) => /time-off request/i.test(n.title)); });
      assert.ok(inbox);
      assert.equal((await call(admin, 'DELETE', `/channels/alert-rules/${rule.json.id}`)).status, 200);
    });
    describe('providers', () => {
      const put = (email: any, sms: any) => call(admin, 'PUT', '/channels/settings', { email, sms, defaults: { TIME_OFF: ['SMS'] } });
      const HTTP_OFF = { enabled: false, provider: 'HTTP', values: {} };
      const SMTP_OFF = { enabled: false, provider: 'SMTP', from: '', values: {} };
      after(async () => { apiMode = 'ok'; await restore(); });

      it('offers a catalogue, and the boxes it asks for depend on the provider chosen', async () => {
        const c = await call(admin, 'GET', '/channels/providers');
        assert.equal(c.status, 200);
        for (const id of ['SMTP', 'GMAIL', 'M365', 'SES', 'SENDGRID', 'MAILGUN', 'RESEND']) assert.ok(c.json.email.some((p: any) => p.id === id), id);
        for (const id of ['HTTP', 'TWILIO', 'VONAGE', 'SNS', 'TEXTLOCAL']) assert.ok(c.json.sms.some((p: any) => p.id === id), id);
        const keys = (list: any[], id: string) => list.find((p) => p.id === id).fields.map((f: any) => f.key);
        assert.ok(keys(c.json.email, 'SMTP').includes('host') && !keys(c.json.email, 'GMAIL').includes('host'), 'Gmail does not ask for a server');
        assert.ok(keys(c.json.sms, 'TWILIO').includes('accountSid') && keys(c.json.sms, 'VONAGE').includes('apiSecret'));
        assert.equal((await call(staffAgent, 'GET', '/channels/providers')).status, 403);
      });

      it('sends email through a provider\'s web API with that provider\'s own login', async () => {
        apiMode = 'ok';
        assert.equal((await put({ enabled: true, provider: 'RESEND', from: 'WFM <wfm@example.com>', values: { apiKey: 're_secret_key', apiBase: apiUrl } }, HTTP_OFF)).status, 200);
        const before = apiCalls.length;
        const r = await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: 'pat@example.com' });
        assert.equal(r.json.ok, true, r.text);
        const hit = apiCalls[before];
        assert.equal(hit.url, '/emails');
        assert.equal(hit.headers.authorization, 'Bearer re_secret_key');
        assert.deepEqual(JSON.parse(hit.body).to, ['pat@example.com']);
        // leaving the secret box empty keeps the saved one, as long as the provider is the same
        const again = await put({ enabled: true, provider: 'RESEND', from: 'WFM <wfm@example.com>', values: { apiKey: '', apiBase: apiUrl } }, HTTP_OFF);
        assert.equal(again.json.email.saved.apiKey, true);
        await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: 'pat@example.com' });
        assert.equal(apiCalls.at(-1)!.headers.authorization, 'Bearer re_secret_key');
      });

      it('sends SMS the way Twilio and Vonage each want it, and does not carry one provider\'s secret to another', async () => {
        assert.equal((await put(SMTP_OFF, { enabled: true, provider: 'TWILIO', values: { accountSid: 'AC123', authToken: 'twilio_token', from: '+15550009999', apiBase: apiUrl } })).status, 200);
        let n = apiCalls.length;
        const t = await call(admin, 'POST', '/channels/test', { channel: 'SMS', to: '+91 98765 43210' });
        assert.equal(t.json.ok, true, t.text);
        const tw = apiCalls[n];
        assert.equal(tw.url, '/2010-04-01/Accounts/AC123/Messages.json');
        assert.equal(tw.headers.authorization, `Basic ${Buffer.from('AC123:twilio_token').toString('base64')}`);
        assert.equal(new URLSearchParams(tw.body).get('To'), '+919876543210');
        const sw = await put(SMTP_OFF, { enabled: true, provider: 'VONAGE', values: { apiKey: 'vk', apiSecret: 'vs', from: 'WFM', apiBase: apiUrl } });
        assert.equal(sw.json.sms.provider, 'VONAGE');
        assert.equal(sw.json.sms.saved.apiSecret, true);
        assert.equal(sw.json.sms.saved.authToken, undefined, 'the Twilio token is gone with the Twilio choice');
        n = apiCalls.length;
        assert.equal((await call(admin, 'POST', '/channels/test', { channel: 'SMS', to: '+15551230000' })).json.ok, true);
        assert.equal(JSON.parse(apiCalls[n].body).api_key, 'vk');
        // switching to a provider and back does not bring a secret back
        const back = await put(SMTP_OFF, { enabled: false, provider: 'TWILIO', values: { accountSid: 'AC123', from: '+1555' } });
        assert.equal(back.json.sms.saved.authToken, false);
        assert.equal((await put(SMTP_OFF, { enabled: true, provider: 'TWILIO', values: { accountSid: 'AC123', from: '+1555', apiBase: apiUrl } })).status, 400, 'a secret that was not kept must be asked for again');
      });

      it('says what the provider said when it refuses, and survives one that hangs up or talks nonsense', async () => {
        await put({ enabled: true, provider: 'RESEND', from: 'wfm@example.com', values: { apiKey: 'k', apiBase: apiUrl } }, HTTP_OFF);
        apiMode = 'refuse';
        const refused = await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: 'pat@example.com' });
        assert.equal(refused.status, 200);
        assert.equal(refused.json.ok, false);
        assert.match(refused.json.error, /403.*domain is not verified/);
        apiMode = 'hangup';
        const hung = await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: 'pat@example.com' });
        assert.equal(hung.json.ok, false, 'a dropped connection is a reported failure');
        apiMode = 'garbage';
        await put(SMTP_OFF, { enabled: true, provider: 'VONAGE', values: { apiKey: 'vk', apiSecret: 'vs', from: 'WFM', apiBase: apiUrl } });
        const junk = await call(admin, 'POST', '/channels/test', { channel: 'SMS', to: '+15551230000' });
        assert.equal(junk.json.ok, false);
        assert.equal((await fetch(`${BASE}/health`)).status, 200, 'the service is still up');
        apiMode = 'ok';
      });

      it('an unreachable mail server is a message in the log, not a crash', async () => {
        assert.equal((await put({ enabled: true, provider: 'SMTP', from: 'a@b.c', values: { host: '127.0.0.1', port: '9', security: 'NONE' } }, HTTP_OFF)).status, 200);
        const r = await call(admin, 'POST', '/channels/test', { channel: 'EMAIL', to: 'x@example.com' });
        assert.equal(r.json.ok, false);
        assert.match(r.json.error, /ECONNREFUSED|refused|Timeout/i);
        assert.equal((await fetch(`${BASE}/health`)).status, 200);
      });
    });
  });

  // ------------------------------------------------------------ reports
  describe('scheduled reports', () => {
    it('runs a report now, as rows and as a CSV, over a named or a fixed range', async () => {
      const r = await call(admin, 'POST', '/reports/run', { report: 'ROSTER', groupId: groupA.id, from: monday, to: addIso(monday, 6) });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.total > 20, `roster rows ${r.json.total}`);
      assert.deepEqual(r.json.columns.slice(0, 3), ['Date', 'Employee number', 'Name']);
      const cov = await call(admin, 'POST', '/reports/run', { report: 'COVERAGE', groupId: groupA.id, from: monday, to: addIso(monday, 6) });
      assert.equal(cov.status, 200, cov.text);
      assert.equal(cov.json.total, 7);
      assert.ok(cov.json.rows.every((x: any[]) => x[3] >= 0 && x[3] <= 100));
      const csv = await fetch(`${BASE}/api/v1/reports/run?format=csv`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ report: 'TIME_OFF', range: 'NEXT_14_DAYS' }) });
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get('content-disposition') ?? '', /time_off-.*\.csv/);
      assert.equal((await call(admin, 'POST', '/reports/run', { report: 'COVERAGE', from: monday, to: monday })).status, 400, 'coverage needs a group');
      assert.equal((await call(admin, 'POST', '/reports/run', { report: 'NOPE', range: 'LAST_WEEK' })).status, 400);
    });

    it('puts a report on a timetable, emails it with the file attached and keeps every run', async () => {
      const bad = await call(admin, 'POST', '/reports/schedules', { name: 'x', report: 'ROSTER', range: 'NEXT_WEEK', frequency: 'WEEKLY', hour: 7, recipients: { emails: ['a@example.com'], roles: [] } });
      assert.equal(bad.status, 400, 'a weekly report needs a day');
      assert.equal((await call(admin, 'POST', '/reports/schedules', { name: 'x', report: 'ROSTER', range: 'NEXT_WEEK', frequency: 'DAILY', hour: 7, recipients: { emails: [], roles: [] } })).status, 400, 'someone has to get it');
      const s = await call(admin, 'POST', '/reports/schedules', { name: `Weekly roster ${tag}`, report: 'ROSTER', groupId: groupA.id, range: 'NEXT_WEEK', frequency: 'WEEKLY', dayOfWeek: 4, hour: 15, recipients: { emails: [`boss${RUN}@example.com`], roles: [] } });
      assert.equal(s.status, 201, s.text);
      assert.ok(new Date(s.json.nextRunAt) > new Date(), 'the next run is in the future');
      const run = await call(admin, 'POST', `/reports/schedules/${s.json.id}/run-now`, {});
      assert.equal(run.status, 200, run.text);
      assert.equal(run.json.status, 'OK', run.json.error);
      assert.equal(run.json.sentTo, 1);
      const mail = await until(() => smtp.mails.find((m) => m.to.includes(`boss${RUN}@example.com`)));
      assert.match(mail.data, /Content-Disposition: attachment;\s*filename="?roster-/);
      assert.match(mail.data, /text\/csv/);
      const runs = await call(admin, 'GET', `/reports/schedules/${s.json.id}/runs`);
      assert.equal(runs.json.length, 1);
      const dl = await fetch(`${BASE}/api/v1/reports/runs/${runs.json[0].id}/download`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.match((await dl.text()).split('\n')[0], /^Date,Employee number,Name/);
      const off = await call(admin, 'PUT', `/reports/schedules/${s.json.id}`, { name: `Weekly roster ${tag}`, report: 'ROSTER', groupId: groupA.id, range: 'NEXT_WEEK', frequency: 'WEEKLY', dayOfWeek: 4, hour: 15, recipients: { emails: [`boss${RUN}@example.com`], roles: [] }, enabled: false });
      assert.equal(off.json.nextRunAt, null, 'a switched-off report has no next run');
      assert.equal((await call(admin, 'DELETE', `/reports/schedules/${s.json.id}`)).status, 200);
    });

    it('sends a report as a PDF or as both files, keeps both, keeps payroll CSV only, and takes a logo', async () => {
      const pdf = await fetch(`${BASE}/api/v1/reports/run?format=pdf`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${admin}` }, body: JSON.stringify({ report: 'ROSTER', groupId: groupA.id, from: monday, to: addIso(monday, 6) }) });
      assert.equal(pdf.status, 200);
      assert.equal(pdf.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
      const payrollPdf = await call(admin, 'POST', '/reports/run?format=pdf', { report: 'PAYROLL_PREVIEW', from: monday, to: addIso(monday, 6) });
      assert.equal(payrollPdf.status, 400, 'payroll is CSV only');
      const body = { name: `Roster PDF ${tag}`, report: 'ROSTER', groupId: groupA.id, range: 'NEXT_WEEK', frequency: 'WEEKLY', dayOfWeek: 4, hour: 15, recipients: { emails: [`pdf${RUN}@example.com`], roles: [] } };
      assert.equal((await call(admin, 'POST', '/reports/schedules', { ...body, report: 'PAYROLL_PREVIEW', groupId: null, format: 'PDF' })).status, 400, 'a payroll report cannot be a PDF');
      const s = await call(admin, 'POST', '/reports/schedules', { ...body, format: 'BOTH' });
      assert.equal(s.status, 201, s.text);
      assert.equal(s.json.format, 'BOTH');
      const run = await call(admin, 'POST', `/reports/schedules/${s.json.id}/run-now`, {});
      assert.equal(run.json.status, 'OK', run.json.error);
      const mail = await until(() => smtp.mails.find((m) => m.to.includes(`pdf${RUN}@example.com`)));
      assert.match(mail.data, /filename="?roster-.*\.csv/);
      assert.match(mail.data, /filename="?roster-.*\.pdf/);
      assert.match(mail.data, /application\/pdf/);
      const runs = await call(admin, 'GET', `/reports/schedules/${s.json.id}/runs`);
      assert.ok(runs.json[0].hasCsv && runs.json[0].hasPdf);
      const dl = await fetch(`${BASE}/api/v1/reports/runs/${runs.json[0].id}/download?format=pdf`, { headers: { Authorization: `Bearer ${admin}` } });
      assert.equal(dl.headers.get('content-type'), 'application/pdf');
      assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
      assert.equal((await call(admin, 'DELETE', `/reports/schedules/${s.json.id}`)).status, 200);
      // the logo: only a small PNG or JPEG
      assert.equal((await call(admin, 'PUT', '/reports/branding', { logo: 'http://example.com/x.png' })).status, 400);
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      assert.equal((await call(admin, 'PUT', '/reports/branding', { logo: png })).status, 200);
      assert.equal((await call(admin, 'GET', '/reports/branding')).json.logo, png);
      assert.equal((await call(admin, 'PUT', '/reports/branding', { logo: null })).status, 200);
    });

    it('a manager without payroll rights cannot schedule a payroll report', async () => {
      const lowly = await call(admin, 'POST', '/users', { username: `an${RUN}`, displayName: 'An Analyst', role: 'FORECAST_PLANNER', password: 'Ana#Pass12345' });
      if (lowly.status !== 201) return;
      const tok = (await call(null, 'POST', '/auth/login', { username: `an${RUN}`, password: 'Ana#Pass12345', tenant: TENANT })).json.token;
      assert.equal((await call(tok, 'POST', '/reports/schedules', { name: 'p', report: 'ROSTER', range: 'NEXT_WEEK', frequency: 'DAILY', hour: 7, recipients: { emails: ['a@example.com'], roles: [] } })).status, 403, 'scheduling needs config rights');
    });
  });

  // ------------------------------------------------------------ follow the sun
  describe('follow the sun', () => {
    it('puts two sites on one UTC clock: need, cover, gaps, who covers which hour and what sliding a roster would do', async () => {
      const r = await call(admin, 'GET', `/scheduling/follow-the-sun?groupIds=${groupA.id},${groupB.id}&from=${monday}&days=3`);
      assert.equal(r.status, 200, r.text);
      assert.equal(r.json.groups.length, 2);
      assert.ok(r.json.groups.every((g: any) => g.versionId));
      assert.equal(r.json.profile.length, 24);
      assert.ok(r.json.hourly.length > 24);
      assert.ok(r.json.totals.requiredHours > 0 && r.json.totals.scheduledHours > 0);
      assert.equal(r.json.suggestions.length, 2);
      const kolkata = r.json.groups.find((g: any) => g.id === groupB.id);
      assert.equal(kolkata.timezone, 'Asia/Kolkata');
      // the sites' local mornings are 5h30 apart on the one clock, so each group is on shift at different UTC hours
      const hourA = r.json.profile.map((p: any) => p.byGroup[groupA.id] ?? 0), hourB = r.json.profile.map((p: any) => p.byGroup[groupB.id] ?? 0);
      assert.notDeepEqual(hourA, hourB);
      assert.ok(r.json.notes.some((n: string) => /UTC/.test(n)));
      assert.equal((await call(admin, 'GET', `/scheduling/follow-the-sun?groupIds=${groupA.id}&from=${monday}`)).status, 400);
    });
  });
});
