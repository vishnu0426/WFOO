import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LIVE_PER_GROUP, overlapDays, pickForDays, publishEffect, type LiveRow } from '../src/modules/forecast/liveSelection.ts';

const row = (id: string, seq: number, fromDay: string, toDay: string, publishedAt = `2026-11-${10 + seq}T00:00:00Z`): LiveRow => ({ id, seq, name: `v${seq}`, fromDay, toDay, publishedAt });
const nov = row('a', 1, '2026-11-18', '2026-12-29');
const jan = row('b', 2, '2027-01-01', '2027-02-11');

describe('publishing among live forecasts', () => {
  it('replaces only a forecast with the same horizon', () => {
    const e = publishEffect({ id: 'n', fromDay: '2026-11-18', toDay: '2026-12-29' }, [nov, jan]);
    assert.deepEqual(e.replaces.map((r) => r.id), ['a']);
    assert.deepEqual(e.alsoLive.map((r) => r.id), ['b']);
  });
  it('keeps a forecast for other weeks live and says how many days an overlap shares', () => {
    const e = publishEffect({ id: 'n', fromDay: '2026-12-15', toDay: '2027-02-15' }, [nov, jan]);
    assert.equal(e.replaces.length, 0);
    assert.equal(e.alsoLive.find((r) => r.id === 'a')!.sharedDays, 15);
    assert.equal(e.alsoLive.find((r) => r.id === 'b')!.sharedDays, 42);
  });
  it('does not count itself, and refuses a thirteenth live forecast', () => {
    assert.equal(publishEffect({ id: 'a', fromDay: '2026-11-18', toDay: '2026-12-29' }, [nov]).replaces.length, 0);
    const many = Array.from({ length: MAX_LIVE_PER_GROUP }, (_, i) => row(`x${i}`, i + 1, `2027-${String(i + 1).padStart(2, '0')}-01`, `2027-${String(i + 1).padStart(2, '0')}-05`));
    assert.equal(publishEffect({ id: 'n', fromDay: '2028-01-01', toDay: '2028-01-07' }, many).tooMany, true);
    assert.equal(publishEffect({ id: 'n', fromDay: '2028-01-01', toDay: '2028-01-07' }, many.slice(1)).tooMany, false);
  });
  it('counts shared days', () => {
    assert.equal(overlapDays({ fromDay: '2026-01-01', toDay: '2026-01-10' }, { fromDay: '2026-01-10', toDay: '2026-01-20' }), 1);
    assert.equal(overlapDays({ fromDay: '2026-01-01', toDay: '2026-01-10' }, { fromDay: '2026-02-01', toDay: '2026-02-03' }), 0);
  });
});

describe('choosing the live forecast for some days', () => {
  it('takes the one that covers all of them', () => {
    const days = ['2026-11-18', '2026-11-19'];
    assert.equal(pickForDays([jan, nov], days)!.id, 'a');
    assert.equal(pickForDays([nov, jan], ['2027-01-05'])!.id, 'b');
  });
  it('prefers the most recently published when two cover everything', () => {
    const newer = row('c', 3, '2026-11-01', '2026-12-31');
    assert.equal(pickForDays([nov, newer], ['2026-11-20'])!.id, 'c');
  });
  it('falls back to the one covering most days, then to the newest', () => {
    assert.equal(pickForDays([nov, jan], ['2026-12-28', '2026-12-29', '2026-12-30', '2027-01-01', '2027-01-02'])!.id, 'b');
    assert.equal(pickForDays([nov, jan], ['2030-01-01'])!.id, 'b');
    assert.equal(pickForDays([], ['2026-11-18']), null);
  });
});
