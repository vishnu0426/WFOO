import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contractFit, contractFitNote, weeklyCapHours } from '../src/modules/contractFit.ts';

describe('contract fit', () => {
  it('a 20 h contract cannot be made from 8 h shifts, within 1 h', () => {
    const r = contractFit([32], 5, 80, 84);                 // 8 h shifts, 20 h to 21 h
    assert.equal(r.ok, false);
    assert.equal(r.closest, 96);                             // three shifts: 24 h
  });
  it('can be made from 5 h shifts, or from 4 and 6 h shifts', () => {
    assert.equal(contractFit([20], 5, 80, 84).ok, true);
    assert.equal(contractFit([16, 24], 5, 80, 84).ok, true);
  });
  it('respects how many shifts the person may work in a week', () => {
    assert.equal(contractFit([16], 4, 80, 84).ok, false);    // 4 h shifts, at most 4 of them: 16 h
    assert.equal(contractFit([16], 5, 80, 84).ok, true);
  });
  it('a 30 h contract works from a mix of 6 h and 8 h shifts', () => {
    assert.equal(contractFit([24, 32], 5, 120, 124).ok, true);   // 5 x 6 h
  });
  it('holds part-time, contract and temporary staff to contract plus a tolerance, and leaves the rest alone', () => {
    assert.equal(weeklyCapHours({ employmentType: 'PART_TIME', contractHours: 20, maxHours: 48 }, 1), 21);
    assert.equal(weeklyCapHours({ employmentType: 'CONTRACT', contractHours: 30, maxHours: 32 }, 4), 32);
    assert.equal(weeklyCapHours({ employmentType: 'FULL_TIME', contractHours: 40, maxHours: 48 }, 1), 48);
    assert.equal(weeklyCapHours({ employmentType: 'PART_TIME', contractHours: 0, maxHours: 24 }, 1), 24);       // on call: no contract to hold them to
    assert.equal(weeklyCapHours({ employmentType: 'PART_TIME', contractHours: 20, maxHours: 48 }, null), 48);   // setting off
  });
  it('words the report line and says nothing when everyone fits', () => {
    assert.equal(contractFitNote([], 1), null);
    const n = contractFitNote([{ name: 'A B', contractHours: 20, closestHours: 24 }], 1)!;
    assert.match(n.message, /A B/);
    assert.match(n.message, /shorter shifts/);
  });
});
