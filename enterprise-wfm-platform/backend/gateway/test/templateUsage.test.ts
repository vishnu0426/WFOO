import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, templateUsage } from '../src/modules/scheduleQuality.ts';

// the case from a real report: everyone on the Morning template while 00:00 to 06:00 was short, with a Night and a Mid Night template on offer
const q = (h: number) => h * 4;
const morning = { id: 'm', name: 'Morning', starts: [q(6), q(6) + 2, q(7), q(8)], lengthSlots: 38 };
const night = { id: 'n', name: 'Night', starts: [q(22), q(22) + 2, q(23)], lengthSlots: 38 };
const mid = { id: 'x', name: 'Mid Night', starts: [0, 2, 4, 8, 12], lengthSlots: 38 };
const shortNight = new Array(96).fill(0); for (let s = 0; s < q(6); s++) shortNight[s] = 17;     // 17 people short from 00:00 to 06:00, summed over days below
const placed = [...Array(5)].map((_, i) => ({ templateId: 'm', employeeId: `e${i}` }));

describe('shift templates used', () => {
  it('counts shifts and people for the template that was used', () => {
    const r = templateUsage({ templates: [morning], shifts: placed, offered: new Map([['m', 900]]), blocked: new Map(), shortByTimeOfDay: new Array(96).fill(0), rosterOnly: false });
    assert.deepEqual([r[0].status, r[0].shifts, r[0].people, r[0].offered, r[0].reason], ['USED', 5, 5, 900, null]);
  });
  it('flags a template that was never chosen although the hours it covers are short, and says why', () => {
    const r = templateUsage({ templates: [morning, night, mid], shifts: placed, offered: new Map([['m', 900], ['n', 400], ['x', 500]]), blocked: new Map(), shortByTimeOfDay: shortNight, rosterOnly: false });
    const by = Object.fromEntries(r.map((x) => [x.name, x]));
    assert.equal(by['Mid Night'].status, 'UNUSED_SHORT');
    assert.equal(by['Night'].status, 'UNUSED_SHORT');
    assert.match(by['Mid Night'].reason!, /possible choice 500 times and not chosen, although [\d.]+ hours short/);
    assert.equal(by['Morning'].status, 'USED');
  });
  it('says the optimiser never tried it when it kept the starting roster', () => {
    const r = templateUsage({ templates: [night], shifts: [], offered: new Map([['n', 400]]), blocked: new Map(), shortByTimeOfDay: shortNight, rosterOnly: true });
    assert.match(r[0].reason!, /kept the starting roster, so it was never tried/);
  });
  it('names what ruled the template out when nobody could be given it', () => {
    const r = templateUsage({ templates: [night], shifts: [], offered: new Map(), blocked: new Map([['n', new Map([['a labour-law rule', 40], ['shift templates that do not run on their days', 5], ['their availability', 1]])]]), shortByTimeOfDay: shortNight, rosterOnly: false });
    assert.match(r[0].reason!, /^Nobody could be given it: a labour-law rule and shift templates that do not run on their days\./);
  });
  it('calls a template not needed when its hours were already staffed', () => {
    const r = templateUsage({ templates: [night], shifts: [], offered: new Map([['n', 400]]), blocked: new Map(), shortByTimeOfDay: new Array(96).fill(0), rosterOnly: false });
    assert.deepEqual([r[0].status, r[0].reason], ['UNUSED', 'Not needed: the hours it covers were already staffed.']);
  });
  it('covers hours past midnight: a night shift reaches the early hours of the next day', () => {
    const r = templateUsage({ templates: [night], shifts: [], offered: new Map([['n', 1]]), blocked: new Map(), shortByTimeOfDay: shortNight, rosterOnly: false });
    assert.ok(r[0].shortHours > 0, 'the 00:00 to 06:00 shortage falls in the hours a 22:00 start covers');
  });
});

describe('the generation report', () => {
  const base = { requested: null, poolSize: 3, pool: [], shifts: [], optionsByPerson: new Map(), blockedByPerson: new Map(), uncoveredDays: [], projectedDays: [], coveragePercent: 95, targetCoverage: 90, violations: 0, solverStatus: 'OPTIMAL', allEmployees: [], groupId: 'g', templatesUsed: 3 };
  it('warns about idle templates with short hours and carries the table', () => {
    const use = templateUsage({ templates: [morning, night], shifts: placed, offered: new Map([['m', 9], ['n', 9]]), blocked: new Map(), shortByTimeOfDay: shortNight, rosterOnly: false });
    const r = buildReport({ ...base, templateUse: use });
    const w = r.exceptions.find((e) => e.code === 'TEMPLATES_UNUSED');
    assert.ok(w); assert.equal(w!.level, 'WARNING'); assert.match(w!.message, /Night \(/);
    assert.equal(r.status, 'SUCCEEDED_WITH_WARNINGS');
    assert.equal(r.templates.length, 2);
  });
  it('stays quiet when every idle template is simply not needed', () => {
    const use = templateUsage({ templates: [morning, night], shifts: placed, offered: new Map([['m', 9], ['n', 9]]), blocked: new Map(), shortByTimeOfDay: new Array(96).fill(0), rosterOnly: false });
    assert.equal(buildReport({ ...base, templateUse: use }).exceptions.some((e) => e.code === 'TEMPLATES_UNUSED'), false);
  });
});
