/**
 * Why builds took 20-75 minutes: the "can this person work this shift?" check scanned every other group's published shifts (and every person's time off and
 * availability) once per candidate shift. It now looks up the one person's rows. These run without a stack.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// the gateway's config insists on these being set; nothing here connects to them
process.env.DATABASE_URL ||= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ||= 'unit-test-only-secret-0123456789abcdef';
const { blockedReason } = await import('../src/modules/scheduleRoutes.ts');
import type { Ctx } from '../src/modules/scheduleRoutes.ts';

const DAY = '2026-11-09';                                   // a Monday
const person = { id: 'p1', allowWeekend: true, allowOvernight: true };
const ctxWith = (over: Partial<Ctx>): Ctx => ({ group: {}, employees: [], templates: [], timeOff: [], avail: [], tz: 'UTC', rules: {} as any, skillBased: false, weekStart: 0, others: [], ...over });

describe('blockedReason answers from one person\'s own rows', () => {
  it('still sees a shift in another group, and only that person\'s, only that day, only where the times overlap', () => {
    const ctx = ctxWith({ others: [
      { employeeId: 'p1', day: DAY, startSlot: 32, lengthSlots: 32, groupName: 'Billing' },
      { employeeId: 'p2', day: DAY, startSlot: 0, lengthSlots: 96, groupName: 'Sales' },
      { employeeId: 'p1', day: '2026-11-10', startSlot: 0, lengthSlots: 96, groupName: 'Sales' },
    ] });
    assert.equal(blockedReason(ctx, person, DAY, 40, 16), 'is already scheduled for Billing then');
    assert.equal(blockedReason(ctx, person, DAY, 64, 16), null, 'starts exactly when the other shift ends');
    assert.equal(blockedReason(ctx, person, DAY, 0, 32), null, 'ends exactly when the other shift starts');
  });
  it('still applies time off and availability to the right person', () => {
    const ctx = ctxWith({
      timeOff: [{ employeeId: 'p1', startDay: DAY, endDay: DAY }],
      avail: [{ employeeId: 'p2', dayOfWeek: 1, startSlot: 36, endSlot: 68, kind: 'AVAILABLE' }],
    });
    assert.equal(blockedReason(ctx, person, DAY, 36, 16), 'has approved time off');
    assert.equal(blockedReason(ctx, person, '2026-11-10', 36, 16), null, 'someone else\'s availability does not limit p1');
    const p2 = { ...person, id: 'p2' };
    assert.equal(blockedReason(ctx, p2, '2026-11-10', 36, 16), null);
    assert.equal(blockedReason(ctx, p2, '2026-11-10', 20, 16), 'is outside their available hours');
  });
  it('does not slow down as the company\'s published schedules grow', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => ({ employeeId: `x${i % 20_000}`, day: DAY, startSlot: 32, lengthSlots: 32, groupName: 'Other' }));
    const ctx = ctxWith({ others: many, timeOff: many.map((o) => ({ employeeId: o.employeeId, startDay: '2020-01-01', endDay: '2020-01-02' })), avail: many.map((o, i) => ({ employeeId: o.employeeId, dayOfWeek: i % 7, startSlot: 0, endSlot: 96, kind: 'AVAILABLE' })) });
    blockedReason(ctx, person, DAY, 40, 16);                  // builds the lookup once
    const t0 = performance.now();
    for (let k = 0; k < 200_000; k++) blockedReason(ctx, person, DAY, k % 80, 16);
    const ms = performance.now() - t0;
    assert.ok(ms < 2000, `200,000 checks took ${Math.round(ms)} ms with 300,000 shifts elsewhere: the check is scanning them`);
  });
});

describe('formatters for a time zone are built once', () => {
  it('returns the same formatter for the same zone and options, and different ones for different zones', async () => {
    const { tzFmt } = await import('../src/tzFormat.ts');
    const a = tzFmt('en-GB', 'Asia/Kolkata', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    assert.equal(tzFmt('en-GB', 'Asia/Kolkata', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), a);
    assert.notEqual(tzFmt('en-GB', 'Europe/London', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }), a);
    assert.equal(a.format(new Date('2026-11-02T00:00:00Z')), '05:30');
  });
  it('is far quicker than building one for every question', async () => {
    const { tzFmt } = await import('../src/tzFormat.ts');
    const t0 = performance.now();
    for (let i = 0; i < 200_000; i++) tzFmt('en-CA', 'Asia/Kolkata', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(1_700_000_000_000 + i * 60_000));
    assert.ok(performance.now() - t0 < 4000, 'a formatter is being rebuilt on each call');
  });
});
