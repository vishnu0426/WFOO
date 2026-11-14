import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFINITION, MIN_DAYS, WINDOW_DAYS, headlineFrom, type Window } from '../src/modules/forecast/accuracyHeadline.ts';

const w = (wape: number | null, days: number, bias: number | null = 0.01): Window => ({ wape, bias, days, from: '2026-10-16', to: '2026-11-13' });

describe('the one accuracy figure', () => {
  it('is 100% minus the WAPE, over the last 28 days', () => {
    const h = headlineFrom(w(0.032, 28), null);
    assert.equal(h.name, 'Forecast accuracy'); assert.equal(h.accuracyPct, 96.8); assert.equal(h.missPct, 3.2); assert.equal(h.windowDays, WINDOW_DAYS); assert.equal(h.state, 'OK'); assert.equal(h.note, '');
  });
  it('carries its own definition, so a tooltip never disagrees with the number', () => {
    assert.match(DEFINITION, /100% − WAPE/); assert.match(DEFINITION, /last 28 days/); assert.equal(headlineFrom(w(0.01, 28), null).definition, DEFINITION);
  });
  it('rounds to one decimal and carries the lean', () => {
    const h = headlineFrom(w(0.01349, 28, -0.0271), null); assert.equal(h.accuracyPct, 98.7); assert.equal(h.missPct, 1.3); assert.equal(h.biasPct, -2.7);
  });
});

describe('when the data is thin', () => {
  it('says what is needed when nothing has been compared', () => {
    const h = headlineFrom(w(null, 0, null), null); assert.equal(h.state, 'NONE'); assert.equal(h.accuracyPct, null); assert.equal(h.note, 'Needs a published forecast compared with actuals.');
  });
  it('under two completed weeks it is an early reading with the note, not settled', () => {
    const h = headlineFrom(w(0.05, MIN_DAYS - 1), null);
    assert.equal(h.state, 'SPARSE'); assert.equal(h.accuracyPct, 95); assert.equal(h.note, 'Needs 2+ completed weeks of data (13 days so far).');
    assert.equal(headlineFrom(w(0.05, 1), null).note, 'Needs 2+ completed weeks of data (1 day so far).');
    assert.equal(headlineFrom(w(0.05, MIN_DAYS), null).state, 'OK');
  });
});

describe('the change on the 28 days before', () => {
  it('in percentage points, when both have enough days', () => assert.equal(headlineFrom(w(0.03, 28), w(0.05, 28)).deltaPts, 2));
  it('not when the earlier window is thin or the present one is', () => {
    assert.equal(headlineFrom(w(0.03, 28), w(0.05, 5)).deltaPts, null); assert.equal(headlineFrom(w(0.03, 28), w(null, 0)).deltaPts, null);
    assert.equal(headlineFrom(w(0.03, 6), w(0.05, 28)).deltaPts, null); assert.equal(headlineFrom(w(0.03, 28), null).deltaPts, null);
  });
});
