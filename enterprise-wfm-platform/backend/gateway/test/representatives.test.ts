import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pickRepresentatives } from '../src/modules/representatives.ts';

describe('representatives', () => {
  it('samples each kind in proportion, at least one, and every person follows one of their own kind', () => {
    const kinds = ['full', 'full', 'full', 'part', 'full', 'full', 'full', 'full', 'full', 'rare'];
    const people = Array.from({ length: 5000 }, (_, i) => kinds[i % kinds.length]);
    const { reps, repOf } = pickRepresentatives(people.length, (i) => people[i], 100);
    assert.ok(reps.length >= 99 && reps.length <= 101, `about the target, got ${reps.length}`);
    assert.equal(new Set(reps).size, reps.length, 'nobody is picked twice');
    for (let i = 0; i < people.length; i++) assert.equal(people[reps[repOf[i]]], people[i], 'a person takes the roster of their own kind');
    for (const r of reps) assert.equal(reps[repOf[r]], r, 'a representative takes their own roster');
    const share = (k: string) => reps.filter((r) => people[r] === k).length;
    assert.ok(share('rare') >= 1 && share('full') > share('part'), 'kinds are in proportion, and a small kind is not lost');
  });
  it('keeps every kind even when there are more kinds than the target', () => {
    const { reps } = pickRepresentatives(50, (i) => `k${i}`, 10);
    assert.equal(reps.length, 50);
  });
  it('spreads each kind evenly over the people given (so over teams)', () => {
    const { reps } = pickRepresentatives(1000, () => 'x', 10);
    assert.deepEqual(reps.map((r) => Math.floor(r / 100)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('loads each representative with about the same number of followers', () => {
    const { reps, repOf } = pickRepresentatives(10_000, () => 'x', 100);
    const n = new Array(reps.length).fill(0); repOf.forEach((r) => n[r]++);
    assert.ok(Math.max(...n) - Math.min(...n) <= 1);
  });
});
