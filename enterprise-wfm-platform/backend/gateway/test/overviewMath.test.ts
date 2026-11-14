/**
 * The arithmetic and the judgement behind the Today page, checked against figures worked out by hand. No database or engine needed:
 *   npx tsx --test --test-force-exit test/overviewMath.test.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttention, dayCoverage, groupAdherencePercent, orderFor, toneFor, trendOf, verdictOf, weightedMean, type Signals } from '../src/modules/overviewMath.ts';

const near = (a: number | null, b: number, eps = 1e-9) => assert.ok(a !== null && Math.abs(a - b) < eps, `${a} is not ${b}`);

describe('weighted figures', () => {
  it('weigh a busy interval more than a quiet one', () => {
    // 90% service level on 100 contacts and 50% on 10 contacts: (90 + 5) / 110, not the plain average of 70
    near(weightedMean([{ value: 0.9, weight: 100 }, { value: 0.5, weight: 10 }]), 95 / 110);
    assert.equal(weightedMean([]), null);
    assert.equal(weightedMean([{ value: 1, weight: 0 }]), null, 'nothing to weigh is not a figure');
  });
  it('coverage is people-time met over people-time needed, with short and surplus counted apart', () => {
    // needed 4,4,4,4 and scheduled 2,6,4,0 (quarter hours): met 2+4+4+0 = 10 of 16 = 62.5%; short 2+0+0+4 = 6 slots = 1.5 h; surplus 2 slots = 0.5 h
    const c = dayCoverage([4, 4, 4, 4], [2, 6, 4, 0]);
    assert.deepEqual(c, { coveragePercent: 62.5, requiredHours: 4, scheduledHours: 3, shortHours: 1.5, surplusHours: 0.5 });
    assert.equal(dayCoverage([0, 0], [3, 3]).coveragePercent, null, 'no requirement: coverage is not 100% or 0%, it is not defined');
    assert.equal(dayCoverage([2, 2], [9, 9]).coveragePercent, 100, 'a surplus never pushes coverage past 100%');
  });
  it('group adherence is minutes over minutes, not an average of percentages', () => {
    // an 8 h shift with 7 h 36 min adherent (95%) and a 4 h shift with 2 h adherent (50%): 576 / 720 = 80%, where the plain average of the two says 72.5%
    assert.equal(groupAdherencePercent([{ scheduledMin: 480, adherentMin: 456 }, { scheduledMin: 240, adherentMin: 120 }]), 80);
    assert.equal(groupAdherencePercent([{ scheduledMin: 0, adherentMin: 0 }]), null);
    assert.equal(groupAdherencePercent([{ scheduledMin: 100, adherentMin: 130 }]), 100, 'more than the schedule is still 100%');
  });
});

describe('trend and tone', () => {
  it('says which way a figure moved and whether that is good', () => {
    assert.deepEqual(trendOf(92, 88, { higherIsBetter: true }), { direction: 'UP', delta: 4, better: true });
    assert.deepEqual(trendOf(6, 9, { higherIsBetter: false }), { direction: 'DOWN', delta: -3, better: true });
    assert.deepEqual(trendOf(80.2, 80, { higherIsBetter: true }), { direction: 'FLAT', delta: 0.2, better: null }, 'a move inside the band is noise');
    assert.equal(trendOf(null, 80, { higherIsBetter: true }), null, 'no earlier figure, no trend');
  });
  it('colours a figure against its target', () => {
    assert.equal(toneFor(95, 95, true), 'good');
    assert.equal(toneFor(90, 95, true, 10), 'warn');
    assert.equal(toneFor(60.9, 95, true, 10), 'bad');
    assert.equal(toneFor(null, 95, true), undefined);
    assert.equal(toneFor(12, 10, false, 5), 'warn');
  });
});

const healthy = (): Signals => ({
  today: '2026-11-12',
  schedule: { checked: true, published: { id: 's1', name: 'Week 46', periodStart: '2026-11-09', periodEnd: '2026-11-15', coveragePercent: 97, violations: 0, stale: [] }, coversToday: true, draftsWithViolations: [] },
  forecast: { checked: true, publishedShort: { name: 'Nov', fromDay: '2026-11-01', toDay: '2026-11-30' }, coversToday: true, daysLeft: 18, waiting: [], approvedNotPublished: [] },
  live: { checked: true, understaffedIntervals: 0, worst: null },
  rta: { checked: true, hasEvents: true, scheduledNow: true, outOfAdherence: 0, unknownAgents: 0, unmappedStates: [] },
  feed: { checked: true, lastHistoryDay: '2026-11-11', lagDays: 1 },
  targets: { coveragePercent: 95 },
});
const everything = () => true;

describe('the attention rail and the verdict', () => {
  it('says all clear only when everything was checked and nothing is wrong', () => {
    const s = healthy(), items = buildAttention(s, everything);
    assert.equal(items.length, 0);
    assert.equal(verdictOf(s, items).status, 'OK');
  });

  it('does not say all clear when something could not be checked', () => {
    const s = healthy();
    s.live = { checked: false, understaffedIntervals: 0, worst: null };       // no published forecast covers today: live coverage cannot be judged
    const v = verdictOf(s, buildAttention(s, everything));
    assert.equal(v.status, 'PARTIAL');
    assert.ok(v.notChecked.includes("today's live coverage") && /could not be/.test(v.text));
  });

  it('is not fooled by a role not being shown something: that is not "unchecked"', () => {
    const s = healthy();
    s.rta = { ...s.rta, checked: false };
    assert.equal(verdictOf(s, [], ['rta']).status, 'OK');
    assert.equal(verdictOf(s, []).status, 'PARTIAL');
  });

  it('catches every problem in the review: out of date, violations, low coverage, no forecast for today, agents the system cannot read', () => {
    const s = healthy();
    s.schedule.published = { id: 's1', name: 'Week 45', periodStart: '2026-11-02', periodEnd: '2026-11-08', coveragePercent: 60.9, violations: 9, stale: ['The forecast it was built from has been replaced'] };
    s.schedule.coversToday = false;
    s.forecast = { ...s.forecast, coversToday: false, daysLeft: null, publishedShort: { name: 'Oct', fromDay: '2026-10-01', toDay: '2026-10-31' } };
    s.live = { checked: false, understaffedIntervals: 0, worst: null };
    s.rta = { checked: true, hasEvents: false, scheduledNow: true, outOfAdherence: 0, unknownAgents: 98, unmappedStates: [{ state: 'Aux 7', agents: 98 }] };
    const items = buildAttention(s, everything), ids = items.map((i) => i.id);
    for (const id of ['schedule-ended', 'schedule-violations', 'schedule-stale', 'schedule-coverage', 'forecast-gap', 'rta-silent', 'rta-unmapped']) assert.ok(ids.includes(id), `${id} is missing: ${ids}`);
    const v = verdictOf(s, items);
    assert.equal(v.status, 'ATTENTION');
    assert.match(items.find((i) => i.id === 'schedule-violations')!.title, /breaks 9 rules/);
    assert.match(items.find((i) => i.id === 'schedule-coverage')!.title, /60\.9%/);
    assert.equal(items.find((i) => i.id === 'rta-unmapped')!.title, '98 agents in a state the system cannot read');
  });

  it('warns about a forecast about to run out, and a feed that has stopped', () => {
    const s = healthy();
    s.forecast.daysLeft = 1;
    s.feed = { checked: true, lastHistoryDay: '2026-11-08', lagDays: 4 };
    const ids = buildAttention(s, everything).map((i) => i.id);
    assert.ok(ids.includes('forecast-ending') && ids.includes('feed-stale'));
    s.feed.lagDays = 2;
    assert.ok(!buildAttention(s, everything).some((i) => i.id === 'feed-stale'), 'two days behind is within a weekend of normal');
  });

  it('gives each item the action that fixes it, and says when the person cannot take it', () => {
    const s = healthy();
    s.schedule.published!.stale = ['It was edited after it was published'];
    const stale = buildAttention(s, everything).find((i) => i.id === 'schedule-stale')!;
    assert.deepEqual([stale.action!.module, stale.action!.section, stale.action!.allowed], ['scheduling', 'generate-schedule', true]);
    const viewer = buildAttention(s, (p) => p.endsWith(':read')).find((i) => i.id === 'schedule-stale')!;
    assert.equal(viewer.action!.allowed, false, 'an analyst sees the problem but is not offered a button that would be refused');
  });

  it('puts what the person acts on first, after severity', () => {
    const s = healthy();
    s.forecast.waiting = [{ name: 'Dec', by: 'Priya' }];
    s.schedule.draftsWithViolations = [{ name: 'Draft 3', violations: 2 }];
    s.live = { checked: true, understaffedIntervals: 3, worst: { time: '14:30', gap: -4 } };
    const items = buildAttention(s, everything);
    const first = (role: string) => orderFor(items, role).map((i) => i.id);
    assert.equal(first('SCHEDULER')[0], 'live-short', 'urgent comes first whoever you are');
    assert.ok(first('FORECAST_PLANNER').indexOf('forecast-waiting-Dec') < first('FORECAST_PLANNER').indexOf('draft-Draft 3'));
    assert.ok(first('SCHEDULER').indexOf('draft-Draft 3') < first('SCHEDULER').indexOf('forecast-waiting-Dec'));
  });

  it('does not report a draft with violations as urgent, or a healthy schedule as a problem', () => {
    const s = healthy();
    s.schedule.draftsWithViolations = [{ name: 'D', violations: 1 }];
    const items = buildAttention(s, everything);
    assert.equal(items.length, 1);
    assert.equal(items[0].severity, 'todo');
    assert.equal(verdictOf(s, items).status, 'OK', 'a to-do is not an alarm');
  });
});
