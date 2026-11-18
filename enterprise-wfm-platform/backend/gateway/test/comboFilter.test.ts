import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterGroups, flatten, labelFor, step, type ComboGroup } from '../../../src/services/comboFilter.ts';

const groups: ComboGroup[] = [
  { label: 'Common', items: [{ value: 'UTC', label: 'UTC' }, { value: 'Africa/Nairobi', label: 'Nairobi (UTC+3)', right: 'UTC+3 · 21:45' }] },
  { label: 'Africa', items: [{ value: 'Africa/Lagos', label: 'Lagos (UTC+1)', right: 'UTC+1 · 19:45' }, { value: 'Africa/Nairobi', label: 'Nairobi (UTC+3)', right: 'UTC+3 · 21:45', keywords: 'Africa/Nairobi' }] },
  { label: 'Asia', items: [{ value: 'Asia/Kolkata', label: 'Kolkata (UTC+5:30)', keywords: 'Asia/Kolkata calcutta' }, { value: 'Asia/Kuwait', label: 'Kuwait (UTC+3)' }] },
];

describe('searchable list', () => {
  it('keeps everything for an empty search', () => assert.equal(filterGroups(groups, '  ').length, 3));
  it('finds by part of the name, ignoring case', () => {
    assert.deepEqual(flatten(filterGroups(groups, 'nai')).map((i) => i.value), ['Africa/Nairobi']);
    assert.deepEqual(flatten(filterGroups(groups, 'KOL')).map((i) => i.value), ['Asia/Kolkata']);
  });
  it('lists a value shown in two groups once while searching, and drops groups with nothing left', () => {
    const r = filterGroups(groups, 'nairobi');
    assert.equal(flatten(r).length, 1); assert.deepEqual(r.map((g) => g.label), ['Common']);
  });
  it('needs every word, and looks in the offset, the keywords and the full name', () => {
    assert.deepEqual(flatten(filterGroups(groups, '+3')).map((i) => i.value).sort(), ['Africa/Nairobi', 'Asia/Kuwait']);
    assert.deepEqual(flatten(filterGroups(groups, 'calcutta')).map((i) => i.value), ['Asia/Kolkata']);
    assert.deepEqual(flatten(filterGroups(groups, 'africa lagos')).map((i) => i.value), ['Africa/Lagos']);
    assert.equal(flatten(filterGroups(groups, 'nairobi paris')).length, 0);
  });
  it('ignores accents', () => assert.equal(flatten(filterGroups([{ label: 'x', items: [{ value: 'a', label: 'Zürich' }] }], 'zurich')).length, 1));
  it('moves the highlight with the arrow keys, wrapping at both ends', () => {
    assert.equal(step(-1, 1, 5), 0); assert.equal(step(-1, -1, 5), 4);
    assert.equal(step(4, 1, 5), 0); assert.equal(step(0, -1, 5), 4); assert.equal(step(2, 1, 5), 3);
    assert.equal(step(0, 1, 0), -1);
  });
  it('shows the label for the chosen value, or the value itself when it is not listed', () => {
    assert.equal(labelFor(groups, 'Africa/Lagos'), 'Lagos (UTC+1)');
    assert.equal(labelFor(groups, 'Custom/Place'), 'Custom/Place');
  });
});
