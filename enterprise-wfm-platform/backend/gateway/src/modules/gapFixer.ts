/**
 * Intraday gap fixer. Given how the rest of today is running (people on shift against people needed, per 15-minute slot), propose the
 * smallest set of changes that close the gaps, and the ones that trim large surpluses. Pure logic: the route loads people and rules,
 * this decides. Nothing here changes a schedule; every fix is a suggestion a supervisor approves, and each one that changes a person's
 * hours needs that person's agreement (`consent`).
 *
 * Fixes, in the order a supervisor would normally reach for them:
 *   EXTEND         a person on shift stays on past their end time
 *   START_EARLY    a person on shift starts earlier than planned
 *   CALL_IN        a person with no shift today is offered one (4 to 8 hours)
 *   RELEASE_EARLY  where there are far more people than needed, a person finishes early (voluntary)
 *   RELEASE_LATE   ... or starts later
 * Every fix keeps the person inside the same rules the scheduler uses: weekly hours cap, rest between shifts, availability, time off.
 */
export const SPD = 96;

export interface GapPerson {
  id: string; name: string;
  shift: { start: number; len: number } | null;   // today's shift, if any
  prevEnd: number;                                // slot (from today's midnight) at which yesterday's shift ended; -Infinity when none
  nextStart: number | null;                       // slot (from today's midnight, so 96+) at which tomorrow's shift starts
  weekPaidSlots: number;                          // paid slots planned in the pay week, today included
  maxWeekSlots: number;                           // the most they may work in a pay week (0 = no cap)
  contractWeekSlots: number;                      // hours they are contracted for; anything beyond is extra pay
  restSlots: number;                              // the shortest allowed gap between two shifts
  canWork: (start: number, len: number) => string | null;   // why not, or null (availability, time off, another group)
}

export type FixKind = 'EXTEND' | 'START_EARLY' | 'CALL_IN' | 'RELEASE_EARLY' | 'RELEASE_LATE';
export interface Fix {
  kind: FixKind; employeeId: string; name: string;
  newStart: number; newLength: number;            // the person's shift today once the fix is made
  coverFrom: number; coverTo: number;             // the slots this fix adds (or, for a release, removes)
  slotsClosed: number;                            // people-slots of shortage closed (or of surplus removed)
  slotsWasted: number;                            // people-slots added where nobody was needed
  extraPaidSlots: number;                         // paid slots added (negative for a release)
  pastContractSlots: number;                      // of those, how many go past the person's contract hours
  consent: true;                                  // always: the person has to agree
  why: string;
}
export interface GapWindow { from: number; to: number; peakShort: number; shortSlots: number }
export interface GapResult { fixes: Fix[]; before: { shortSlots: number; windows: GapWindow[] }; after: { shortSlots: number; windows: GapWindow[] } }

export interface GapOpts {
  nowSlot: number;
  leadSlots?: number;          // how far ahead of "now" a change may start: people need time to be told
  maxExtendSlots?: number;     // longest extension or earlier start (default 2 h)
  callInLengths?: number[];    // shift lengths offered to someone with no shift (default 4, 6, 8 h)
  surplusAtLeast?: number;     // only trim when this many more people than needed are on (default 2)
  maxFixes?: number;
}

const need0 = (n: number) => Math.round(n);
const shortOf = (sched: number[], need: number[], s: number) => Math.max(0, need0(need[s] ?? 0) - sched[s]);
const surplusOf = (sched: number[], need: number[], s: number) => Math.max(0, sched[s] - need0(need[s] ?? 0));

export function windowsOf(sched: number[], need: number[], from: number): { windows: GapWindow[]; shortSlots: number } {
  const windows: GapWindow[] = [];
  let shortSlots = 0;
  let cur = null as GapWindow | null;
  for (let s = from; s < SPD; s++) {
    const sh = shortOf(sched, need, s);
    shortSlots += sh;
    if (sh > 0) {
      if (cur) { cur.to = s + 1; cur.peakShort = Math.max(cur.peakShort, sh); cur.shortSlots += sh; }
      else cur = { from: s, to: s + 1, peakShort: sh, shortSlots: sh };
    } else if (cur) { windows.push(cur); cur = null; }
  }
  if (cur) windows.push(cur);
  return { windows, shortSlots };
}

interface Cand { fix: Fix; score: number; apply: (sched: number[]) => void }

export function suggestGapFixes(people: GapPerson[], sched0: number[], need: number[], o: GapOpts): GapResult {
  const lead = o.leadSlots ?? 2, maxExt = o.maxExtendSlots ?? 8, lengths = o.callInLengths ?? [16, 24, 32], minSurplus = o.surplusAtLeast ?? 2, cap = o.maxFixes ?? 40;
  const sched = sched0.slice();
  const earliest = o.nowSlot + lead;
  const first = windowsOf(sched, need, o.nowSlot);
  const used = new Set<string>();
  const fixes: Fix[] = [];

  const room = (p: GapPerson, add: number) => p.maxWeekSlots <= 0 || p.weekPaidSlots + add <= p.maxWeekSlots;
  const pastContract = (p: GapPerson, add: number) => (p.contractWeekSlots > 0 ? Math.max(0, Math.min(add, p.weekPaidSlots + add - p.contractWeekSlots)) : 0);
  const restOk = (p: GapPerson, start: number, end: number) => p.prevEnd + p.restSlots <= start && (p.nextStart === null || end + p.restSlots <= p.nextStart);

  const tally = (from: number, to: number) => {
    let closed = 0, wasted = 0;
    for (let s = from; s < to; s++) { if (s >= SPD) break; if (shortOf(sched, need, s) > 0) closed++; else wasted++; }
    return { closed, wasted };
  };
  const bump = (from: number, to: number, d: number) => (sched: number[]) => { for (let s = from; s < Math.min(to, SPD); s++) sched[s] += d; };

  const candidates = (): Cand[] => {
    const out: Cand[] = [];
    const add = (p: GapPerson, kind: FixKind, newStart: number, newLen: number, from: number, to: number, why: string, paid: number, closed: number, wasted: number, score: number, d: number) => {
      const pc = paid > 0 ? pastContract(p, paid) : 0;
      out.push({ score, apply: bump(from, to, d), fix: { kind, employeeId: p.id, name: p.name, newStart, newLength: newLen, coverFrom: from, coverTo: Math.min(to, SPD), slotsClosed: closed, slotsWasted: wasted, extraPaidSlots: paid, pastContractSlots: pc, consent: true, why } });
    };
    for (const p of people) {
      if (used.has(p.id)) continue;
      if (p.shift) {
        const { start, len } = p.shift, end = start + len;
        if (end <= o.nowSlot) continue;                                  // already gone home
        for (let k = 1; k <= maxExt; k++) {                              // stay on
          if (end + k > SPD) break;
          if (!room(p, k) || !restOk(p, start, end + k) || p.canWork(end, k)) continue;
          const t = tally(end, end + k);
          if (!t.closed) continue;
          add(p, 'EXTEND', start, len + k, end, end + k, `stays ${k * 15} min past the planned end`, k, t.closed, t.wasted, t.closed * 10 - t.wasted * 3 - pastContract(p, k) * 3, 1);
        }
        for (let k = 1; k <= maxExt; k++) {                              // come in early
          const ns = start - k;
          if (ns < earliest) break;
          if (!room(p, k) || !restOk(p, ns, end) || p.canWork(ns, k)) continue;
          const t = tally(ns, start);
          if (!t.closed) continue;
          add(p, 'START_EARLY', ns, len + k, ns, start, `starts ${k * 15} min earlier`, k, t.closed, t.wasted, t.closed * 10 - t.wasted * 3 - pastContract(p, k) * 3, 1);
        }
        // a big surplus at the edge of a shift: let the person finish early or start late, if they are still left with a proper shift
        for (let k = 1; k <= 16; k++) {
          const ne = end - k;
          if (ne - start < 16 || ne < earliest) break;
          let all = true;
          for (let s = ne; s < end; s++) if (surplusOf(sched, need, s) < minSurplus) { all = false; break; }
          if (!all) break;
          if (p.contractWeekSlots > 0 && p.weekPaidSlots - k < p.contractWeekSlots) break;     // would take them under contract
          add(p, 'RELEASE_EARLY', start, len - k, ne, end, `finishes ${k * 15} min early, when ${minSurplus}+ more people than needed are on`, -k, k, 0, k * 2 - 1, -1);
        }
        for (let k = 1; k <= 16; k++) {
          const ns = start + k;
          if (end - ns < 16 || start < earliest) break;
          let all = true;
          for (let s = start; s < ns; s++) if (surplusOf(sched, need, s) < minSurplus) { all = false; break; }
          if (!all) break;
          if (p.contractWeekSlots > 0 && p.weekPaidSlots - k < p.contractWeekSlots) break;
          add(p, 'RELEASE_LATE', ns, len - k, start, ns, `starts ${k * 15} min later, when ${minSurplus}+ more people than needed are on`, -k, k, 0, k * 2 - 1, -1);
        }
      } else {
        for (let s0 = earliest; s0 < SPD; s0++) {                        // offer a shift
          if (shortOf(sched, need, s0) <= 0) continue;
          for (const L of lengths) {
            if (s0 + L > SPD) continue;
            if (!room(p, L) || !restOk(p, s0, s0 + L) || p.canWork(s0, L)) continue;
            const t = tally(s0, s0 + L);
            if (t.closed < 4) continue;                                  // not worth ringing someone for less than an hour of help
            add(p, 'CALL_IN', s0, L, s0, s0 + L, `offered a ${L / 4} h shift`, L, t.closed, t.wasted, t.closed * 10 - t.wasted * 3 - L * 0.5 - pastContract(p, L) * 3, 1);
          }
        }
      }
    }
    return out;
  };

  while (fixes.length < cap) {
    const c = candidates();
    let best: Cand | null = null;
    for (const x of c) if (x.score > 0 && (!best || x.score > best.score)) best = x;
    if (!best) break;
    best.apply(sched);
    used.add(best.fix.employeeId);
    fixes.push(best.fix);
  }
  const last = windowsOf(sched, need, o.nowSlot);
  return { fixes, before: { shortSlots: first.shortSlots, windows: first.windows }, after: { shortSlots: last.shortSlots, windows: last.windows } };
}

/**
 * Re-checks one fix against a person's state right now, for the moment a supervisor approves it: the suggestion may be minutes old.
 * Returns why it can no longer be made, or null.
 */
export function fixProblem(p: GapPerson, kind: FixKind, newStart: number, newLength: number, o: { nowSlot: number; leadSlots?: number }): string | null {
  const lead = o.leadSlots ?? 2, sh = p.shift;
  const room = (add: number) => p.maxWeekSlots <= 0 || p.weekPaidSlots + add <= p.maxWeekSlots;
  const restOk = (start: number, end: number) => p.prevEnd + p.restSlots <= start && (p.nextStart === null || end + p.restSlots <= p.nextStart);
  if (newStart < 0 || newLength < 1 || newStart + newLength > SPD) return 'The new shift does not fit inside the day.';
  if (kind === 'CALL_IN') {
    if (sh) return 'They already have a shift today.';
    if (newStart < o.nowSlot + lead) return 'It is too late to start that shift.';
    if (newLength < 16 || newLength > 32) return 'An extra shift is 4 to 8 hours.';
    if (!room(newLength)) return 'It would take them over their weekly limit.';
    if (!restOk(newStart, newStart + newLength)) return 'It would break their rest between shifts.';
    return p.canWork(newStart, newLength);
  }
  if (!sh) return 'They no longer have a shift today.';
  const end = sh.start + sh.len, newEnd = newStart + newLength;
  if (kind === 'EXTEND') {
    if (newStart !== sh.start || newLength <= sh.len) return 'Their shift has changed.';
    const k = newLength - sh.len;
    if (end <= o.nowSlot) return 'They have already finished.';
    if (!room(k)) return 'It would take them over their weekly limit.';
    if (!restOk(sh.start, newEnd)) return 'It would break their rest before the next shift.';
    return p.canWork(end, k);
  }
  if (kind === 'START_EARLY') {
    if (newEnd !== end || newStart >= sh.start) return 'Their shift has changed.';
    const k = sh.start - newStart;
    if (newStart < o.nowSlot + lead) return 'It is too late to start earlier.';
    if (!room(k)) return 'It would take them over their weekly limit.';
    if (!restOk(newStart, end)) return 'It would break their rest after the last shift.';
    return p.canWork(newStart, k);
  }
  const k = sh.len - newLength;
  if (newLength < 16 || k <= 0) return 'Their shift would be under 4 hours.';
  if (kind === 'RELEASE_EARLY' && (newStart !== sh.start || newEnd < o.nowSlot + lead)) return 'It is too late to finish earlier.';
  if (kind === 'RELEASE_LATE' && (newEnd !== end || newStart < o.nowSlot + lead || sh.start < o.nowSlot + lead)) return 'It is too late to start later.';
  if (p.contractWeekSlots > 0 && p.weekPaidSlots - k < p.contractWeekSlots) return 'It would take them under their contract hours.';
  return null;
}
