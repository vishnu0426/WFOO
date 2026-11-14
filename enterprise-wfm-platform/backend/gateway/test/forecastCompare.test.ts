import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compareDays, type DayPoint } from '../src/modules/forecast/compare.ts';

const d = (day: string, volume: number, aht = 300, peakRequired?: number, agentHours?: number): DayPoint => ({ day, volume, aht, peakRequired, agentHours });

describe('comparing two versions day by day', () => {
  const base = [d('2026-11-09', 1000, 300, 20, 100), d('2026-11-10', 1200, 300, 24, 120), d('2026-11-11', 800, 300, 16, 80)];
  const next = [d('2026-11-09', 1050, 300, 21, 105), d('2026-11-10', 1200, 330, 24, 125), d('2026-11-11', 700, 300, 14, 70)];

  it('gives each day, the difference and the percentage', () => {
    const r = compareDays(base, next);
    assert.deepEqual(r.rows.map((x) => [x.day, x.a, x.b, x.delta, x.deltaPct]), [
      ['2026-11-09', 1000, 1050, 50, 5], ['2026-11-10', 1200, 1200, 0, 0], ['2026-11-11', 800, 700, -100, -12.5],
    ]);
  });
  it('totals the shared days, with weighted handle time, peaks and agent hours', () => {
    const s = compareDays(base, next).summary;
    assert.deepEqual([s.volume.a, s.volume.b, s.volume.deltaPct], [3000, 2950, -1.7]);
    assert.deepEqual(s.avgAht, { a: 300, b: Math.round((300 * 1050 + 330 * 1200 + 300 * 700) / 2950) });
    assert.deepEqual(s.peakRequired, { a: 24, b: 24 }); assert.deepEqual(s.agentHours, { a: 300, b: 300 });
    assert.deepEqual(s.busiestDay, { a: { day: '2026-11-10', volume: 1200 }, b: { day: '2026-11-10', volume: 1200 } });
  });
  it('names the day they differ on most', () => {
    assert.deepEqual(compareDays(base, next).biggest, { day: '2026-11-11', delta: -100, deltaPct: -12.5 });
    assert.equal(compareDays(base, base).biggest, null, 'identical versions differ nowhere');
  });
  it('counts only the days both cover in the totals, and reports the rest', () => {
    const shorter = next.slice(0, 2), longer = [...base, d('2026-11-12', 900)];
    const r = compareDays(longer, shorter);
    assert.deepEqual(r.overlap, { from: '2026-11-09', to: '2026-11-10', days: 2 });
    assert.equal(r.onlyA, 2); assert.equal(r.onlyB, 0);
    assert.equal(r.summary.volume.a, 2200, 'the version that goes on longer is not "bigger" for it');
    assert.equal(r.rows.at(-1)!.b, null); assert.equal(r.rows.at(-1)!.delta, null);
  });
  it('copes with versions that share no day, with nothing in them, and with no staffing figures (a long-term forecast)', () => {
    const none = compareDays([d('2026-01-01', 5)], [d('2026-02-01', 5)]);
    assert.equal(none.overlap, null); assert.equal(none.summary.volume.a, null); assert.equal(none.biggest, null);
    assert.equal(compareDays([], []).rows.length, 0);
    const long = compareDays([d('2026-01-01', 100)], [d('2026-01-01', 110)]).summary;
    assert.deepEqual(long.peakRequired, { a: null, b: null }); assert.deepEqual(long.agentHours, { a: null, b: null });
    assert.equal(compareDays([d('2026-01-01', 0)], [d('2026-01-01', 10)]).rows[0].deltaPct, null, 'no percentage against nothing');
  });
});
