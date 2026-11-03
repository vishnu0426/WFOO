/** Accuracy over time: weekly misses, bias, drift, and what is left out. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trendOf, weekOf, weeklyPoints, type DayRow } from '../src/modules/forecast/accuracyTrend.ts';

const add = (d: string, n: number) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10); };
const MON = '2027-01-04';                                                             // a Monday
/** `weeks` full weeks from MON for one queue: the forecast is `ratio` times the actual (1000 a day), so the miss is |ratio - 1|. */
const rows = (queueId: string, ratioOf: (week: number) => number, weeks = 8, from = MON): DayRow[] => {
  const out: DayRow[] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const actual = 1000, forecast = actual * ratioOf(w);
    out.push({ queueId, name: queueId, day: add(from, w * 7 + d), actual, forecast, absErr: Math.abs(forecast - actual), intervals: 96 });
  }
  return out;
};

describe('weekly points', () => {
  it('groups days into pay weeks that start where the group says', () => {
    assert.equal(weekOf('2027-01-06', 0), '2027-01-04'); assert.equal(weekOf('2027-01-06', 6), '2027-01-03'); assert.equal(weekOf('2027-01-03', 6), '2027-01-03');
    const sun = weeklyPoints(rows('q', () => 1, 3, '2027-01-03'), 6);
    assert.equal(sun.length, 3); assert.equal(sun[0].weekStart, '2027-01-03'); assert.equal(sun[0].days, 7);
  });
  it('measures the miss and the bias', () => {
    const [w] = weeklyPoints(rows('q', () => 1.1, 1), 0);
    assert.equal(w.wapeDaily, 0.1); assert.equal(w.wape15, 0.1); assert.equal(w.bias, 0.1); assert.equal(w.actual, 7000); assert.equal(w.forecast, 7700);
  });
  it('lets misses of opposite sign cancel in the bias but not in the miss', () => {
    const r = rows('q', () => 1, 1); r[0].forecast = 1200; r[0].absErr = 200; r[1].forecast = 800; r[1].absErr = 200;
    const [w] = weeklyPoints(r, 0);
    assert.equal(w.bias, 0); assert.equal(w.wapeDaily, r3(400 / 7000));
  });
  it('leaves out a week with fewer than four days of data, and a week with no actual volume', () => {
    assert.equal(weeklyPoints(rows('q', () => 1, 2).slice(0, 7 + 3), 0).length, 1, 'the second week has three days');
    const zero = rows('q', () => 1, 1).map((r) => ({ ...r, actual: 0 }));
    assert.equal(weeklyPoints(zero, 0).length, 0);
  });
});
const r3 = (v: number) => Math.round(v * 1000) / 1000;

describe('judging a queue', () => {
  it('calls a steady 5% miss good, 10% check and 20% poor', () => {
    assert.equal(trendOf(rows('a', () => 1.05), 0).queues[0].status, 'GOOD');
    assert.equal(trendOf(rows('a', () => 1.10), 0).queues[0].status, 'CHECK');
    assert.equal(trendOf(rows('a', () => 1.20), 0).queues[0].status, 'POOR');
  });
  it('sees a forecast that is getting worse, and one that is getting better', () => {
    assert.equal(trendOf(rows('a', (w) => (w < 5 ? 1.03 : 1.12)), 0).queues[0].direction, 'WORSENING');
    assert.equal(trendOf(rows('a', (w) => (w < 5 ? 1.15 : 1.04)), 0).queues[0].direction, 'IMPROVING');
    assert.equal(trendOf(rows('a', () => 1.05), 0).queues[0].direction, 'STEADY');
  });
  it('says so when the forecast runs high or low three weeks in a row, and not when it flips', () => {
    assert.equal(trendOf(rows('a', () => 1.07), 0).queues[0].consistentBias, 'HIGH');
    assert.equal(trendOf(rows('a', () => 0.92), 0).queues[0].consistentBias, 'LOW');
    assert.equal(trendOf(rows('a', (w) => (w % 2 ? 1.07 : 0.93)), 0).queues[0].consistentBias, null);
    assert.match(trendOf(rows('a', () => 1.07), 0).queues[0].message, /ran high for 3 weeks in a row/);
  });
  it('has nothing to judge before any forecast has met actuals', () => {
    const t = trendOf([], 0);
    assert.equal(t.total.status, 'NO_DATA'); assert.equal(t.queues.length, 0); assert.match(t.total.message, /No published forecast/);
  });
  it('keeps each queue separate and adds them up for the total', () => {
    const t = trendOf([...rows('a', () => 1.02), ...rows('b', () => 1.20)], 0);
    assert.equal(t.queues.length, 2); assert.equal(t.queues[0].status, 'GOOD'); assert.equal(t.queues[1].status, 'POOR');
    assert.equal(t.total.latest!.actual, 14000); assert.equal(t.total.latest!.bias, 0.11);
  });
  it('shows no more weeks than asked for, newest last', () => {
    const t = trendOf(rows('a', () => 1.05, 12), 0, 6);
    assert.equal(t.queues[0].weeks.length, 6); assert.equal(t.queues[0].weeks.at(-1)!.weekStart, add(MON, 11 * 7));
  });
});
