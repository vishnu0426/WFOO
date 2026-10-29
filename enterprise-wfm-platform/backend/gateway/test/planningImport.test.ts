/** A planning forecast from a file: reading the volume column, summarising what is in it, and the rows that get saved. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { normalise, parseCsv } from '../src/modules/csv.ts';
import { planRows, summarisePlan, withPlainVolumeHeader } from '../src/modules/forecast/planningImport.ts';

const queues = [{ id: 'q1', name: 'Technical support', code: 'Technical support', ahtDefault: 300 }];
const names = new Map([['q1', 'Technical support']]);
const day = (d: string, n = 96, vol = 10, aht = 180) => Array.from({ length: n }, (_, s) => `Technical support,${d},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${vol},${aht}`);
const file = (header: string, rows: string[]) => parseCsv([header, ...rows].join('\n'));

describe('planning import', () => {
  it('reads forecast_volume as the volume', () => {
    const { matrix, renamedFrom } = withPlainVolumeHeader(file('queue,date,interval,forecast_volume,aht', day('2026-11-01', 4)));
    assert.equal(renamedFrom, 'forecast_volume');
    const r = normalise(matrix, { queues });
    assert.equal(r.errors.length, 0);
    assert.equal(r.records.length, 4);
    assert.equal(r.records[0].volume, 10);
    assert.equal(r.records[0].ahtSec, 180);
  });
  it('the history reader still refuses it, so a forecast can never be stored as what happened', () => {
    const r = normalise(file('queue,date,interval,forecast_volume,aht', day('2026-11-01', 4)), { queues });
    assert.ok(r.errors.some((e) => /No volume column/.test(e.message)));
  });
  it('leaves a file that already has a plain volume column alone', () => {
    const { matrix, renamedFrom } = withPlainVolumeHeader(file('queue,date,interval,volume,aht', day('2026-11-01', 2)));
    assert.equal(renamedFrom, null);
    assert.equal(matrix[0][3], 'volume');
  });
  it('knows several names for the column', () => {
    for (const h of ['Planned Volume', 'forecast', 'Forecasted-Volume', 'expected_volume']) {
      assert.ok(withPlainVolumeHeader(file(`queue,date,interval,${h},aht`, day('2026-11-01', 1))).renamedFrom, h);
    }
  });
  it('summarises days, queues, volume and what is missing', () => {
    const rows = [...day('2026-11-01'), ...day('2026-11-02', 90)];
    const r = normalise(withPlainVolumeHeader(file('queue,date,interval,forecast_volume,aht', rows)).matrix, { queues });
    const s = summarisePlan(r.records, names, '2026-10-28');
    assert.equal(s.from, '2026-11-01'); assert.equal(s.to, '2026-11-02'); assert.equal(s.days, 2);
    assert.equal(s.totalVolume, 10 * (96 + 90)); assert.equal(s.intervals, 186);
    assert.deepEqual(s.gaps, [{ queue: 'Technical support', day: '2026-11-02', have: 90 }]);
    assert.deepEqual(s.pastDays, []);
    assert.deepEqual(s.byDay, [{ day: '2026-11-01', volume: 960 }, { day: '2026-11-02', volume: 900 }]);
  });
  it('says which days are already in the past', () => {
    const r = normalise(withPlainVolumeHeader(file('queue,date,interval,forecast_volume,aht', [...day('2026-10-20'), ...day('2026-11-01')])).matrix, { queues });
    assert.deepEqual(summarisePlan(r.records, names, '2026-10-28').pastDays, ['2026-10-20']);
  });
  it('saves one row per quarter-hour and one per day with a volume-weighted handle time', () => {
    const rows = [...day('2026-11-01', 2, 10, 100), ...day('2026-11-01', 0)];
    rows.splice(1, 1, 'Technical support,2026-11-01,00:15,30,200');
    const r = normalise(withPlainVolumeHeader(file('queue,date,interval,forecast_volume,aht', rows)).matrix, { queues });
    const out = planRows(r.records);
    assert.equal(out.filter((x) => x.slot >= 0).length, 2);
    const d = out.find((x) => x.slot === -1)!;
    assert.equal(d.volume, 40);
    assert.equal(d.aht, 175);                  // (10x100 + 30x200) / 40
  });
  it('reads the planning file from the Downloads folder when it is there', { skip: !existsSync(process.env.PLAN_CSV ?? '') }, () => {
    const r = normalise(withPlainVolumeHeader(parseCsv(readFileSync(process.env.PLAN_CSV!, 'utf8'))).matrix, { queues });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors.slice(0, 3)));
    const s = summarisePlan(r.records, names, '2026-10-28');
    assert.equal(s.days, 7); assert.equal(s.gaps.length, 0); assert.equal(s.from, '2026-11-01'); assert.equal(s.to, '2026-11-07');
  });
});
