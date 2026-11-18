import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { automaticChoice, defaultHistory, forecastChoices, historyPicks, publishLines, queueDaysIn, type Fv } from '../../../src/services/liveForecasts.ts';

const fv = (id: string, seq: number, status: string, fromDay: string, toDay: string, publishedAt: string | null = null): Fv => ({ id, seq, name: `v${seq}`, status, kind: 'SHORT', fromDay, toDay, publishedAt });
const nov = fv('a', 1, 'PUBLISHED', '2026-11-18', '2026-12-29', '2026-11-10T00:00:00Z');
const jan = fv('b', 2, 'PUBLISHED', '2027-01-01', '2027-02-11', '2026-11-12T00:00:00Z');

describe('what publishing will do', () => {
  it('replaces a live forecast for the same dates and leaves the others', () => {
    const r = publishLines({ id: 'n', fromDay: '2026-11-18', toDay: '2026-12-29' }, [nov, jan]);
    assert.deepEqual(r.replaces.map((f) => f.id), ['a']);
    assert.match(r.lines[0], /Replaces v1/);
    assert.match(r.lines[1], /v2 \(1 Jan to 11 Feb\) stays live/);
  });
  it('says nothing is replaced for new dates, and how many days an overlap shares', () => {
    const r = publishLines({ fromDay: '2026-12-15', toDay: '2027-01-10' }, [nov, jan]);
    assert.match(r.lines[0], /Nothing is replaced/);
    assert.match(r.lines.join(' '), /v1 stays live and shares 15 days/);
    assert.match(r.lines.join(' '), /v2 stays live and shares 10 days/);
  });
  it('ignores drafts, archived and long-term forecasts', () => {
    const r = publishLines({ fromDay: '2026-11-18', toDay: '2026-12-29' }, [fv('d', 3, 'DRAFT', '2026-11-18', '2026-12-29'), { ...nov, status: 'ARCHIVED' }, { ...nov, id: 'l', kind: 'LONG' }]);
    assert.equal(r.replaces.length, 0);
  });
});

describe('forecasts a schedule can follow', () => {
  it('puts a live forecast covering every day first, then drafts that do, then partial, then none', () => {
    const draft = fv('d', 3, 'DRAFT', '2026-11-16', '2026-12-31');
    const c = forecastChoices({ from: '2026-11-23', to: '2026-12-20', forecasts: [jan, draft, nov, fv('p', 4, 'PUBLISHED', '2026-12-10', '2027-01-31', '2026-11-13T00:00:00Z')] });
    assert.deepEqual(c.map((x) => [x.fv.id, x.covers]), [['a', 'ALL'], ['d', 'ALL'], ['p', 'PART'], ['b', 'NONE']]);
    assert.match(c[0].note, /Covers all 28 days · live/);
    assert.match(c[2].note, /Covers 11 of 28 days/);
  });
  it('hides archived forecasts unless asked', () => {
    const old = { ...nov, id: 'o', status: 'ARCHIVED' };
    assert.equal(forecastChoices({ from: '2026-11-23', to: '2026-12-20', forecasts: [old] }).length, 0);
    assert.equal(forecastChoices({ from: '2026-11-23', to: '2026-12-20', forecasts: [old], withArchived: true }).length, 1);
  });
  it('Automatic follows the live forecast covering everything, else the live one covering most, else nothing', () => {
    assert.equal(automaticChoice(forecastChoices({ from: '2026-11-23', to: '2026-12-20', forecasts: [nov, jan] }))!.fv.id, 'a');
    assert.equal(automaticChoice(forecastChoices({ from: '2026-12-20', to: '2027-01-16', forecasts: [nov, jan] }))!.fv.id, 'b', 'v2 covers 16 days, v1 only 10');
    assert.equal(automaticChoice(forecastChoices({ from: '2030-01-01', to: '2030-01-28', forecasts: [nov, jan] })), null);
    assert.equal(automaticChoice(forecastChoices({ from: '2026-11-23', to: '2026-12-20', forecasts: [fv('d', 3, 'DRAFT', '2026-11-16', '2026-12-31')] })), null, 'a draft is never chosen automatically');
  });
});

describe('history dates', () => {
  const q = [{ name: 'English', firstDay: '2025-01-01', lastDay: '2026-11-17', days: 700 }, { name: 'French', firstDay: '2026-08-01', lastDay: '2026-11-17', days: 100 }];
  it('defaults to the last 12 months that have data, ending on the last day with data and never today', () => {
    assert.deepEqual(defaultHistory(q, '2026-11-18'), { from: '2025-11-18', to: '2026-11-17' });
    assert.deepEqual(defaultHistory([{ name: 'A', firstDay: '2026-09-01', lastDay: '2026-11-30', days: 90 }], '2026-11-18'), { from: '2026-09-01', to: '2026-11-17' });
    assert.equal(defaultHistory([{ name: 'A', firstDay: null, lastDay: null, days: 0 }], '2026-11-18'), null);
  });
  it('offers quick picks that start after the first day with data, plus all of it', () => {
    const p = historyPicks('2026-11-17', '2026-08-01');
    assert.deepEqual(p.map((x) => x.label), ['Last 3 months', 'All of it']);
    assert.equal(p.at(-1)!.from, '2026-08-01');
  });
  it('counts each queue\'s days of data inside the chosen dates, and flags thin ones', () => {
    const r = queueDaysIn(q, '2026-06-01', '2026-11-17');
    assert.deepEqual(r.map((x) => [x.name, x.days, x.thin]), [['English', 170, false], ['French', 100, false]]);
    assert.equal(queueDaysIn(q, '2026-11-01', '2026-11-17')[1].thin, true);
  });
});
