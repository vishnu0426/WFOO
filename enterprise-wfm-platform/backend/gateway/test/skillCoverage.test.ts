/**
 * Skill coverage risk, against cases worked out by hand. No database needed:
 *   npx tsx --test --test-force-exit test/skillCoverage.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { riskOf } from '../src/modules/skillCoverage.ts';

const req = (name: string, minProficiency: number, qualified: number) => ({ groupId: name, groupName: name, minProficiency, qualified });

describe('how well a skill is covered', () => {
  it('is fine when enough people hold it and nothing requires more', () => {
    assert.deepEqual(riskOf({ activeHolders: 5, requiredBy: [] }, 3), { level: 'OK', reason: null, requiredByGroups: 0, fixGroupId: null });
  });

  it('is thin when fewer than the threshold hold it, and says how many', () => {
    const r = riskOf({ activeHolders: 1, requiredBy: [] }, 3);
    assert.equal(r.level, 'THIN');
    assert.equal(r.reason, 'Only 1 person can work it');
    assert.equal(riskOf({ activeHolders: 2, requiredBy: [] }, 3).reason, 'Only 2 people can work it');
    assert.equal(riskOf({ activeHolders: 3, requiredBy: [] }, 3).level, 'OK', 'exactly the threshold is enough');
  });

  it('judges a skill a group requires by the people qualified for that group, not by everyone who has it', () => {
    // 10 people have French, but only 1 is level 3 or higher in the Support group that asks for level 3
    const r = riskOf({ activeHolders: 10, requiredBy: [req('Support', 3, 1)] }, 3);
    assert.equal(r.level, 'THIN');
    assert.equal(r.reason, 'Only 1 person is qualified for Support at level 3 or higher');
    assert.equal(r.requiredByGroups, 1);
  });

  it('says WHY nobody is qualified: the people who have it are outside the group', () => {
    const r = riskOf({ activeHolders: 1, requiredBy: [{ ...req('Support', 3, 0), outsideQualified: 1, inGroupHolders: 0 }] }, 3);
    assert.equal(r.level, 'NONE');
    assert.equal(r.reason, '1 person has it at level 3 or higher but is not eligible for Support, which requires it');
    assert.equal(r.fixGroupId, 'Support');
  });

  it('says WHY nobody is qualified: people in the group have it, below the level asked for', () => {
    const r = riskOf({ activeHolders: 4, requiredBy: [{ ...req('Support', 4, 0), outsideQualified: 0, inGroupHolders: 2 }] }, 3);
    assert.equal(r.reason, '2 people in Support have it, but below level 4, which Support requires');
  });

  it('says WHY nobody is qualified: nobody in the group has it at all', () => {
    const r = riskOf({ activeHolders: 0, requiredBy: [{ ...req('Support', 1, 0), outsideQualified: 0, inGroupHolders: 0 }] }, 3);
    assert.equal(r.reason, 'Nobody in Support has it, and Support requires it');
  });

  it('mentions the people who could simply be added to the group in a thin flag too, and offers the fix', () => {
    const r = riskOf({ activeHolders: 4, requiredBy: [{ ...req('Support', 3, 1), outsideQualified: 2, inGroupHolders: 1 }] }, 3);
    assert.equal(r.level, 'THIN');
    assert.equal(r.reason, 'Only 1 person is qualified for Support at level 3 or higher; 2 people more have it but are not eligible for it');
    assert.equal(r.fixGroupId, 'Support');
  });

  it('offers no group fix for a skill no group requires', () => {
    assert.equal(riskOf({ activeHolders: 1, requiredBy: [] }, 3).fixGroupId, null);
  });

  it('says plainly when nobody holds a skill and nothing requires it, so it is not an alarm', () => {
    const r = riskOf({ activeHolders: 0, requiredBy: [] }, 3);
    assert.equal(r.level, 'NONE');
    assert.match(r.reason ?? '', /No group requires it, so nothing is affected yet/);
  });

  it('reports the worst group when several require it', () => {
    const r = riskOf({ activeHolders: 9, requiredBy: [req('A', 1, 8), req('B', 2, 2), req('C', 1, 1)] }, 3);
    assert.equal(r.level, 'THIN');
    assert.match(r.reason ?? '', /Only 1 person is qualified for C/);
  });

  it('treats a threshold of zero or a fraction as at least one person', () => {
    assert.equal(riskOf({ activeHolders: 1, requiredBy: [] }, 0).level, 'OK');
    assert.equal(riskOf({ activeHolders: 0, requiredBy: [] }, 0.4).level, 'NONE');
  });
});
