/** Fixed-crew presets (Pitman, 4 on 4 off, DuPont): every day is covered, and the analysis says so. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analysePattern, crewCoverage, type TemplateLite } from '../src/modules/rotationPlan.ts';

const D = 'day', N = 'night';
/** The shapes of the ready-made patterns in src/components/scheduling/rotationPresets.ts (kept here so the gateway build does not reach into the screens). */
const o = null, P = [D, D, o, o, D, D, D, o, o, D, D, o, o, o], Pn = P.map((x) => (x ? N : o));
const PRESETS: Record<string, { shape: (string | null)[]; crews: number[] }> = {
  '223': { shape: P.map((x) => (x ? 'A' : o)), crews: [0, 7] },
  '223-dn': { shape: [...P, ...Pn].map((x) => x), crews: [0, 7, 14, 21] },
  '4on4off': { shape: ['A', 'A', 'A', 'A', o, o, o, o], crews: [0, 4] },
  '4on4off-dn': { shape: [D, D, D, D, o, o, o, o, N, N, N, N, o, o, o, o], crews: [0, 4, 8, 12] },
};
const dayPresetPlan = (id: string) => { const p = PRESETS[id]; return { cycleDays: p.shape.length, sequence: p.shape.map((l) => (l === 'A' ? D : l)), crews: p.crews.map((offsetDays, i) => ({ name: `Crew ${String.fromCharCode(65 + i)}`, offsetDays })) }; };
const templates = new Map<string, TemplateLite>([
  [D, { id: D, name: 'Day 12h', startSlot: 24, lengthSlots: 48, paidSlots: 48, active: true }],      // 06:00 to 18:00
  [N, { id: N, name: 'Night 12h', startSlot: 72, lengthSlots: 48, paidSlots: 48, active: true }],    // 18:00 to 06:00
]);
const plan = dayPresetPlan;
const analyse = (id: string, limits = {}, contractHours: number | null = null) => {
  const p = plan(id);
  return analysePattern({ cycleDays: p.cycleDays, sequence: p.sequence, crews: p.crews, anchorDow: 0, templates, limits, contractHours });
};

describe('Pitman 2-2-3', () => {
  it('two crews on one shift cover it exactly once every day', () => {
    const p = plan('223'); const [c] = crewCoverage(p.sequence, p.crews);
    assert.deepEqual([c.min, c.max, c.gapDays], [1, 1, 0]);
  });
  it('four crews on days then nights cover day and night exactly once every day', () => {
    const p = plan('223-dn');
    assert.equal(p.cycleDays, 28);
    const cov = crewCoverage(p.sequence, p.crews);
    assert.equal(cov.length, 2);
    for (const c of cov) assert.deepEqual([c.min, c.max, c.gapDays], [1, 1, 0]);
  });
  it('is 84 hours in two weeks, runs of at most three, a full weekend off every other weekend', () => {
    const a = analyse('223', { maxConsecutiveDays: 3, minRestHours: 11 }, 42);
    assert.equal(a.crews[0].paidHoursPerCycle, 84); assert.equal(a.crews[0].averageWeeklyHours, 42); assert.equal(a.crews[0].longestRun, 3);
    assert.ok(!a.findings.some((f) => f.level === 'WARN'), JSON.stringify(a.findings));
  });
  it('changing from days to nights breaks no rest limit, and the analysis says nights are covered every day', () => {
    const a = analyse('223-dn', { minRestHours: 11 }, 42);
    assert.ok(!a.findings.some((f) => f.level === 'WARN'), JSON.stringify(a.findings));
    assert.ok(a.findings.some((f) => f.level === 'OK' && /Night 12h is covered every day/.test(f.text)), JSON.stringify(a.findings));
  });
});

describe('4 on, 4 off', () => {
  it('two crews on one shift, and four crews on days and nights, cover every day once', () => {
    const one = plan('4on4off'); assert.equal(crewCoverage(one.sequence, one.crews)[0].gapDays, 0);
    const two = plan('4on4off-dn');
    for (const c of crewCoverage(two.sequence, two.crews)) assert.deepEqual([c.min, c.max], [1, 1]);
  });
  it('averages 42 hours a week on 12 hour shifts', () => assert.equal(analyse('4on4off').crews[0].averageWeeklyHours, 42));
});

describe('coverage', () => {
  it('reports a day nobody covers', () => {
    const seq = [D, D, null, null];
    assert.deepEqual(crewCoverage(seq, [{ offsetDays: 0 }]), [{ templateId: D, min: 0, max: 1, gapDays: 2 }]);
    const a = analysePattern({ cycleDays: 4, sequence: seq, crews: [{ name: 'A', offsetDays: 0 }, { name: 'B', offsetDays: 1 }], anchorDow: 0, templates, limits: {} });
    assert.ok(a.findings.some((f) => /no crew works Day 12h/.test(f.text)), JSON.stringify(a.findings));
  });
});
