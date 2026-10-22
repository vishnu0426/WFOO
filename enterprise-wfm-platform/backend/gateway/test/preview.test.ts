/**
 * Forecast Builder preview (a typical day from recent history at the group's targets) and the version list's model / accuracy.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* no body */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function historyCsv(queue: string, days: number) {
  const curve = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
  let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = days; n >= 1; n--) {
    const d = new Date(today); d.setDate(d.getDate() - n);
    const f = ((d.getDay() + 6) % 7) >= 5 ? 0.4 : 1;
    for (let s = 0; s < 96; s++) {
      const mean = (curve[Math.floor(s / 4)] * f * 0.5) / 4;
      rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.max(0, Math.round(mean + Math.sqrt(mean) * (rnd() * 2 - 1)))},${300 + Math.round(rnd() * 20)}`);
    }
  }
  return rows.join('\n');
}

let admin = '';
const ctx: Record<string, any> = {};

describe('forecast preview and list', () => {
  before(async () => {
    assert.ok(PASSWORD, 'set ADMIN_PASSWORD');
    const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT });
    assert.equal(r.status, 200, r.text); admin = r.json.token;
  });

  it('says what is missing before there is any history', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Empty ${RUN}` }); assert.equal(g.status, 201, g.text);
    const none = await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}`);
    assert.equal(none.status, 200); assert.equal(none.json.ready, false); assert.match(none.json.reason, /no queues/i);
    await call(admin, 'POST', '/config/queues', { name: `EmptyQ ${RUN}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 });
    const noHist = await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}`);
    assert.equal(noHist.json.ready, false); assert.match(noHist.json.reason, /no interval history/i);
  });

  it('previews a typical day from history, and lets the weekday change', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Prev ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 25, targetOccupancy: 88 });
    ctx.group = g.json;
    const q = `Prev Voice ${RUN}`;
    assert.equal((await call(admin, 'POST', '/config/queues', { name: q, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 300 })).status, 201);
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q, 70) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).status, 200);

    const mon = await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}&dow=1`);
    assert.equal(mon.status, 200, mon.text); assert.equal(mon.json.ready, true); assert.equal(mon.json.dow, 1);
    assert.equal(mon.json.slots.length, 96);
    assert.ok(mon.json.day.volume > 0 && mon.json.day.peakRequired > 0 && mon.json.week.fte > 0, 'real numbers from history');
    assert.ok(mon.json.basis.weeks >= 8 && mon.json.basis.from < mon.json.basis.to);
    assert.equal(mon.json.targets.shrinkage, 0.25);
    const sun = await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}&dow=6`);
    assert.ok(sun.json.day.volume < mon.json.day.volume, 'the synthetic history is quieter at the weekend');
    assert.equal((await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}&dow=9`)).status, 400);
    // what-if values change the preview, and are echoed back as the targets used
    const tight = await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}&dow=1&sl=95&answer=10&shrink=40&aht=500`);
    assert.equal(tight.status, 200, tight.text);
    assert.ok(tight.json.day.peakRequired > mon.json.day.peakRequired && tight.json.week.fte > mon.json.week.fte, 'stricter targets need more people');
    assert.equal(tight.json.targets.serviceLevel, 0.95); assert.equal(tight.json.targets.shrinkage, 0.4); assert.equal(tight.json.aht, 500);
    assert.ok(tight.json.ahtHistory > 0 && tight.json.ahtHistory !== 500, 'the history AHT is still reported');
    assert.equal((await call(admin, 'GET', `/forecast/preview?groupId=${g.json.id}&sl=100`)).status, 400, 'out-of-range what-if values are refused');
  });

  it('lists versions with the winning model and its typical daily miss', async () => {
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: ctx.group.id, kind: 'SHORT', weeks: 2 });
    assert.equal(f.status, 201, f.text);
    const list = await call(admin, 'GET', `/forecast/versions?groupId=${ctx.group.id}`);
    const v = list.json.find((x: any) => x.id === f.json.id);
    assert.ok(typeof v.model === 'string' && v.model.length > 0, 'model is present');
    assert.ok(typeof v.wape === 'number' && v.wape >= 0 && v.wape < 1, 'typical miss is a fraction');
    const everyGroup = await call(admin, 'GET', '/forecast/versions');
    assert.ok(everyGroup.json.some((x: any) => x.id === f.json.id), 'the list works without a group filter (All Forecasts)');
  });
});
