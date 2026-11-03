/** Splitting a big group into parts, and the pay arithmetic. Pure functions: no server needed. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partitionIndexes, splitCounts, splitRequirement } from '../src/modules/partition.ts';
import { matchWeeks } from '../src/modules/weekMatch.ts';
import { nightMinutes, roundHours, splitPay, type DayHours } from '../src/modules/payMath.ts';

describe('splitting a group into parts', () => {
  it('shares whole numbers out so they always add up, favouring the larger parts', () => {
    assert.deepEqual(splitCounts(10, [1, 1]), [5, 5]);
    assert.equal(splitCounts(7, [1, 1, 1]).reduce((a, b) => a + b, 0), 7);
    assert.deepEqual(splitCounts(0, [3, 1]), [0, 0]);
    const c = splitCounts(100, [600, 300, 100]);
    assert.deepEqual(c, [60, 30, 10]);
  });
  it('gives every quarter-hour of the requirement to the parts without losing or inventing anyone', () => {
    const required = Array.from({ length: 96 * 3 }, (_, g) => (g * 7) % 41);
    const parts = splitRequirement(required, [1500, 1200, 700]);
    for (let g = 0; g < required.length; g++) assert.equal(parts[0][g] + parts[1][g] + parts[2][g], required[g], `slot ${g}`);
    // a part gets about its share
    const tot = (k: number) => parts[k].reduce((a, b) => a + b, 0), all = required.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(tot(0) / all - 1500 / 3400) < 0.01);
  });
  it('rotates the leftover so one part is not always the one that gets the extra person', () => {
    const parts = splitRequirement(new Array(60).fill(1), [1, 1, 1]);   // one person per slot between three equal parts
    const totals = parts.map((p) => p.reduce((a, b) => a + b, 0));
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 1, `uneven: ${totals}`);
  });
  it('keeps teams together where it can, and every person lands in exactly one part', () => {
    const teams = [...Array(300).fill('A'), ...Array(300).fill('B'), ...Array(200).fill('C'), ...Array(200).fill('D')];
    const parts = partitionIndexes(teams, 4);
    assert.equal(parts.length, 4);
    assert.deepEqual(parts.flat().sort((a, b) => a - b), teams.map((_, i) => i));
    assert.ok(parts.every((p) => Math.abs(p.length - 250) <= 1));
    const spread = (t: string) => parts.filter((p) => p.some((i) => teams[i] === t)).length;
    assert.ok(spread('A') <= 2 && spread('C') <= 2, 'a team is spread over at most two parts');
  });
});

describe('repeating the solved week that fits best', () => {
  const quiet = [100, 100, 100, 100, 100, 40, 40], busy = [160, 160, 160, 160, 160, 60, 60];
  it('keeps the rotation order when the weeks look alike', () => {
    const m = matchWeeks([quiet, quiet, quiet, quiet], [quiet, quiet, quiet]);
    assert.deepEqual(m.source, [0, 1, 2]);
    assert.equal(m.changed, 0);
  });
  it('picks the busy solved week for a busy week, and says it changed the order', () => {
    const m = matchWeeks([quiet, quiet, busy, quiet], [busy, quiet]);
    assert.equal(m.source[0], 2, 'the busy target copies the busy week');
    assert.equal(m.source[1], 1, 'the quiet target keeps its turn');
    assert.equal(m.changed, 1);
    assert.ok(m.distance[0] < 0.01);
  });
  it('reports how far off the best match still is, so a week nothing resembles can be flagged', () => {
    const m = matchWeeks([quiet, quiet], [[300, 300, 300, 300, 300, 200, 200]]);
    assert.ok(m.distance[0] > 0.5);
  });
});

describe('pay hours', () => {
  const day = (d: string, hours: number, o: Partial<DayHours> = {}): DayHours => ({ day: d, hours, nightHours: 0, weekend: false, holiday: false, ...o });
  const week = [day('2027-03-01', 8), day('2027-03-02', 8), day('2027-03-03', 8), day('2027-03-04', 8), day('2027-03-05', 8)];

  it('finds the night part of a shift, including one that crosses midnight', () => {
    assert.equal(nightMinutes(22 * 60, 30 * 60, '22:00', '06:00'), 480, 'a 22:00 to 06:00 shift is all night');
    assert.equal(nightMinutes(8 * 60, 16 * 60, '22:00', '06:00'), 0);
    assert.equal(nightMinutes(18 * 60, 26 * 60, '22:00', '06:00'), 240, '18:00 to 02:00: four night hours');
    assert.equal(nightMinutes(4 * 60, 12 * 60, '22:00', '06:00'), 120, '04:00 to 12:00: two night hours');
  });
  it('pays a normal week as regular hours', () => {
    const s = splitPay(week, 40, null, 'EXCLUSIVE');
    assert.equal(s.totals.REGULAR, 40);
    assert.equal(s.totals.OVERTIME, 0);
  });
  it('counts hours beyond the weekly limit as overtime, taken from the end of the week', () => {
    const s = splitPay([...week.slice(0, 4), day('2027-03-05', 14)], 40, null, 'EXCLUSIVE');
    assert.equal(s.totals.OVERTIME, 6);
    assert.equal(s.totals.REGULAR, 40);
    assert.equal(s.daily.find((d) => d.category === 'OVERTIME')!.day, '2027-03-05');
  });
  it('counts hours beyond a daily limit as overtime, and does not count them twice against the week', () => {
    const s = splitPay([day('2027-03-01', 11), day('2027-03-02', 8), day('2027-03-03', 8), day('2027-03-04', 8), day('2027-03-05', 5)], 40, 10, 'EXCLUSIVE');
    assert.equal(s.totals.OVERTIME, 1, 'only the daily hour: the week is 40 in all');
    assert.equal(s.totals.REGULAR, 39);
  });
  it('gives each hour one category: holiday first, then night, then weekend', () => {
    const s = splitPay([day('2027-03-06', 8, { weekend: true, nightHours: 3 }), day('2027-03-07', 8, { weekend: true, holiday: true }), day('2027-03-01', 8, { nightHours: 2 })], 100, null, 'EXCLUSIVE');
    assert.equal(s.totals.HOLIDAY, 8);
    assert.equal(s.totals.NIGHT, 5);
    assert.equal(s.totals.WEEKEND, 5);
    assert.equal(s.totals.REGULAR, 6);
    assert.equal(Object.values(s.totals).reduce((a, b) => a + b, 0), 24, 'nothing is lost or counted twice');
  });
  it('with stacked pay, night and weekend hours stay regular and are also reported as supplements', () => {
    const s = splitPay([day('2027-03-06', 8, { weekend: true, nightHours: 3 }), day('2027-03-01', 8, { nightHours: 2 })], 100, null, 'STACKED');
    assert.equal(s.totals.NIGHT + s.totals.WEEKEND, 0);
    assert.equal(s.totals.REGULAR, 16);
    assert.equal(s.supplements.NIGHT, 5);
    assert.equal(s.supplements.WEEKEND, 5);
  });
  it('takes weekly overtime from regular hours first, then weekend, then night, and never from holiday hours', () => {
    const s = splitPay([day('2027-03-01', 8), day('2027-03-06', 8, { weekend: true }), day('2027-03-07', 8, { weekend: true, holiday: true })], 16, null, 'EXCLUSIVE');
    assert.equal(s.totals.OVERTIME, 8);
    assert.equal(s.totals.HOLIDAY, 8, 'holiday hours are not turned into overtime');
    assert.equal(s.totals.REGULAR, 0, 'regular went first');
    assert.equal(s.totals.WEEKEND, 8);
  });
  it('rounds the way payroll asked', () => {
    assert.equal(roundHours(7.62, 'NONE'), 7.62);
    assert.equal(roundHours(7.62, 'TENTH'), 7.6);
    assert.equal(roundHours(7.62, 'QUARTER'), 7.5);
    assert.equal(roundHours(7.7, 'QUARTER'), 7.75);
  });
});

describe('parts that each look like the whole group', async () => {
  const { stratifiedIndexes } = await import('../src/modules/partition.ts');
  it('deals every kind of person out evenly, so no part is all one kind', () => {
    const kinds = Array.from({ length: 100 }, (_, i) => (i < 60 ? 'EN' : i < 80 ? 'ES' : 'EN,ES'));      // 60% English, 20% Spanish, 20% both, the way they sit in the list
    const parts = stratifiedIndexes(kinds, 4);
    assert.equal(parts.length, 4);
    assert.equal(parts.flat().length, 100);
    assert.equal(new Set(parts.flat()).size, 100, 'everyone is in exactly one part');
    for (const p of parts) {
      assert.ok(Math.abs(p.length - 25) <= 1, `part sizes stay level: ${p.length}`);
      for (const [kind, share] of [['EN', 15], ['ES', 5], ['EN,ES', 5]] as const) assert.ok(Math.abs(p.filter((i) => kinds[i] === kind).length - share) <= 1, `${kind} share in a part`);
    }
  });
  it('gives back no empty parts when there are fewer people than parts', () => {
    assert.deepEqual(stratifiedIndexes(['a', 'b'], 5).map((p) => p.length), [1, 1]);
  });
});
