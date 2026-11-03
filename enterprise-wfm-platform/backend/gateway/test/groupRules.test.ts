import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanAliases, diffFields, GROUP_FILE_TEMPLATE, impactChanges, parseGroupFile } from '../src/modules/groupRules.ts';
import { parseCsv } from '../src/modules/csv.ts';

describe('which edits need a reason', () => {
  const before = { name: 'Support', description: 'old', serviceLevelGoal: 80, shrinkagePercent: 30, payWeekStart: null, timezone: 'UTC', status: 'ACTIVE', blended: false };
  it('names what really moves staffing or pay', () => {
    assert.deepEqual(impactChanges(before, { serviceLevelGoal: 85, payWeekStart: 6 }), ['service level goal', 'pay week start']);
  });
  it('ignores a value sent back unchanged, and fields that do not matter', () => {
    assert.deepEqual(impactChanges(before, { serviceLevelGoal: 80, shrinkagePercent: 30, payWeekStart: null, timezone: 'UTC' }), []);
    assert.deepEqual(impactChanges(before, { name: 'Support 2', description: 'new' }), []);
  });
  it('counts switching a group off and changing the time zone', () => {
    assert.deepEqual(impactChanges(before, { status: 'INACTIVE', timezone: 'Asia/Kolkata' }), ['time zone', 'status']);
  });
  it('a pay week set back to the company default is a change', () => {
    assert.deepEqual(impactChanges({ ...before, payWeekStart: 0 }, { payWeekStart: null }), ['pay week start']);
  });
});

describe('queue aliases', () => {
  it('trims, drops blanks and repeats, keeps the order', () => {
    assert.deepEqual(cleanAliases([' TS_VOICE ', '', 'ts_voice', 'Tech Support', '  ']), ['TS_VOICE', 'Tech Support']);
    assert.deepEqual(cleanAliases(undefined), []);
  });
});

describe('history of a group', () => {
  it('lists the fields that changed and skips bookkeeping', () => {
    const d = diffFields({ name: 'A', shrinkagePercent: 30, updatedAt: '1' }, { name: 'A', shrinkagePercent: 25, updatedAt: '2' });
    assert.deepEqual(d, [{ field: 'shrinkagePercent', from: 30, to: 25 }]);
    assert.deepEqual(diffFields(null, { a: 1 }), []);
  });
});

describe('a file of groups and queues', () => {
  it('reads the template that ships with the page', () => {
    const r = parseGroupFile(parseCsv(GROUP_FILE_TEMPLATE));
    assert.deepEqual(r.errors, []);
    assert.equal(r.groups.length, 1);
    assert.equal(r.groups[0].queues.length, 2);
    assert.deepEqual(r.groups[0].queues[0].aliases, ['TS_VOICE', 'Tech Support Voice']);
    assert.equal(r.groups[0].serviceLevelGoal, 80);
    assert.equal(r.groups[0].site, 'Chennai');
  });
  it('groups rows by group name, case ignored, and skips blank rows', () => {
    const r = parseGroupFile(parseCsv('group,queue,channel\nSales,A,VOICE\n,,\nsales,B,chat\nBilling,C,EMAIL\n'));
    assert.deepEqual(r.errors, [{ line: 3, message: 'The group name is empty.' }].filter(() => false));
    assert.deepEqual(r.groups.map((g) => [g.name, g.queues.map((q) => q.channel)]), [['Sales', ['VOICE', 'CHAT']], ['Billing', ['EMAIL']]]);
  });
  it('says what is wrong, with the line', () => {
    const r = parseGroupFile(parseCsv('group,timezone,service_level_goal,queue,channel,handle_time_sec\nA,Mars/Base,150,Q1,PHONE,300\nB,UTC,80,Q2,VOICE,0\nB,,,Q2,VOICE,300\n'));
    const msgs = r.errors.map((e) => `${e.line}: ${e.message}`);
    assert.ok(msgs.some((m) => /^2: 'Mars\/Base' is not a time zone/.test(m)), msgs.join('\n'));
    assert.ok(msgs.some((m) => /^2: Service level goal '150' must be a number from 1 to 99/.test(m)), msgs.join('\n'));
    assert.ok(msgs.some((m) => /^2: Channel 'PHONE' must be/.test(m)), msgs.join('\n'));
    assert.ok(msgs.some((m) => /^3: Handle time '0' must be a number from 1 to 7200/.test(m)), msgs.join('\n'));
    assert.ok(msgs.some((m) => /^4: The queue 'Q2' is listed twice in B/.test(m)), msgs.join('\n'));
  });
  it('needs a group column', () => {
    assert.match(parseGroupFile(parseCsv('queue,channel\nQ,VOICE\n')).errors[0].message, /No group column/);
    assert.match(parseGroupFile(parseCsv('group\n')).errors[0].message, /no data rows/);
  });
  it('a group with no queue is fine', () => {
    const r = parseGroupFile(parseCsv('group,description\nBack office,Cases\n'));
    assert.deepEqual(r.errors, []); assert.equal(r.groups[0].queues.length, 0);
  });
});
