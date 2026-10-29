import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { suggestGapFixes, windowsOf, SPD, type GapPerson } from '../src/modules/gapFixer.ts';

const flat = (v: number) => new Array(SPD).fill(v);
const person = (id: string, o: Partial<GapPerson> = {}): GapPerson => ({
  id, name: id, shift: null, prevEnd: -Infinity, nextStart: null, weekPaidSlots: 0, maxWeekSlots: 48 * 4, contractWeekSlots: 40 * 4, restSlots: 44, canWork: () => null, ...o,
});
const schedFrom = (people: GapPerson[]) => { const s = flat(0); for (const p of people) if (p.shift) for (let g = p.shift.start; g < Math.min(SPD, p.shift.start + p.shift.len); g++) s[g]++; return s; };

describe('gap fixer', () => {
  it('finds nothing to do when the day is covered', () => {
    const ps = [person('a', { shift: { start: 32, len: 32 } })];
    const r = suggestGapFixes(ps, schedFrom(ps), flat(0).map((_, i) => (i >= 32 && i < 64 ? 1 : 0)), { nowSlot: 36 });
    assert.equal(r.fixes.length, 0);
    assert.equal(r.before.shortSlots, 0);
  });

  it('asks the person finishing at the start of the gap to stay on', () => {
    const a = person('a', { shift: { start: 32, len: 32 }, weekPaidSlots: 100 });       // 08:00-16:00
    const need = flat(0).map((_, i) => (i >= 32 && i < 72 ? 1 : 0));                    // needed until 18:00
    const r = suggestGapFixes([a], schedFrom([a]), need, { nowSlot: 40 });
    assert.equal(r.fixes[0].kind, 'EXTEND');
    assert.equal(r.fixes[0].newLength, 40);
    assert.equal(r.after.shortSlots, 0);
  });

  it('never goes past the weekly cap or the rest gap, and never uses a person who cannot work then', () => {
    const capped = person('capped', { shift: { start: 32, len: 32 }, weekPaidSlots: 48 * 4 });          // already at the cap
    const tired = person('tired', { shift: { start: 32, len: 32 }, nextStart: 96 + 8, weekPaidSlots: 100 });  // next shift at 02:00 tomorrow, rest 11 h
    const blocked = person('blocked', { shift: { start: 32, len: 32 }, weekPaidSlots: 100, canWork: () => 'is unavailable' });
    const need = flat(0).map((_, i) => (i >= 32 && i < 72 ? 3 : 0));
    const r = suggestGapFixes([capped, tired, blocked], schedFrom([capped, tired, blocked]), need, { nowSlot: 40 });
    assert.equal(r.fixes.filter((f) => ['capped', 'tired', 'blocked'].includes(f.employeeId) && f.kind === 'EXTEND').length, 0);
  });

  it('offers a shift to someone with none today, only when it helps enough and rest allows', () => {
    const on = person('on', { shift: { start: 32, len: 32 } });
    const off = person('off', { prevEnd: 20 });                                          // yesterday finished 05:00: plenty of rest by 14:00
    const closeRest = person('closeRest', { prevEnd: 50 });                              // yesterday finished 12:30: 11 h rest not met
    const need = flat(0).map((_, i) => (i >= 32 && i < 100 ? 2 : 0)).map((n, i) => (i >= 64 ? 2 : n));
    const r = suggestGapFixes([on, off, closeRest], schedFrom([on, off, closeRest]), need, { nowSlot: 40 });
    const callIn = r.fixes.filter((f) => f.kind === 'CALL_IN');
    assert.ok(callIn.length >= 1);
    assert.ok(callIn.every((f) => f.employeeId === 'off'));
    assert.ok(callIn.every((f) => f.newStart >= 42));
  });

  it('uses each person once and reports what is left', () => {
    const a = person('a', { shift: { start: 32, len: 32 }, weekPaidSlots: 100 });
    const need = flat(0).map((_, i) => (i >= 32 && i < 90 ? 2 : 0));
    const r = suggestGapFixes([a], schedFrom([a]), need, { nowSlot: 40 });
    assert.equal(new Set(r.fixes.map((f) => f.employeeId)).size, r.fixes.length);
    assert.ok(r.after.shortSlots < r.before.shortSlots);
    assert.ok(r.after.shortSlots > 0);
  });

  it('marks time past contract hours', () => {
    const pt = person('pt', { shift: { start: 32, len: 16 }, weekPaidSlots: 80, contractWeekSlots: 80, maxWeekSlots: 120 });   // part-timer at contract already
    const need = flat(0).map((_, i) => (i >= 32 && i < 56 ? 1 : 0));
    const r = suggestGapFixes([pt], schedFrom([pt]), need, { nowSlot: 36 });
    const f = r.fixes[0];
    assert.equal(f.kind, 'EXTEND');
    assert.equal(f.pastContractSlots, f.extraPaidSlots);
  });

  it('lets people finish early only when well over, and never below contract or a 4 h shift', () => {
    const crew = Array.from({ length: 6 }, (_, i) => person(`p${i}`, { shift: { start: 32, len: 40 }, weekPaidSlots: 200, contractWeekSlots: 160 }));
    const need = flat(0).map((_, i) => (i >= 32 && i < 72 ? (i >= 60 ? 1 : 4) : 0));
    const r = suggestGapFixes(crew, schedFrom(crew), need, { nowSlot: 36 });
    const rel = r.fixes.filter((f) => f.kind === 'RELEASE_EARLY');
    assert.ok(rel.length >= 1);
    assert.ok(rel.every((f) => f.newLength >= 16 && f.extraPaidSlots < 0));
    const tight = crew.map((p) => ({ ...p, weekPaidSlots: 160 }));                       // exactly at contract: nobody may go under it
    assert.equal(suggestGapFixes(tight, schedFrom(tight), need, { nowSlot: 36 }).fixes.filter((f) => f.kind.startsWith('RELEASE')).length, 0);
  });

  it('groups short slots into windows', () => {
    const w = windowsOf(flat(1), flat(0).map((_, i) => (i === 10 || i === 11 || i === 20 ? 3 : 0)), 0);
    assert.deepEqual(w.windows.map((x) => [x.from, x.to, x.peakShort]), [[10, 12, 2], [20, 21, 2]]);
    assert.equal(w.shortSlots, 6);
  });
});
