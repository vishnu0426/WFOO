import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planCopy, summarise, type ActivityRow } from '../src/modules/activityCopy.ts';

const act = (o: Partial<ActivityRow> & { code: string }): ActivityRow => ({
  id: `id-${o.code}`, name: o.code[0] + o.code.slice(1).toLowerCase(), shortCode: o.code.slice(0, 2), category: 'OTHER', countsAsWork: false, paid: true, shrinkage: true,
  ignoreAdherence: false, color: '#8AA4C8', textColor: null, status: 'ACTIVE', ...o,
});

describe('planCopy', () => {
  it('creates what is not there', () => {
    const r = planCopy([act({ code: 'COACHING' })], [], 'SKIP');
    assert.equal(r[0].state, 'NEW'); assert.equal(r[0].action, 'CREATE');
  });
  it('leaves an identical one alone, and matches code regardless of case', () => {
    const r = planCopy([act({ code: 'COACHING' })], [act({ code: 'coaching', name: 'Coaching' })], 'OVERWRITE');
    assert.equal(r[0].state, 'SAME'); assert.equal(r[0].action, 'SKIP');
  });
  it('names what differs, and only overwrites when asked', () => {
    const src = [act({ code: 'BREAK', color: '#FF0000', paid: false })], tgt = [act({ code: 'BREAK' })];
    const keep = planCopy(src, tgt, 'SKIP')[0], over = planCopy(src, tgt, 'OVERWRITE')[0];
    assert.deepEqual(keep.changes, ['paid', 'colour']);
    assert.equal(keep.action, 'SKIP'); assert.equal(over.action, 'UPDATE'); assert.equal(over.targetId, 'id-BREAK');
  });
  it('does not create an activity whose name another one already uses', () => {
    const r = planCopy([act({ code: 'MEAL_2', name: 'Meal' })], [act({ code: 'MEAL', name: 'Meal' })], 'OVERWRITE');
    assert.equal(r[0].state, 'NAME_TAKEN'); assert.equal(r[0].action, 'SKIP');
  });
  it('does not overwrite into a name a third activity holds', () => {
    const r = planCopy([act({ code: 'A', name: 'Taken' })], [act({ code: 'A', name: 'Old' }), act({ code: 'B', name: 'Taken' })], 'OVERWRITE');
    assert.equal(r[0].state, 'DIFFERS'); assert.equal(r[0].action, 'SKIP');
  });
});

describe('summarise', () => {
  it('says it in one line', () => {
    const items = planCopy([act({ code: 'A' }), act({ code: 'B' }), act({ code: 'C', paid: false })], [act({ code: 'B' }), act({ code: 'C' })], 'SKIP');
    assert.equal(summarise(items), '1 created, 1 already the same, 1 left as they were (different)');
    assert.equal(summarise([]), 'nothing to copy');
  });
});
