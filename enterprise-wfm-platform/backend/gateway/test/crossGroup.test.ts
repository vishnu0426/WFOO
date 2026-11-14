/**
 * One person in several WFM groups: what they work for the other groups counts toward the same limits. One shift a day across groups, rest between a
 * shift here and one for another group, and the week's hours, days and days in a row. These run without a stack.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'unit-test-only-secret-0123456789abcdef';
const { blockedReason, validateShifts } = await import('../src/modules/scheduleRoutes.ts');
const { guestText } = await import('../src/modules/sharedPeople.ts');
import type { Ctx } from '../src/modules/scheduleRoutes.ts';

const MON = '2026-11-09';                                    // a Monday
const day = (n: number) => { const d = new Date(Date.parse(MON) + n * 86400000); return d.toISOString().slice(0, 10); };
const ramesh = { id: 'r', firstName: 'Ramesh', lastName: 'K', status: 'ACTIVE', primaryGroupId: 'g1', eligibleGroupIds: ['g1', 'g2'], minRestHours: 11, maxWeeklyHours: 40, workDaysPerWeek: 5, maxConsecutiveDays: 6, allowWeekend: true, allowOvernight: true, teamId: null };
const tpl = { id: 't', name: 'Day', workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: 0, latestStart: 96, startStep: 1, lengthSlots: 34, mealSlots: 2, flexSlots: 0 };
const other = (n: number, startSlot = 32, lengthSlots = 34, groupName = 'Billing') => ({ employeeId: 'r', day: day(n), startSlot, lengthSlots, groupName, paidSlots: lengthSlots - 2 });
const ctxWith = (others: Ctx['others']): Ctx => ({ group: { id: 'g1' }, employees: [ramesh], templates: [tpl], timeOff: [], avail: [], tz: 'UTC', rules: { forTeam: () => [] } as any, skillBased: false, weekStart: 0, others });
const mine = (n: number, startSlot = 32, lengthSlots = 34) => ({ employeeId: 'r', day: day(n), startSlot, lengthSlots, templateId: 't' });

describe('one shift a day across groups', () => {
  it('a day already worked for another group is closed, even at a different time', () => {
    const ctx = ctxWith([other(0, 24, 34)]);                     // 06:00-14:30 for Billing
    assert.match(blockedReason(ctx, ramesh, day(0), 64, 34)!, /already works a shift for Billing that day/);
    assert.match(blockedReason(ctx, ramesh, day(0), 24, 34)!, /already scheduled for Billing then/, 'an overlap still says so');
    assert.equal(blockedReason(ctx, ramesh, day(1), 32, 34), null, 'the next day is free');
  });
});

describe('rest between a shift here and one for another group', () => {
  it('too little rest after the other group\'s shift the day before', () => {
    const ctx = ctxWith([other(0, 64, 34)]);                     // 16:00-00:30 (ends 30 min after midnight) for Billing on Monday
    assert.match(blockedReason(ctx, ramesh, day(1), 8, 34)!, /too little rest after their shift for Billing the day before/);   // starts 02:00: only 1.5 h
    assert.equal(blockedReason(ctx, ramesh, day(1), 8 + 40, 34), null, 'starts 14:00: 13.5 h of rest');
  });
  it('too little rest before the other group\'s shift the next day', () => {
    const ctx = ctxWith([other(1, 28, 34)]);                     // starts 07:00 on Tuesday
    assert.match(blockedReason(ctx, ramesh, day(0), 48, 34)!, /too little rest before their shift for Billing the next day/);   // ends 20:30: only 10.5 h
    assert.equal(blockedReason(ctx, ramesh, day(0), 36, 34), null, 'ends 17:30: 13.5 h of rest');
  });
});

describe('validation counts the other group\'s shifts toward the same limits', () => {
  it('days in the week: 3 for another group + 3 here is 6 against a maximum of 5', () => {
    const ctx = ctxWith([other(0), other(1), other(2)]);
    const v = validateShifts(ctx, [mine(3), mine(4), mine(5)]);
    const hit = v.find((x) => x.type === 'DAYS_PER_WEEK');
    assert.ok(hit, JSON.stringify(v)); assert.match(hit!.message, /6 days in the week.*3 of them for Billing/);
  });
  it('hours in the week: 24 h elsewhere + 24 h here is over 40 h, and the message says how much is elsewhere', () => {
    const ctx = ctxWith([other(0), other(1), other(2)]);          // 3 x 16 h? no: 34 slots, 2 paid off = 8 h each = 24 h
    const v = validateShifts(ctx, [mine(3), mine(4), mine(5)]);
    const hit = v.find((x) => x.type === 'WEEKLY_MAX');
    assert.ok(hit, JSON.stringify(v)); assert.match(hit!.message, /48h in the week.*24h of it for Billing/);
  });
  it('days in a row: five elsewhere then two here is seven, against a maximum of six, reported on the day it happens here', () => {
    const ctx = ctxWith([0, 1, 2, 3, 4].map((n) => other(n)));
    const v = validateShifts(ctx, [mine(5), mine(6)]);
    const hit = v.find((x) => x.type === 'CONSECUTIVE');
    assert.ok(hit, JSON.stringify(v)); assert.equal(hit!.day, day(6)); assert.match(hit!.message, /counting the days for Billing/);
  });
  it('rest: the other group\'s late shift and a too-early start here', () => {
    const ctx = ctxWith([other(0, 64, 34)]);                      // ends 00:30 on Tuesday
    const v = validateShifts(ctx, [mine(1, 8, 34)]);               // starts 02:00 on Tuesday
    assert.ok(v.some((x) => x.type === 'REST' && /after the shift for Billing/.test(x.message)), JSON.stringify(v));
  });
  it('a person within every limit, counting both groups, has no violations', () => {
    const ctx = ctxWith([other(0), other(1)]);
    const v = validateShifts(ctx, [mine(2), mine(3), mine(4)]).filter((x) => !x.type.startsWith('LAW_'));
    assert.deepEqual(v, []);
  });
  it('nothing changes for a person with no shifts elsewhere', () => {
    const v = validateShifts(ctxWith([]), [mine(0), mine(1), mine(2), mine(3), mine(4), mine(5)]).filter((x) => !x.type.startsWith('LAW_'));
    assert.ok(v.some((x) => x.type === 'DAYS_PER_WEEK') && !v.some((x) => /for Billing/.test(x.message)), JSON.stringify(v));
  });
});

describe('home group', () => {
  it('a day held for the home group is closed for a guest, and only that day', () => {
    const ctx = { ...ctxWith([]), held: new Map([['r', new Set([day(2)])]]) };
    assert.match(blockedReason(ctx, ramesh, day(2), 32, 34)!, /held for their home group, which has no schedule for that day yet/);
    assert.equal(blockedReason(ctx, ramesh, day(3), 32, 34), null);
    assert.equal(blockedReason(ctxWith([]), ramesh, day(2), 32, 34), null, 'nothing is held without a hold');
  });
  it('the report line is a warning while days are held back, and information otherwise', () => {
    const held = guestText({ guests: 2, heldDays: 5, homeNames: ['Billing', 'Sales'], draftShifts: 0 });
    assert.equal(held.level, 'WARNING'); assert.match(held.message, /2 people are guests here \(their home group is Billing, Sales\)/); assert.match(held.message, /5 of their days were held back/);
    const fine = guestText({ guests: 1, heldDays: 0, homeNames: ['Billing'], draftShifts: 3 });
    assert.equal(fine.level, 'INFO'); assert.match(fine.message, /1 person is a guest/); assert.match(fine.message, /3 shifts for them are respected as if published/);
  });
});
