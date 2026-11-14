import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDay, feedLooksMissing, graceMinutes, headlineIssue, applyExcuses, summarizeFor, wordsFor, minutesFromDay, nowMinutesFrom, problemScore, tally, weekView, type DayFacts } from '../src/modules/attendanceMath.ts';


const shift = { hours: 8, startMin: 9 * 60, endMin: 17 * 60 + 30 };    // 09:00 to 17:30
const base = (over: Partial<DayFacts>): DayFacts => ({ sched: shift, punches: [], nowMin: 24 * 60, graceMin: 5, ...over });
const p = (i: string, o: string | null) => { const m = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)); return { inMin: m(i), outMin: o ? m(o) : null }; };

describe('classifyDay', () => {
  it('a scheduled day with no punch is missed only once the shift is over', () => {
    assert.equal(classifyDay(base({ nowMin: 18 * 60 })).status, 'MISSED');
    assert.deepEqual(classifyDay(base({ nowMin: 18 * 60 })).issues, ['missed']);
    assert.equal(classifyDay(base({ nowMin: 12 * 60 })).status, 'UPCOMING', 'mid-shift: they may just be late');
    assert.equal(classifyDay(base({ nowMin: -600 })).status, 'UPCOMING', 'a day still to come');
    assert.equal(classifyDay(base({ nowMin: 17 * 60 + 33 })).status, 'UPCOMING', 'inside the grace after the shift');
    assert.equal(classifyDay(base({ nowMin: 17 * 60 + 36 })).status, 'MISSED');
  });
  it('on time is OK, and a few minutes either side is within the grace', () => {
    const r = classifyDay(base({ punches: [p('08:58', '17:33')] }));
    assert.equal(r.status, 'MATCHED'); assert.deepEqual(r.issues, ['ok']); assert.equal(r.lateMinutes, 0); assert.equal(r.earlyLeaveMinutes, 0);
    assert.equal(classifyDay(base({ punches: [p('09:05', '17:25')] })).issues[0], 'ok', 'exactly the grace is not late');
  });
  it('late is minutes after the scheduled start, past the grace', () => {
    const r = classifyDay(base({ punches: [p('09:12', '17:30')] }));
    assert.equal(r.lateMinutes, 12); assert.deepEqual(r.issues, ['late']); assert.equal(r.status, 'MATCHED', 'still a matched day for payroll');
  });
  it('early leave is minutes before the scheduled end, and a day can be both', () => {
    const r = classifyDay(base({ punches: [p('09:20', '16:00')] }));
    assert.equal(r.lateMinutes, 20); assert.equal(r.earlyLeaveMinutes, 90); assert.deepEqual(r.issues, ['late', 'early']); assert.equal(headlineIssue(r.issues), 'late');
  });
  it('someone still clocked in is open, not an early leave', () => {
    const r = classifyDay(base({ punches: [p('09:00', null)] }));
    assert.equal(r.status, 'OPEN'); assert.deepEqual(r.issues, ['open']); assert.equal(r.earlyLeaveMinutes, 0);
  });
  it('a punch on an unscheduled day is flagged, and a split shift is judged from the first start to the last end', () => {
    assert.deepEqual(classifyDay({ sched: null, punches: [p('10:00', '14:00')], nowMin: 2000, graceMin: 5 }).issues, ['unscheduled']);
    const split = { hours: 7, startMin: 8 * 60, endMin: 18 * 60 };
    assert.deepEqual(classifyDay({ sched: split, punches: [p('08:00', '12:00'), p('14:00', '18:00')], nowMin: 2000, graceMin: 5 }).issues, ['ok']);
  });
  it('an overnight shift runs past midnight: the punch out is the next morning', () => {
    const night = { hours: 8, startMin: 22 * 60, endMin: 30 * 60 };
    const r = classifyDay({ sched: night, punches: [{ inMin: 22 * 60 + 1, outMin: 30 * 60 + 2 }], nowMin: 40 * 60, graceMin: 5 });
    assert.deepEqual(r.issues, ['ok']); assert.equal(r.actualHours, 8);
  });
  it('adds up the hours worked', () => assert.equal(classifyDay(base({ punches: [p('09:00', '12:00'), p('13:00', '17:30')] })).actualHours, 7.5));
});

describe('counts and the missing-feed rule', () => {
  const d = (issues: any[], extra = {}) => ({ issues, punchCount: 0, scheduledHours: 8, due: true, ...extra });
  it('counts person-days by issue; a day with two issues counts under both', () => {
    const c = tally([d(['missed']), d(['late', 'early'], { punchCount: 1 }), d(['ok'], { punchCount: 1 }), d(['upcoming'], { due: false })]);
    assert.equal(c.total, 4); assert.equal(c.missed, 1); assert.equal(c.late, 1); assert.equal(c.early, 1); assert.equal(c.ok, 1); assert.equal(c.upcoming, 1); assert.equal(c.punches, 2); assert.equal(c.dueScheduled, 3);
  });
  it('treats nearly every due day being missed as a feed that has not been loaded, not as absence', () => {
    assert.equal(feedLooksMissing({ noPunch: 351, dueScheduled: 351 }), true);
    assert.equal(feedLooksMissing({ noPunch: 19, dueScheduled: 20 }), true);
    assert.equal(feedLooksMissing({ noPunch: 8, dueScheduled: 20 }), false);
    assert.equal(feedLooksMissing({ noPunch: 3, dueScheduled: 3 }), false, 'too few days to say');
  });
  it('orders people with the most problems first', () => assert.ok(problemScore({ missed: 1, late: 0, early: 0, open: 0 }) > problemScore({ missed: 0, late: 1, early: 0, open: 0 })));
  it('grace is whole minutes, at least one', () => { assert.equal(graceMinutes(300), 5); assert.equal(graceMinutes(10), 1); assert.equal(graceMinutes(undefined), 5); });
});

describe('excuses', () => {
  it('an excused problem comes off the day; a day with nothing else wrong is excused, not ok', () => {
    assert.deepEqual(applyExcuses(['missed'], ['missed']), ['excused']);
    assert.deepEqual(applyExcuses(['late', 'early'], ['late']), ['early', 'excused']);
    assert.deepEqual(applyExcuses(['late', 'early'], ['late', 'early']), ['excused']);
  });
  it('ignores an excuse for something the day does not have', () => {
    assert.deepEqual(applyExcuses(['late'], ['missed']), ['late']);
    assert.deepEqual(applyExcuses(['ok'], ['missed']), ['ok']);
    assert.deepEqual(applyExcuses(['upcoming'], ['missed']), ['upcoming']);
  });
  it('counts excused days under their own chip, and excusing does not hide a missing time-clock file', () => {
    const d = (issues: any[], punchCount = 0) => ({ issues, punchCount, scheduledHours: 8, due: true });
    const c = tally([...Array.from({ length: 10 }, () => d(['excused'])), d(['missed'])]);
    assert.equal(c.excused, 10); assert.equal(c.missed, 1); assert.equal(c.noPunch, 11);
    assert.equal(feedLooksMissing(c), true, 'still 11 of 11 finished days without a punch');
  });
});

describe('the daily note', () => {
  it('gives each person only the problems of the teams they look after, counted by kind', () => {
    const per = summarizeFor([{ teamId: 't1', kinds: ['missed'] }, { teamId: 't1', kinds: ['late', 'early'] }, { teamId: 't2', kinds: ['open'] }, { teamId: null, kinds: ['missed'] }], (t) => (t === 't1' ? ['sup1'] : ['mgr']));
    assert.deepEqual(per.get('sup1'), { missed: 1, late: 1, early: 1, open: 0 });
    assert.deepEqual(per.get('mgr'), { missed: 1, late: 0, early: 0, open: 1 });
    assert.equal(per.size, 2);
  });
  it('says it in words, leaving out what is zero', () => assert.equal(wordsFor({ missed: 2, late: 0, early: 1, open: 0 }), '2 missed, 1 left early'));
});

describe('clock helpers', () => {
  it('reads a punch time as minutes from the start of its day, across midnight', () => {
    assert.equal(minutesFromDay('2026-01-05 08:58:00+00', '2026-01-05'), 538);
    assert.equal(minutesFromDay('2026-01-06T02:30:00Z', '2026-01-05'), 1590);
  });
  it('gives now on the group clock relative to a day, negative before it', () => {
    const at = new Date('2026-03-10T12:30:00Z');
    assert.equal(nowMinutesFrom('2026-03-10', 'UTC', at), 12 * 60 + 30);
    assert.equal(nowMinutesFrom('2026-03-11', 'UTC', at), 12 * 60 + 30 - 1440);
    assert.equal(nowMinutesFrom('2026-03-10', 'Asia/Kolkata', at), 18 * 60);
  });
});

describe('the week view', () => {
  const day = (employeeId: string, name: string, dayStr: string, issues: any[], extra: any = {}) => ({ employeeId, employeeNumber: `E-${name}`, name, day: dayStr, scheduledHours: 8, actualHours: 0, issues, due: true, punches: [], ...extra });
  const days = [
    day('a', 'Asha', '2026-03-09', ['missed']), day('a', 'Asha', '2026-03-10', ['late'], { punches: [1] }),
    day('b', 'Bo', '2026-03-09', ['ok'], { punches: [1] }), day('c', 'Cy', '2026-03-09', ['missed']), day('c', 'Cy', '2026-03-10', ['missed']),
  ];
  const weeks = [{ employeeId: 'a', overtimeHours: 2 }, { employeeId: 'b', overtimeHours: 0 }];
  it('has one row per person, most problems first, with the days under each', () => {
    const v = weekView(days, weeks, { limit: 50, offset: 0 });
    assert.deepEqual(v.people.map((x) => x.name), ['Cy', 'Asha', 'Bo']);
    assert.equal(v.people[1].days.length, 2); assert.equal(v.people[1].overtimeHours, 2);
    assert.equal(v.total, 3);
  });
  it('works variance out over finished days only, so a shift later in the week is not hours short', () => {
    const v = weekView([day('a', 'Asha', '2026-03-09', ['ok'], { scheduledHours: 8, actualHours: 7.5 }), day('a', 'Asha', '2026-03-10', ['upcoming'], { scheduledHours: 8, due: false })], [], { limit: 10, offset: 0 });
    assert.equal(v.people[0].scheduledHours, 16); assert.equal(v.people[0].varianceHours, -0.5);
  });
  it('filters people by a kind of problem but counts the whole week', () => {
    const v = weekView(days, weeks, { issue: 'late', limit: 50, offset: 0 });
    assert.deepEqual(v.people.map((x) => x.name), ['Asha']);
    assert.equal(v.counts.missed, 3, 'the chips still show every kind');
  });
  it('searches by name or number, narrows the counts to those people, and pages', () => {
    assert.equal(weekView(days, weeks, { q: 'e-cy', limit: 50, offset: 0 }).counts.total, 2);
    const p1 = weekView(days, weeks, { limit: 2, offset: 0 }), p2 = weekView(days, weeks, { limit: 2, offset: 2 });
    assert.equal(p1.people.length, 2); assert.equal(p2.people.length, 1); assert.equal(p1.total, 3);
  });
});
