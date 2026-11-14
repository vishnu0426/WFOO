import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildUp, gapOf, planNote, shrinkageNote, storySentence } from '../../../src/services/capacityStory.ts';

describe('over, short or about right', () => {
  it('says over by the number of FTE', () => { const g = gapOf(233, 355); assert.equal(g.state, 'OVER'); assert.equal(g.label, 'Over by 122 FTE'); assert.equal(g.pct, 52.4); });
  it('says short, and about right within five percent', () => {
    assert.equal(gapOf(100, 80).label, 'Short by 20 FTE');
    assert.equal(gapOf(100, 103).state, 'BALANCED'); assert.equal(gapOf(100, 96).state, 'BALANCED'); assert.equal(gapOf(10, 10.8).state, 'BALANCED');
    assert.equal(gapOf(100, 107).state, 'OVER');
  });
});

describe('from workload to people needed', () => {
  // 4 weeks, 40 h per person: workload 4000 h = 25 people; the service-level buffer is x1.2; shrinkage 20%
  const periods = [{ days: 28, workloadHours: 4000, agentHours: (4000 * 1.2) / 0.8, fte: 37.5, peakFte: 45 }];
  const b = buildUp(periods, { fteHoursWeek: 40, factor: 1.2, headcountFte: 50 })!;
  it('builds the need up in three steps that add to the total', () => {
    assert.equal(Math.round(b.workload * 10) / 10, 25); assert.equal(Math.round(b.erlang * 10) / 10, 5); assert.equal(Math.round(b.shrinkage * 10) / 10, 7.5); assert.equal(Math.round(b.need * 10) / 10, 37.5);
    assert.ok(Math.abs(b.workload + b.erlang + b.shrinkage - b.need) < 1e-9);
  });
  it('lays the steps out as a waterfall: floating bars, then totals, then the gap between them', () => {
    assert.deepEqual(b.steps.map((s) => s.id), ['workload', 'erlang', 'shrinkage', 'need', 'have', 'gap']);
    const [w, e, s, need, have, gap] = b.steps;
    assert.equal(e.base, w.value); assert.ok(Math.abs(s.base - (w.value + e.value)) < 1e-9); assert.equal(need.base, 0); assert.equal(have.value, 50);
    assert.equal(gap.label, 'Surplus'); assert.equal(gap.tone, 'over'); assert.equal(gap.base, need.value); assert.ok(Math.abs(gap.value - 12.5) < 1e-9); assert.equal(gap.text, '+12.5');
  });
  it('shows a shortfall below the need, in red', () => {
    const s = buildUp(periods, { fteHoursWeek: 40, factor: 1.2, headcountFte: 30 })!;
    assert.equal(s.gap.state, 'SHORT'); const gap = s.steps[5]; assert.equal(gap.label, 'Shortfall'); assert.equal(gap.tone, 'short'); assert.equal(gap.base, 30); assert.equal(gap.text, '−7.5');
  });
  it('weights the months by their days, and has nothing to show without data', () => {
    const two = buildUp([{ days: 30, workloadHours: 0, agentHours: 3000, fte: 0, peakFte: 0 }, { days: 10, workloadHours: 0, agentHours: 1000, fte: 0, peakFte: 0 }], { fteHoursWeek: 40, factor: 1, headcountFte: 0 })!;
    assert.ok(Math.abs(two.need - 4000 / (40 * (40 / 7))) < 1e-9);
    assert.equal(buildUp([], { fteHoursWeek: 40, factor: 1, headcountFte: 1 }), null);
  });
});

describe('the sentence on the page', () => {
  const over = gapOf(233, 333);
  it('says over, how much, and that the schedule leaves intervals uncovered', () => {
    const t = storySentence({ gap: over, need: 233, haveFte: 333, people: 355, coveragePct: 60.9 });
    assert.match(t, /You have 333 FTE \(355 people\) against an average need of 233\./); assert.match(t, /100 FTE more than needed \(\+43%\)/); assert.match(t, /covers only 60\.9% of intervals/); assert.match(t, /not at the right times/);
  });
  it('leaves the coverage part out when the schedule is fine or there is none', () => {
    assert.doesNotMatch(storySentence({ gap: over, need: 233, haveFte: 333, people: 355, coveragePct: 97 }), /covers/);
    assert.doesNotMatch(storySentence({ gap: over, need: 233, haveFte: 333, people: 355, coveragePct: null }), /covers/);
  });
  it('says short and about right, and when nobody is assigned', () => {
    assert.match(storySentence({ gap: gapOf(100, 80), need: 100, haveFte: 80, people: 85, coveragePct: null }), /20 FTE fewer than needed \(−20%\)/);
    assert.match(storySentence({ gap: gapOf(100, 101), need: 100, haveFte: 101, people: 101, coveragePct: null }), /about right/);
    assert.match(storySentence({ gap: gapOf(100, 0), need: 100, haveFte: 0, people: 0, coveragePct: null }), /No active people are assigned/);
  });
});

describe('where the shrinkage comes from', () => {
  it('names the categories and says the flat figure is not used', () => {
    assert.equal(shrinkageNote({ source: 'CATEGORIES', effectivePct: 10, flatPct: 20, categories: [{ name: 'Breaks', pct: 5 }, { name: 'Training', pct: 3 }, { name: 'Absence', pct: 2 }] }),
      "10% from the group's shrinkage categories (breaks 5% + training 3% + absence 2%). The flat 20% setting is not used while categories exist.");
  });
  it('or the flat setting', () => assert.equal(shrinkageNote({ source: 'FLAT', effectivePct: 20, flatPct: 20, categories: [] }), "20% from the group's shrinkage setting."));
});

describe('the headcount plan in a line', () => {
  it('says a surplus out loud', () => {
    const n = planNote([{ needed: 233, start: 355, end: 349, hires: 0, attritionLoss: 6 }, { needed: 235, start: 349, end: 343, hires: 0, attritionLoss: 6 }])!;
    assert.equal(n.tone, 'over'); assert.match(n.text, /No hiring is needed\. You start 122 above the need and, after attrition, are still 108 above it at the end\./);
  });
  it('says how many to hire and from when', () => {
    const n = planNote([{ needed: 50, start: 48, end: 50, hires: 2, attritionLoss: 0 }, { needed: 55, start: 50, end: 55, hires: 5, attritionLoss: 0 }])!;
    assert.equal(n.tone, 'short'); assert.match(n.text, /Hire 7 people over 2 months, starting in the first month/);
  });
  it('has nothing to say with no months', () => assert.equal(planNote([]), null));
});
