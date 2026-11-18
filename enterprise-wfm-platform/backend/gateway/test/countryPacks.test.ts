/** The starter labour-law packs by country: well-formed, consistent, and honest about what they leave out. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_INS, CATALOG, limitsFrom, normaliseRule, shiftBlocked } from '../src/modules/compliance/rules.ts';
import { COUNTRY_PACKS } from '../src/modules/compliance/countryPacks.ts';

describe('country packs', () => {
  it('each has its own code, a name, a region, the law it comes from, a description and a note on what it leaves out', () => {
    const codes = new Set<string>();
    for (const p of COUNTRY_PACKS) {
      assert.ok(/^[A-Z]{2}_[A-Z0-9_]+$/.test(p.code), `${p.code}: country code, then a name`);
      assert.ok(!codes.has(p.code), `${p.code} is used twice`); codes.add(p.code);
      for (const k of ['name', 'law', 'description', 'notes'] as const) assert.ok(p[k].trim().length >= 10, `${p.code}: ${k} is missing`);
      assert.ok(p.region.trim().length >= 2, `${p.code}: region is missing`);
      assert.ok(p.rules.length >= 1, `${p.code} has no rules`);
    }
    assert.ok(COUNTRY_PACKS.length >= 30);
  });

  it('are in the built-in list with the three core packs, and are marked as starters', () => {
    assert.ok(BUILT_INS.length >= COUNTRY_PACKS.length + 3);
    assert.equal(new Set(BUILT_INS.map((b) => b.code)).size, BUILT_INS.length, 'no code appears twice across the core and country packs');
    for (const c of ['IN_OSH_2020', 'EU_WTD', 'US_PREDICTIVE']) assert.ok(BUILT_INS.some((b) => b.code === c));
    for (const p of COUNTRY_PACKS) assert.equal(BUILT_INS.find((b) => b.code === p.code)?.starter, true, p.code);
    assert.ok(!BUILT_INS.find((b) => b.code === 'IN_OSH_2020')?.starter);
  });

  it('every rule is of a known type, with the parameters inside the catalogue\'s limits (none silently clamped)', () => {
    const types = new Set(CATALOG.map((c) => c.type));
    for (const p of COUNTRY_PACKS) p.rules.forEach((r, i) => {
      assert.ok(types.has(r.type), `${p.code}: unknown rule ${r.type}`);
      const n = normaliseRule({ type: r.type, params: r.params, severity: r.severity }, i);
      assert.deepEqual(n.params, r.params, `${p.code}: ${r.type} has a value outside the allowed range or a missing one`);
      assert.equal(n.severity, r.severity);
    });
  });

  it('a warning threshold never sits above the blocking limit for the same thing, and the spread is not shorter than a day', () => {
    for (const p of COUNTRY_PACKS) {
      for (const type of ['MAX_DAILY_HOURS', 'MAX_WEEKLY_HOURS'] as const) {
        const warn = p.rules.filter((r) => r.type === type && r.severity === 'WARN').map((r) => Number(r.params.hours));
        const block = p.rules.filter((r) => r.type === type && r.severity === 'BLOCK').map((r) => Number(r.params.hours));
        if (warn.length && block.length) assert.ok(Math.max(...warn) <= Math.min(...block), `${p.code}: ${type} warns above where it blocks`);
      }
      const day = p.rules.filter((r) => r.type === 'MAX_DAILY_HOURS').map((r) => Number(r.params.hours));
      const sp = p.rules.filter((r) => r.type === 'MAX_SPREAD_HOURS').map((r) => Number(r.params.hours));
      if (day.length && sp.length) assert.ok(Math.min(...sp) >= Math.min(...day), `${p.code}: spread-over shorter than the working day`);
    }
  });

  it('overtime multiples and thresholds are sensible', () => {
    for (const p of COUNTRY_PACKS) for (const r of p.rules.filter((x) => x.type === 'OVERTIME_PREMIUM')) {
      assert.ok(Number(r.params.multiplier) >= 1.2 && Number(r.params.multiplier) <= 3, `${p.code}: premium`);
      assert.equal(r.severity, 'WARN', `${p.code}: overtime pay is reported, never blocks`);
    }
  });

  it('the generator can use each pack: its limits read out and a normal shift is not forbidden', () => {
    for (const p of BUILT_INS) {
      const lim = limitsFrom(p.rules);
      for (const v of Object.values(lim)) assert.ok(Number.isFinite(v) || v === undefined);
      // an ordinary day: 09:00 to 17:30 with an hour for a meal, 7.5 paid hours
      assert.equal(shiftBlocked(p.rules, { nightConsent: true }, { startSlot: 36, lengthSlots: 34, mealSlots: 4 }), null, `${p.code} forbids an ordinary day shift`);
    }
  });

  it('Namibia carries the figures it was written with', () => {
    const na = COUNTRY_PACKS.find((c) => c.code === 'NA_LABOUR_2007')!;
    const get = (type: string, sev?: string) => na.rules.filter((r) => r.type === type && (!sev || r.severity === sev));
    assert.equal(get('MAX_WEEKLY_HOURS', 'WARN')[0].params.hours, 45);
    assert.equal(get('MAX_DAILY_HOURS', 'WARN')[0].params.hours, 9);
    assert.deepEqual(get('MEAL_BREAK')[0].params, { afterHours: 5, minutes: 60 });
    assert.equal(get('OVERTIME_PREMIUM')[0].params.multiplier, 1.5);
    assert.match(na.notes, /36-hour weekly rest/, 'it says what it does not cover');
  });

  it('a pack says what it leaves out, or why there is nothing more to model', () => {
    for (const p of COUNTRY_PACKS) assert.ok(/not covered|no legal maximum|sets no rest|has no rules|federal law has no/i.test(p.notes), `${p.code}: notes should say what is left out`);
  });
});
