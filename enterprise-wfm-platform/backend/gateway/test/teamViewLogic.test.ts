/** Who may see the team view, which days, and what each person's status says. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { accessFor, clampDate, coveredByPublished, dateWindow, shownStatus, statusOf } from '../src/modules/teamViewLogic.ts';

describe('who sees what', () => {
  it('a team lead always sees their people, whatever the setting', () => {
    for (const s of ['MANAGERS', 'PEERS_NOW', 'PEERS_ROSTER'] as const) assert.equal(accessFor(s, true, true), 'FULL');
    assert.equal(accessFor('MANAGERS', true, false), 'FULL', 'a lead with no team of their own still leads');
  });
  it('a colleague sees nothing by default, and only their own team when allowed', () => {
    assert.equal(accessFor('MANAGERS', false, true), 'NONE');
    assert.equal(accessFor('PEERS_NOW', false, true), 'PEERS_NOW');
    assert.equal(accessFor('PEERS_ROSTER', false, true), 'PEERS_ROSTER');
    assert.equal(accessFor('PEERS_ROSTER', false, false), 'NONE', 'no team, nothing to show');
  });
  it('a colleague never learns that someone is on leave, and the "now" view names only people on shift', () => {
    assert.equal(shownStatus('FULL', 'LEAVE'), 'LEAVE');
    assert.equal(shownStatus('PEERS_ROSTER', 'LEAVE'), 'OFF');
    assert.equal(shownStatus('PEERS_ROSTER', 'LATER'), 'LATER');
    assert.equal(shownStatus('PEERS_NOW', 'ON_NOW'), 'ON_NOW');
    for (const s of ['LATER', 'DONE', 'OFF', 'LEAVE', 'WORKING'] as const) assert.equal(shownStatus('PEERS_NOW', s), null, `${s} is not shown to a colleague in the now view`);
  });
});

describe('which days', () => {
  it('colleagues see the present only, a week ahead with the roster; leads a wider window', () => {
    assert.deepEqual(dateWindow('PEERS_NOW', '2026-11-16'), { from: '2026-11-16', to: '2026-11-16' });
    assert.deepEqual(dateWindow('PEERS_ROSTER', '2026-11-16'), { from: '2026-11-16', to: '2026-11-23' });
    assert.deepEqual(dateWindow('FULL', '2026-11-16'), { from: '2026-11-02', to: '2027-01-15' });
  });
  it('a date outside the window is pulled back inside it, and none means today', () => {
    assert.equal(clampDate('PEERS_NOW', '2026-11-16', '2026-12-25'), '2026-11-16');
    assert.equal(clampDate('PEERS_ROSTER', '2026-11-16', '2026-11-10'), '2026-11-16');
    assert.equal(clampDate('PEERS_ROSTER', '2026-11-16', '2026-11-20'), '2026-11-20');
    assert.equal(clampDate('FULL', '2026-11-16'), '2026-11-16');
  });
});

describe('a person\'s day', () => {
  const noon = 48, day = { shifts: [{ startSlot: 36, lengthSlots: 32 }], spillSlots: 0, leave: false };      // 09:00 to 17:00
  it('says on shift now, later or done by the clock', () => {
    assert.equal(statusOf(day, noon), 'ON_NOW');
    assert.equal(statusOf(day, 30), 'LATER');
    assert.equal(statusOf(day, 80), 'DONE');
    assert.equal(statusOf(day, null), 'WORKING', 'another day: working, no clock');
  });
  it('is off, or on leave, when there is no shift', () => {
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: false }, noon), 'OFF');
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: true }, noon), 'LEAVE');
  });
  it('counts last night\'s overnight shift until it ends', () => {
    const night = { shifts: [], spillSlots: 24, leave: false };                // ran until 06:00 this morning
    assert.equal(statusOf(night, 20), 'ON_NOW');
    assert.equal(statusOf(night, 30), 'OFF');
    assert.equal(statusOf(night, null), 'WORKING');
  });
  it('a shift that runs past midnight counts as on now until the end of the day', () => {
    const late = { shifts: [{ startSlot: 88, lengthSlots: 16 }], spillSlots: 0, leave: false };      // 22:00 to 02:00
    assert.equal(statusOf(late, 90), 'ON_NOW');
    assert.equal(statusOf(late, 80), 'LATER');
  });
});

describe('a day nobody has published', () => {
  it('is "not published", not "off", when no schedule covers the person', () => {
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: false, published: false }, 48), 'UNPUBLISHED');
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: false, published: false }, null), 'UNPUBLISHED');
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: false, published: true }, 48), 'OFF');
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: false }, 48), 'OFF', 'unknown counts as published');
  });
  it('approved leave still says leave, and a shift still says on shift', () => {
    assert.equal(statusOf({ shifts: [], spillSlots: 0, leave: true, published: false }, 48), 'LEAVE');
    assert.equal(statusOf({ shifts: [{ startSlot: 36, lengthSlots: 32 }], spillSlots: 0, leave: false, published: false }, 48), 'ON_NOW');
  });
  it('is covered when any group the person works in has a published schedule', () => {
    assert.equal(coveredByPublished(['g1', 'g2'], new Set(['g2'])), true);
    assert.equal(coveredByPublished(['g1', null, undefined], new Set(['g2'])), false);
    assert.equal(coveredByPublished([], new Set(['g2'])), false);
  });
  it('colleagues in the roster view are told a day is not published; the now view still names only people on shift', () => {
    assert.equal(shownStatus('PEERS_ROSTER', 'UNPUBLISHED'), 'UNPUBLISHED');
    assert.equal(shownStatus('PEERS_NOW', 'UNPUBLISHED'), null);
    assert.equal(shownStatus('FULL', 'UNPUBLISHED'), 'UNPUBLISHED');
  });
});
