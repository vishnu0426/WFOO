import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_POOL, headline, pickMany, search, siteChoices, split, suggestions, toggle, whyNot, type Cand } from '../../../src/services/poolingPicker.ts';

const c = (id: string, name: string, over: Partial<Cand> = {}): Cand => ({ id, name, siteId: null, siteName: null, queues: 1, channels: ['VOICE'], people: 10, ready: true, forecastName: 'v1', ...over });

describe('which groups can be pooled', () => {
  it('only those with a forecast for the day; the rest are only listed', () => {
    const s = split([c('a', 'A'), c('b', 'B', { ready: false, forecastName: null })]);
    assert.deepEqual(s.ready.map((x) => x.id), ['a']); assert.deepEqual(s.notReady.map((x) => x.id), ['b']);
  });
});

describe('searching', () => {
  const l = [c('a', 'Sales', { siteName: 'London', channels: ['VOICE'] }), c('b', 'Support desk', { siteName: 'Pune', channels: ['CHAT', 'EMAIL'] }), c('c', 'Billing', { siteName: 'London', channels: ['EMAIL'] })];
  it('matches the name, the site and the channel, every word', () => {
    assert.deepEqual(search(l, 'sup').map((x) => x.id), ['b']); assert.deepEqual(search(l, 'london').map((x) => x.id), ['a', 'c']);
    assert.deepEqual(search(l, 'london email').map((x) => x.id), ['c']); assert.deepEqual(search(l, '  ').map((x) => x.id), ['a', 'b', 'c']); assert.deepEqual(search(l, 'zzz'), []);
  });
});

describe('quick choices', () => {
  it('a site with two or more groups, biggest first', () => {
    const l = [c('a', 'A', { siteId: 's1', siteName: 'London' }), c('b', 'B', { siteId: 's1', siteName: 'London' }), c('c', 'C', { siteId: 's2', siteName: 'Pune' }), c('d', 'D', { siteId: 's3', siteName: 'Oslo' }), c('e', 'E', { siteId: 's3', siteName: 'Oslo' }), c('f', 'F', { siteId: 's3', siteName: 'Oslo' })];
    assert.deepEqual(siteChoices(l).map((x) => [x.name, x.ids.length]), [['Oslo', 3], ['London', 2]]);
  });
  it('a site bigger than the limit is cut to the limit and says how many were left out', () => {
    const l = Array.from({ length: 10 }, (_, i) => c(`g${i}`, `G${i}`, { siteId: 's', siteName: 'Big' }));
    const s = siteChoices(l)[0]; assert.equal(s.ids.length, MAX_POOL); assert.equal(s.more, 2);
  });
  it('suggests the pairs that share the most people, only when both can be compared', () => {
    const l = [c('a', 'Sales'), c('b', 'Support'), c('c', 'Billing')];
    const s = suggestions(l, [{ a: 'a', b: 'b', people: 4 }, { a: 'b', b: 'c', people: 9 }, { a: 'a', b: 'x', people: 50 }]);
    assert.deepEqual(s.map((x) => [x.label, x.people]), [['Support + Billing', 9], ['Sales + Support', 4]]);
  });
});

describe('picking', () => {
  it('adds and removes one at a time', () => { assert.deepEqual(toggle([], 'a'), { picked: ['a'], full: false }); assert.deepEqual(toggle(['a', 'b'], 'a'), { picked: ['b'], full: false }); });
  it('stops at eight and says it is full', () => {
    const eight = Array.from({ length: 8 }, (_, i) => `g${i}`); assert.deepEqual(toggle(eight, 'x'), { picked: eight, full: true });
    assert.equal(toggle(eight, 'g3').picked.length, 7);
  });
  it('picks a set at once without repeats and within the limit', () => { assert.deepEqual(pickMany(['a'], ['a', 'b']), ['a', 'b']); assert.equal(pickMany([], Array.from({ length: 12 }, (_, i) => `g${i}`)).length, 8); });
  it('says why it cannot compare yet', () => { assert.match(whyNot(0), /at least two/); assert.match(whyNot(1), /at least two/); assert.equal(whyNot(2), ''); });
});

describe('the answer in a sentence', () => {
  const r = (over = {}) => ({ groups: [{ name: 'Sales' }, { name: 'Support' }], savingHours: 12.4, savingPercent: 8.2, peakSeparate: 40, peakPooled: 36, ...over });
  it('says the hours, the share and the peak', () => assert.equal(headline(r()), 'Pooling Sales and Support needs 12 fewer agent hours on the day (−8%), and 4 fewer agents at the busiest time.'));
  it('lists three groups, leaves the peak out when it does not fall, and says when there is no gain', () => {
    assert.match(headline(r({ groups: [{ name: 'A' }, { name: 'B' }, { name: 'C' }], peakPooled: 40 })), /^Pooling A, B and C needs 12 fewer agent hours on the day \(−8%\)\.$/);
    assert.match(headline(r({ savingHours: 0, savingPercent: 0 })), /gives no gain on this day/);
  });
});
