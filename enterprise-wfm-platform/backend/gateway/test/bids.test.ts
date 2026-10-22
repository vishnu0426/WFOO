/** Shift bidding: the allocation methods on their own. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allocate, hungarian, pickOrder, summarise, type Bidder } from '../src/modules/bids/logic.ts';

const b = (n: string, hire: string | null = null): Bidder => ({ id: `id-${n}`, employeeNumber: n, hireDate: hire });
const got = (l: ReturnType<typeof allocate>) => Object.fromEntries(l.map((a) => [a.employeeId.slice(3), a.patternId]));

describe('the assignment step', () => {
  it('finds the cheapest complete assignment', () => {
    assert.deepEqual(hungarian([[4, 1, 3], [2, 0, 5], [3, 2, 2]]), [1, 0, 2]);        // total 1 + 2 + 2 = 5, better than the greedy 1 + ... alternatives
    assert.deepEqual(hungarian([[1, 2], [1, 2], [9, 9]].slice(0, 2)), [0, 1]);
  });
});

describe('who gets which pattern', () => {
  const patterns = [{ id: 'early', capacity: 1 }, { id: 'day', capacity: 2 }, { id: 'late', capacity: 1 }];
  const people = [b('E1', '2020-01-01'), b('E2', '2018-01-01'), b('E3', '2022-01-01'), b('E4', '2016-01-01')];
  const ranks = new Map([['id-E1', ['early', 'day']], ['id-E2', ['early', 'late']], ['id-E3', ['early', 'day', 'late']], ['id-E4', ['early']]]);
  const fitsAll = () => true;

  it('seniority: the longest-serving person picks first, and the rest take what is left', () => {
    const r = got(allocate({ bidders: people, patterns, ranks, fits: fitsAll, method: 'SENIORITY', seed: 's' }));
    assert.equal(r.E4, 'early');                       // hired 2016, first pick
    assert.equal(r.E2, 'late');                         // wanted early (gone), then late
    assert.equal(r.E1, 'day');
    assert.equal(r.E3, 'day');                          // second choice full? day has room for two
  });

  it('lottery: the same seed gives the same result, and it differs with the seed', () => {
    const run = (seed: string) => JSON.stringify(allocate({ bidders: people, patterns, ranks, fits: fitsAll, method: 'LOTTERY', seed }));
    assert.equal(run('a'), run('a'));
    assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(run)).size > 1);
  });

  it('balanced: never worse overall than any pick order, and nobody gets more than the capacity', () => {
    const cost = (l: ReturnType<typeof allocate>) => l.reduce((s, a) => s + (a.rank ?? 40) ** 2, 0);
    const bal = allocate({ bidders: people, patterns, ranks, fits: fitsAll, method: 'BALANCED', seed: 's' });
    for (const m of ['SENIORITY', 'LOTTERY'] as const) assert.ok(cost(bal) <= cost(allocate({ bidders: people, patterns, ranks, fits: fitsAll, method: m, seed: 'x' })));
    for (const p of patterns) assert.ok(bal.filter((a) => a.patternId === p.id).length <= p.capacity);
    assert.equal(bal.filter((a) => a.patternId).length, 4);
  });

  it('never gives a pattern that would break a rule for that person, and leaves them without one if nothing fits', () => {
    const fits = (e: string, p: string) => !(e === 'id-E4' && p === 'early');
    const r = got(allocate({ bidders: people, patterns, ranks, fits, method: 'SENIORITY', seed: 's' }));
    assert.notEqual(r.E4, 'early');
    const none = allocate({ bidders: [b('E9')], patterns, ranks: new Map(), fits: () => false, method: 'BALANCED', seed: 's' });
    assert.equal(none[0].patternId, null);
  });

  it('gives people who did not rank anything what is left, or nothing when told not to', () => {
    const quiet = [b('E1', '2020-01-01'), b('E2', '2019-01-01')];
    assert.ok(allocate({ bidders: quiet, patterns, ranks: new Map(), fits: fitsAll, method: 'SENIORITY', seed: 's' }).every((a) => a.patternId));
    assert.ok(allocate({ bidders: quiet, patterns, ranks: new Map(), fits: fitsAll, method: 'SENIORITY', seed: 's', fillUnranked: false }).every((a) => a.patternId === null));
  });

  it('serves what people ranked before handing leftovers to people who ranked nothing', () => {
    const two = [{ id: 'only', capacity: 1 }];
    const r = got(allocate({ bidders: [b('E1', '2010-01-01'), b('E2', '2020-01-01')], patterns: two, ranks: new Map([['id-E2', ['only']]]), fits: () => true, method: 'SENIORITY', seed: 's' }));
    assert.equal(r.E2, 'only');                       // E1 is more senior but asked for nothing
    assert.equal(r.E1, null);
  });

  it('orders by hire date with employee number as the tie-break, and summarises the outcome', () => {
    assert.deepEqual(pickOrder([b('E2', '2020-01-01'), b('E1', '2020-01-01'), b('E3', null)], 'SENIORITY', 's').map((x) => x.employeeNumber), ['E1', 'E2', 'E3']);
    const s = summarise([{ employeeId: 'a', patternId: 'p', rank: 1 }, { employeeId: 'b', patternId: 'p', rank: 2 }, { employeeId: 'c', patternId: null, rank: null }, { employeeId: 'd', patternId: 'q', rank: 1 }]);
    assert.deepEqual(s, { people: 4, assigned: 3, unassigned: 1, byRank: { '1': 2, '2': 1 }, firstChoicePercent: 50 });
  });
});
