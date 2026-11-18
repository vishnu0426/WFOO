import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectDateOrder, parseDate, parseHours } from '../src/modules/importFormats';

describe('parseHours', () => {
  it('reads time-style and plain hours', () => {
    assert.equal(parseHours('46:15:00'), 46.25);
    assert.equal(parseHours('40:00'), 40);
    assert.equal(parseHours('46.25'), 46.25);
    assert.equal(parseHours('37,5'), 37.5);
    assert.equal(parseHours('40'), 40);
  });
  it('refuses what is not hours', () => {
    assert.equal(parseHours(''), null);
    assert.equal(parseHours('abc'), null);
    assert.equal(parseHours('12:75'), null);
    assert.equal(parseHours('-5'), null);
  });
});

describe('detectDateOrder', () => {
  it('settles it from a day above 12', () => {
    assert.equal(detectDateOrder(['10/29/2026', '01/02/2026']), 'MDY');
    assert.equal(detectDateOrder(['29/10/2026', '01/02/2026']), 'DMY');
  });
  it('does not guess when every date could be either', () => {
    assert.equal(detectDateOrder(['03/04/2026', '01/02/2026']), 'UNCLEAR');
  });
  it('flags a column that mixes both', () => {
    assert.equal(detectDateOrder(['29/10/2026', '10/29/2026']), 'CONFLICT');
  });
  it('needs nothing for ISO dates or empty values', () => {
    assert.equal(detectDateOrder(['2026-10-29', '', 'x']), 'NONE');
  });
});

describe('parseDate', () => {
  it('reads the three forms', () => {
    assert.equal(parseDate('2026-10-29', null), '2026-10-29');
    assert.equal(parseDate('10/29/2026', 'MDY'), '2026-10-29');
    assert.equal(parseDate('29/10/2026', 'DMY'), '2026-10-29');
    assert.equal(parseDate('29.10.2026', 'DMY'), '2026-10-29');
    assert.equal(parseDate('10/29/2026 00:00:00', 'MDY'), '2026-10-29');
  });
  it('refuses impossible dates and slash dates with no order', () => {
    assert.equal(parseDate('31/02/2026', 'DMY'), null);
    assert.equal(parseDate('10/29/2026', 'DMY'), null);
    assert.equal(parseDate('10/29/2026', null), null);
    assert.equal(parseDate('2026-02-30', null), null);
  });
});
