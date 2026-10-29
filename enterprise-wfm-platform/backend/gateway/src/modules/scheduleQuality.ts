/**
 * What a finished schedule is worth, and why it falls short. Pure functions: they take what the scheduler already loaded and
 * return plain data, so they are tested without a database (test/scheduleQuality.test.ts).
 *
 *   evaluateSchedule   estimated service level per interval (Erlang C, at the forecast's own volume and at its P10/P90 bands),
 *                      and one 0-100 score with the parts it is made of
 *   analyseShortage    where the schedule is short of the requirement, and for each gap why nobody could cover it
 *   optimizeBreaks     moves meals and breaks inside their slack so the phones are covered best where the need is highest
 *   buildReport        what happened to every person in a generation run: scheduled, left out, and why
 */
import type { Ctx } from './scheduleRoutes.ts';
import { serviceLevel } from './erlang.ts';
import { shiftBlocked } from './compliance/rules.ts';
import { offeredLengths, paidSlots, rulesFor, startsFor, whyNotOffered } from './templateRules.ts';

const SPD = 96;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const hhmm = (slot: number) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;

export interface Activity { type: string; startSlot: number; slots: number }
export interface QShift { employeeId: string; day: string; startSlot: number; lengthSlots: number; templateId?: string | null; activities?: Activity[] | null }
export interface QRec { day: string; slot: number; volume: number; aht: number; p10: number; p90: number }

/** Functions that live in scheduleRoutes.ts, handed in so this file never imports it at runtime. */
export interface Helpers {
  blockedReason(ctx: Ctx, e: any, day: string, start: number, len: number): string | null;
  dowOf(day: string): number;
  mondayOf(day: string, weekStart?: number): string;
  addDays(day: string, n: number): string;
}

/** People on shift in every 15-minute slot of the period. */
export function headcount(days: string[], shifts: QShift[]): number[] {
  const out = new Array(days.length * SPD).fill(0), di = new Map(days.map((d, i) => [d, i]));
  for (const s of shifts) {
    const i = di.get(s.day); if (i === undefined) continue;
    for (let g = i * SPD + s.startSlot; g < Math.min(out.length, i * SPD + s.startSlot + s.lengthSlots); g++) out[g]++;
  }
  return out;
}

/** People off the phones (meal or break) in every slot. */
export function offPhones(days: string[], shifts: QShift[]): number[] {
  const out = new Array(days.length * SPD).fill(0), di = new Map(days.map((d, i) => [d, i]));
  for (const s of shifts) {
    const i = di.get(s.day); if (i === undefined) continue;
    for (const a of s.activities ?? []) {
      if (a.type !== 'MEAL' && a.type !== 'BREAK') continue;
      for (let g = i * SPD + a.startSlot; g < Math.min(out.length, i * SPD + a.startSlot + a.slots); g++) out[g]++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- evaluation and score

export interface EvalInput {
  days: string[]; shifts: QShift[]; required: number[]; records: QRec[];
  serviceLevel: number;       // target, 0..1
  answerSec: number; shrinkage: number;       // 0..1
  coverage: { percent: number; requiredSlots: number; overSlots: number };
  violations: number; overtimeHours: number; paidHours: number;
}

/**
 * Service level an interval would deliver with the people scheduled in it. The people on the phones are those on shift minus those at a meal or
 * break; shrinkage that is not breaks (absence, training) is then taken off as a share. Traffic is the interval's whole workload, so a
 * group that mixes channels is judged as one pool: an estimate, and it says so.
 */
export function evaluateSchedule(a: EvalInput) {
  const sched = headcount(a.days, a.shifts), off = offPhones(a.days, a.shifts);
  const onShiftSlots = sched.reduce((s, v) => s + v, 0), offSlots = off.reduce((s, v) => s + v, 0);
  const breakShare = onShiftSlots ? offSlots / onShiftSlots : 0;
  const otherShrink = Math.max(0, a.shrinkage - breakShare);      // what is still lost beyond the breaks the schedule shows
  const di = new Map(a.days.map((d, i) => [d, i]));
  const target = a.serviceLevel;
  type Row = { day: string; slot: number; time: string; volume: number; scheduled: number; onPhones: number; sl: number; slLow: number; slHigh: number; asa: number; occupancy: number; meets: boolean };
  const rows: Row[] = [];
  for (const r of a.records) {
    const i = di.get(r.day); if (i === undefined || r.volume <= 0) continue;
    const g = i * SPD + r.slot;
    const phones = Math.max(0, (sched[g] - off[g]) * (1 - otherShrink));
    const at = (vol: number) => serviceLevel(phones, (vol * r.aht) / 900, r.aht, a.answerSec);
    const mid = at(r.volume);
    const traffic = (r.volume * r.aht) / 900;
    rows.push({
      day: r.day, slot: r.slot, time: hhmm(r.slot), volume: r2(r.volume), scheduled: sched[g], onPhones: r1(phones), sl: r2(mid.sl),
      slLow: r2(at(r.p10).sl), slHigh: r2(at(r.p90).sl),     // a quiet and a busy version of the same interval
      asa: Number.isFinite(mid.asa) ? r1(mid.asa) : -1, occupancy: phones > 0 ? r2(Math.min(1, traffic / phones)) : 1, meets: mid.sl + 1e-9 >= target,
    });
  }
  const vol = rows.reduce((s, r) => s + r.volume, 0) || 1;
  const wsl = (pick: (r: Row) => number) => rows.reduce((s, r) => s + r.volume * pick(r), 0) / vol;
  const meetingVolume = rows.reduce((s, r) => s + (r.meets ? r.volume : 0), 0) / vol;
  const byDay = a.days.map((day) => {
    const rs = rows.filter((r) => r.day === day), v = rs.reduce((s, r) => s + r.volume, 0) || 1;
    return { day, volume: r1(rs.reduce((s, r) => s + r.volume, 0)), serviceLevel: r2(rs.reduce((s, r) => s + r.volume * r.sl, 0) / v), intervalsBelowTarget: rs.filter((r) => !r.meets).length };
  });
  const summary = {
    method: 'ERLANG_C_POOLED' as const, target, answerSec: a.answerSec,
    serviceLevel: r2(wsl((r) => r.sl)), serviceLevelBusyDay: r2(wsl((r) => r.slHigh)), serviceLevelQuietDay: r2(wsl((r) => r.slLow)),
    volumeMeetingTarget: r2(meetingVolume), intervals: rows.length, intervalsBelowTarget: rows.filter((r) => !r.meets).length,
    averageOccupancy: r2(wsl((r) => r.occupancy)), breakShare: r2(breakShare),
  };
  // The score: how much of the requirement is covered, how much of the volume is answered to target, whether the rules hold, how little is
  // wasted, and how little overtime it needs. Weights add up to 100.
  const overPct = a.coverage.requiredSlots ? a.coverage.overSlots / a.coverage.requiredSlots : 0;
  const parts = [
    { key: 'coverage', label: 'Requirement covered', max: 35, points: r1(35 * Math.min(1, a.coverage.percent / 100)), detail: `${r1(a.coverage.percent)}% of the required people-time` },
    { key: 'service', label: 'Service level reached', max: 30, points: r1(30 * meetingVolume), detail: `${Math.round(meetingVolume * 100)}% of contacts in intervals that meet the ${Math.round(target * 100)}% target` },
    { key: 'rules', label: 'Rules respected', max: 15, points: a.violations === 0 ? 15 : Math.max(0, 15 - a.violations), detail: a.violations === 0 ? 'no violations' : `${a.violations} violation${a.violations === 1 ? '' : 's'}` },
    { key: 'efficiency', label: 'Little wasted time', max: 10, points: r1(10 * (1 - Math.min(1, Math.max(0, overPct - 0.05) / 0.25))), detail: `${r1(overPct * 100)}% more people than needed` },
    { key: 'overtime', label: 'Little overtime', max: 10, points: r1(10 * (1 - Math.min(1, a.paidHours ? (a.overtimeHours / a.paidHours) * 10 : 0))), detail: `${r1(a.overtimeHours)}h above contract` },
  ];
  const score = Math.round(parts.reduce((s, p) => s + p.points, 0));
  return { summary, score, grade: score >= 90 ? 'EXCELLENT' : score >= 75 ? 'GOOD' : score >= 60 ? 'FAIR' : 'POOR', parts, byDay, worst: rows.filter((r) => !r.meets).sort((x, y) => x.sl - y.sl).slice(0, 40), intervals: rows };
}

// ---------------------------------------------------------------- shortage analysis

export type CauseKey = 'ON_SHIFT_ELSEWHERE' | 'TIME_OFF' | 'NOT_ALLOWED' | 'AVAILABILITY' | 'COMPLIANCE' | 'WEEKLY_HOURS' | 'DAYS_PER_WEEK' | 'REST' | 'DAYS_IN_A_ROW' | 'NO_TEMPLATE' | 'COULD_WORK';
const CAUSE_TEXT: Record<CauseKey, string> = {
  ON_SHIFT_ELSEWHERE: 'already working a shift that day that does not cover this time',
  TIME_OFF: 'on approved time off',
  NOT_ALLOWED: 'not allowed to work this kind of shift (weekend or overnight)',
  AVAILABILITY: 'not available at this time',
  COMPLIANCE: 'a labour-law rule blocks the shift',
  WEEKLY_HOURS: 'at their weekly hour limit',
  DAYS_PER_WEEK: 'at their days-per-week limit',
  REST: 'would not have enough rest between shifts',
  DAYS_IN_A_ROW: 'would work too many days in a row',
  NO_TEMPLATE: 'no shift template covers this time',
  COULD_WORK: 'could work it, but the schedule chose otherwise (other rules, consistent start times or surplus elsewhere)',
};

export interface Block { day: string; startSlot: number; endSlot: number; peakShort: number; shortSlots: number; requiredPeak: number; scheduledMin: number }

/** Runs of consecutive short slots on each day, worst first. */
export function shortBlocks(days: string[], required: number[], sched: number[]): Block[] {
  const out: Block[] = [];
  days.forEach((day, i) => {
    let cur: Block | null = null;
    for (let s = 0; s <= SPD; s++) {
      const g = i * SPD + s, short = s < SPD ? required[g] - sched[g] : 0;
      if (short > 0) {
        if (!cur) cur = { day, startSlot: s, endSlot: s + 1, peakShort: short, shortSlots: short, requiredPeak: required[g], scheduledMin: sched[g] };
        else { cur.endSlot = s + 1; cur.peakShort = Math.max(cur.peakShort, short); cur.shortSlots += short; cur.requiredPeak = Math.max(cur.requiredPeak, required[g]); cur.scheduledMin = Math.min(cur.scheduledMin, sched[g]); }
      } else if (cur) { out.push(cur); cur = null; }
    }
  });
  return out.sort((a, b) => b.shortSlots - a.shortSlots);
}

/**
 * Why is this person not covering a given slot? Built once per schedule, then asked about any person, day and slot: the shortage analysis asks
 * it for the busiest slot of each short block, and the interval view asks it for any slot the planner clicks.
 */
export function buildWhyNot(ctx: Ctx, shifts: QShift[], helpers: Helpers) {
  const byPerson = new Map<string, QShift[]>();
  for (const s of shifts) byPerson.set(s.employeeId, [...(byPerson.get(s.employeeId) ?? []), s]);
  const tpl = ctx.templates.filter((t) => t.status === 'ACTIVE');
  const pool = ctx.employees.filter((e) => e.status === 'ACTIVE');

  /** Why this person is not covering `slot` on `day`. */
  const whyNot = (e: any, day: string, slot: number): CauseKey => {
    const mine = byPerson.get(e.id) ?? [];
    const sameDay = mine.find((s) => s.day === day);
    if (sameDay && sameDay.startSlot <= slot && slot < sameDay.startSlot + sameDay.lengthSlots) return 'COULD_WORK'; // counted already
    if (ctx.timeOff.some((o) => o.employeeId === e.id && o.startDay <= day && o.endDay >= day)) return 'TIME_OFF';
    // every way a template could cover this slot
    const starts: { t: any; s: number; len: number }[] = [];
    // skills are not part of the shortage picture, so a template that needs one is treated as open to this person
    const who = { groupIds: [e.primaryGroupId, ...(e.eligibleGroupIds ?? [])].filter(Boolean) as string[], employmentType: e.employmentType as string };
    for (const t of tpl) {
      if (whyNotOffered(t, { ...who, skillIds: t.skillIds ?? [] }, day)) continue;
      for (const len of offeredLengths(t)) for (const s of startsFor(t, helpers.dowOf(day))) if (s <= slot && slot < s + len) starts.push({ t, s, len });
    }
    if (!starts.length) return 'NO_TEMPLATE';
    const reasons: CauseKey[] = [];
    for (const { t, s, len } of starts) {
      const why = helpers.blockedReason(ctx, e, day, s, len);
      if (why) { reasons.push(why.includes('weekend') || why.includes('overnight') ? 'NOT_ALLOWED' : why.includes('time off') ? 'TIME_OFF' : why.includes('already scheduled') ? 'ON_SHIFT_ELSEWHERE' : 'AVAILABILITY'); continue; }
      if (shiftBlocked(ctx.rules.forTeam(e.teamId, e.id), { nightConsent: !!e.nightShiftConsent }, { startSlot: s, lengthSlots: len, mealSlots: rulesFor(t, len).mealSlots })) { reasons.push('COMPLIANCE'); continue; }
      if (sameDay) { reasons.push('ON_SHIFT_ELSEWHERE'); continue; }
      const wk = helpers.mondayOf(day, ctx.weekStart), inWeek = mine.filter((x) => helpers.mondayOf(x.day, ctx.weekStart) === wk);
      const paid = paidSlots(t, len) / 4;
      if (inWeek.reduce((sum, x) => sum + x.lengthSlots / 4, 0) + paid > e.maxWeeklyHours + 1e-9) { reasons.push('WEEKLY_HOURS'); continue; }
      if (inWeek.length >= e.workDaysPerWeek) { reasons.push('DAYS_PER_WEEK'); continue; }
      const prev = mine.find((x) => x.day === helpers.addDays(day, -1)), next = mine.find((x) => x.day === helpers.addDays(day, 1));
      if ((prev && SPD + s - (prev.startSlot + prev.lengthSlots) < e.minRestHours * 4) || (next && SPD + next.startSlot - (s + len) < e.minRestHours * 4)) { reasons.push('REST'); continue; }
      let run = 1, d = day;
      while (mine.some((x) => x.day === helpers.addDays(d, -1))) { d = helpers.addDays(d, -1); run++; }
      d = day;
      while (mine.some((x) => x.day === helpers.addDays(d, 1))) { d = helpers.addDays(d, 1); run++; }
      if (run > e.maxConsecutiveDays) { reasons.push('DAYS_IN_A_ROW'); continue; }
      return 'COULD_WORK';
    }
    // when several shapes are blocked for different reasons, report the one that blocks the most of them
    const tally = new Map<CauseKey, number>();
    for (const r of reasons) tally.set(r, (tally.get(r) ?? 0) + 1);
    return [...tally.entries()].sort((x, y) => y[1] - x[1])[0][0];
  };
  return { whyNot, pool, byPerson };
}

/** Who is working a slot, and for everyone who is not, why not (people who could work it come first: they are the ones who can be moved in). */
export function explainInterval(a: { ctx: Ctx; days: string[]; shifts: QShift[]; required: number[]; helpers: Helpers; day: string; slot: number; nameOf: (id: string) => string }) {
  const { ctx, days, shifts, day, slot } = a;
  const { whyNot, pool } = buildWhyNot(ctx, shifts, a.helpers);
  const i = days.indexOf(day);
  const working = shifts.filter((s) => s.day === day && s.startSlot <= slot && slot < s.startSlot + s.lengthSlots)
    .map((s) => ({ employeeId: s.employeeId, name: a.nameOf(s.employeeId), startSlot: s.startSlot, endSlot: s.startSlot + s.lengthSlots }))
    .sort((x, y) => x.startSlot - y.startSlot || x.name.localeCompare(y.name));
  const on = new Set(working.map((w) => w.employeeId));
  const groups = new Map<CauseKey, string[]>();
  for (const e of pool) {
    if (on.has(e.id)) continue;
    const c = whyNot(e, day, slot);
    groups.set(c, [...(groups.get(c) ?? []), a.nameOf(e.id)]);
  }
  const notWorking = [...groups.entries()].map(([key, names]) => ({ key, text: CAUSE_TEXT[key], people: names.length, names: names.sort().slice(0, 12) }))
    .sort((x, y) => (x.key === 'COULD_WORK' ? -1 : y.key === 'COULD_WORK' ? 1 : y.people - x.people));
  const need = i >= 0 ? a.required[i * SPD + slot] ?? 0 : 0;
  return { day, slot, needed: need, scheduled: working.length, working, notWorking };
}

export function analyseShortage(a: { ctx: Ctx; days: string[]; shifts: QShift[]; required: number[]; helpers: Helpers; limit?: number; targetCoverage: number; coveragePercent: number }) {
  const { ctx, days, shifts, required, helpers } = a;
  const sched = headcount(days, shifts);
  const blocks = shortBlocks(days, required, sched);
  const { whyNot, pool } = buildWhyNot(ctx, shifts, helpers);
  const shortTotal = blocks.reduce((s, b) => s + b.shortSlots, 0);

  const overall = new Map<CauseKey, number>();
  const detailed = blocks.slice(0, a.limit ?? 40).map((b) => {
    // the slot with the biggest gap stands for the block
    let at = b.startSlot, worst = 0; const i = days.indexOf(b.day);
    for (let s = b.startSlot; s < b.endSlot; s++) { const sh = required[i * SPD + s] - sched[i * SPD + s]; if (sh > worst) { worst = sh; at = s; } }
    const counts = new Map<CauseKey, number>();
    for (const e of pool) { const c = whyNot(e, b.day, at); counts.set(c, (counts.get(c) ?? 0) + 1); }
    const causes = [...counts.entries()].filter(([k]) => k !== 'COULD_WORK' || true).sort((x, y) => y[1] - x[1])
      .map(([key, people]) => ({ key, people, text: CAUSE_TEXT[key] }));
    for (const c of causes) overall.set(c.key, (overall.get(c.key) ?? 0) + c.people * b.shortSlots);
    const couldWork = counts.get('COULD_WORK') ?? 0;
    const actions: { type: string; label: string; detail: string }[] = [];
    if (couldWork > 0) actions.push({ type: 'ASSIGN', label: 'Add shifts by hand', detail: `${couldWork} people could cover this and are not scheduled for it. Open the day on the timeline and assign them.` });
    actions.push({ type: 'OVERTIME', label: 'Offer overtime', detail: `Offer ${b.peakShort} extra ${b.peakShort === 1 ? 'person' : 'people'} for ${hhmm(b.startSlot)}-${hhmm(b.endSlot)} on ${b.day}.` });
    if ((counts.get('NOT_ALLOWED') ?? 0) + (counts.get('NO_TEMPLATE') ?? 0) > 0) actions.push({ type: 'RELAX', label: 'Relax a rule', detail: (counts.get('NO_TEMPLATE') ?? 0) > pool.length / 2 ? 'Add a shift template that covers this time.' : 'Allow overnight or weekend work for more people.' });
    if (b.peakShort >= 3) actions.push({ type: 'TEMP', label: 'Add temporary staff', detail: `This gap needs about ${b.peakShort} more ${b.peakShort === 1 ? 'person' : 'people'} at its worst.` });
    return { day: b.day, from: hhmm(b.startSlot), to: hhmm(b.endSlot), peakShort: b.peakShort, shortPeopleHours: r1(b.shortSlots / 4), requiredPeak: b.requiredPeak, scheduledMin: b.scheduledMin, causes, actions };
  });
  const topCauses = [...overall.entries()].sort((x, y) => y[1] - x[1]).map(([key, weight]) => ({ key, weight, text: CAUSE_TEXT[key] }));
  const meets = a.coveragePercent >= a.targetCoverage;
  return {
    targetCoverage: a.targetCoverage, coveragePercent: a.coveragePercent, meetsTarget: meets,
    intervalsShort: blocks.reduce((s, b) => s + (b.endSlot - b.startSlot), 0), gaps: blocks.length, shortPeopleHours: r1(shortTotal / 4),
    headline: meets ? 'The schedule meets the coverage target.' : `The schedule covers ${a.coveragePercent}% against a target of ${a.targetCoverage}%.`,
    topCauses: topCauses.slice(0, 6), blocks: detailed,
  };
}

// ---------------------------------------------------------------- breaks and meals inside their slack

/**
 * Moves each meal and break within its slack (the larger of the template's flex and `slackSlots`) to where the phones need it most. The phones in a slot are the
 * people on shift minus those off for a meal or break; the aim is that they never fall below what the forecast needs on the phones. Order inside a shift
 * and the length of each activity stay as they were, so templates, pay and the shift itself are untouched. Anything that is not a meal or break stays put.
 */
export function optimizeBreaks(a: { days: string[]; shifts: QShift[]; required: number[]; shrinkage: number; slackSlots: number; flexOf: (s: QShift) => number }) {
  const di = new Map(a.days.map((d, i) => [d, i]));
  const total = a.days.length * SPD;
  const sched = headcount(a.days, a.shifts);
  const need = a.required.map((r) => Math.ceil(r * (1 - a.shrinkage) - 1e-9));     // people needed on the phones
  const off = offPhones(a.days, a.shifts);
  const shortfall = () => { let s = 0; for (let g = 0; g < total; g++) s += Math.max(0, need[g] - (sched[g] - off[g])); return s; };
  const before = shortfall();
  const cost = (g0: number, n: number, add: number) => {
    let c = 0;
    for (let g = g0; g < g0 + n; g++) c += Math.max(0, need[g] - (sched[g] - off[g] - add)) * 100 + off[g] * 2 + 1;
    return c;
  };
  const moved: { shift: QShift; activities: Activity[] }[] = [];
  const out = new Map<QShift, Activity[]>();
  for (const s of a.shifts) out.set(s, (s.activities ?? []).map((x) => ({ ...x })));
  for (let pass = 0; pass < 3; pass++) {
    let changed = 0;
    for (const s of a.shifts) {
      const i = di.get(s.day); if (i === undefined) continue;
      const acts = out.get(s)!;
      const lo = i * SPD + s.startSlot, hi = lo + s.lengthSlots;
      const slack = Math.max(a.flexOf(s), a.slackSlots);
      acts.sort((x, y) => x.startSlot - y.startSlot);
      for (let k = 0; k < acts.length; k++) {
        const act = acts[k];
        if (act.type !== 'MEAL' && act.type !== 'BREAK') continue;
        const abs = i * SPD + act.startSlot;
        for (let g = abs; g < abs + act.slots; g++) off[g]--;       // take it out, then find its best place
        const prevEnd = k > 0 ? i * SPD + acts[k - 1].startSlot + acts[k - 1].slots : lo + 1;
        const nextStart = k < acts.length - 1 ? i * SPD + acts[k + 1].startSlot : hi - 1;
        let best = abs, bestCost = Infinity;
        for (let o = -slack; o <= slack; o++) {
          const g0 = abs + o;
          if (g0 < prevEnd || g0 + act.slots > nextStart || g0 <= lo || g0 + act.slots >= hi || g0 + act.slots > total) continue;
          const c = cost(g0, act.slots, 1) + Math.abs(o) * 0.01;
          if (c < bestCost - 1e-9) { bestCost = c; best = g0; }
        }
        for (let g = best; g < best + act.slots; g++) off[g]++;
        if (best !== abs) { act.startSlot = best - i * SPD; changed++; }
      }
    }
    if (!changed) break;
  }
  for (const s of a.shifts) {
    const was = JSON.stringify(s.activities ?? []), now = out.get(s)!;
    if (JSON.stringify(now) !== was) moved.push({ shift: s, activities: now });
  }
  return { moved, shiftsChanged: moved.length, phoneShortfallBefore: before, phoneShortfallAfter: shortfall() };
}

// ---------------------------------------------------------------- generation report

export type RunStatus = 'SUCCEEDED' | 'SUCCEEDED_WITH_WARNINGS';
export interface ReportException { level: 'WARNING' | 'INFO'; code: string; subject: string; message: string; people?: { id: string; name: string }[] }

export function buildReport(a: {
  pool: any[]; requested: { employeeIds?: string[]; teamIds?: string[] } | null; poolSize: number; shifts: QShift[]; optionsByPerson: Map<string, number>;
  blockedByPerson: Map<string, Map<string, number>>; uncoveredDays: string[]; projectedDays: string[]; coveragePercent: number; targetCoverage: number;
  violations: number; solverStatus: string; allEmployees: any[]; groupId: string; templatesUsed: number; consistencyNote?: string | null; skillNote?: string | null; historyNote?: string | null; repeatNote?: string | null; thinNote?: string | null; contractNote?: { level: 'WARNING' | 'INFO'; message: string } | null; crewNote?: { level: 'WARNING' | 'INFO'; message: string } | null;
}) {
  const scheduled = new Map<string, number>();
  for (const s of a.shifts) scheduled.set(s.employeeId, (scheduled.get(s.employeeId) ?? 0) + 1);
  const exceptions: ReportException[] = [];
  const nameOf = (e: any) => `${e.firstName} ${e.lastName}`;
  const unscheduled = a.pool.filter((e) => !scheduled.has(e.id));
  const noOptions = unscheduled.filter((e) => (a.optionsByPerson.get(e.id) ?? 0) === 0);
  const notNeeded = unscheduled.filter((e) => (a.optionsByPerson.get(e.id) ?? 0) > 0);
  const top = (m?: Map<string, number>) => m ? [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, 2).map(([k]) => k).join(' and ') : '';
  if (noOptions.length) {
    // group people by the main thing that ruled out every shift
    const by = new Map<string, any[]>();
    for (const e of noOptions) { const k = top(a.blockedByPerson.get(e.id)) || 'no shift template fits their working days'; by.set(k, [...(by.get(k) ?? []), e]); }
    for (const [why, list] of by) exceptions.push({ level: 'WARNING', code: 'NO_POSSIBLE_SHIFT', subject: `${list.length} ${list.length === 1 ? 'person' : 'people'} could not be given any shift`, message: `Every shift was ruled out: ${why}.`, people: list.slice(0, 50).map((e) => ({ id: e.id, name: nameOf(e) })) });
  }
  if (notNeeded.length) exceptions.push({ level: 'INFO', code: 'NOT_NEEDED', subject: `${notNeeded.length} ${notNeeded.length === 1 ? 'person was' : 'people were'} not scheduled`, message: 'They could have worked, but the requirement was already covered by others or their own rules (for example a fixed start time) kept them out.', people: notNeeded.slice(0, 50).map((e) => ({ id: e.id, name: nameOf(e) })) });
  // people asked for but not in the pool
  const asked = new Set<string>(a.requested?.employeeIds ?? []);
  const poolIds = new Set(a.pool.map((e) => e.id));
  const missing = a.allEmployees.filter((e) => asked.has(e.id) && !poolIds.has(e.id));
  if (missing.length) exceptions.push({ level: 'WARNING', code: 'NOT_ELIGIBLE', subject: `${missing.length} chosen ${missing.length === 1 ? 'person is' : 'people are'} not eligible for this group`, message: 'They are inactive, or not in the group, or lack a skill the group requires.', people: missing.slice(0, 50).map((e) => ({ id: e.id, name: nameOf(e) })) });
  if (a.uncoveredDays.length) exceptions.push({ level: 'WARNING', code: 'NO_FORECAST', subject: `${a.uncoveredDays.length} day${a.uncoveredDays.length === 1 ? '' : 's'} have no staffing target`, message: `No forecast reaches ${a.uncoveredDays.slice(0, 5).join(', ')}${a.uncoveredDays.length > 5 ? ' and more' : ''}.` });
  if (a.projectedDays.length) exceptions.push({ level: 'INFO', code: 'PROJECTED', subject: `${a.projectedDays.length} day${a.projectedDays.length === 1 ? '' : 's'} use the long-term forecast`, message: 'These days are projected from long-term totals and are less certain.' });
  if (a.coveragePercent < a.targetCoverage) exceptions.push({ level: 'WARNING', code: 'BELOW_TARGET', subject: `Coverage ${a.coveragePercent}% is below the ${a.targetCoverage}% target`, message: 'See the shortage analysis for where and why.' });
  if (a.violations) exceptions.push({ level: 'WARNING', code: 'VIOLATIONS', subject: `${a.violations} rule violation${a.violations === 1 ? '' : 's'}`, message: 'Fix them on the timeline before publishing.' });
  if (a.solverStatus === 'FEASIBLE') exceptions.push({ level: 'INFO', code: 'NOT_PROVEN_BEST', subject: 'A good schedule, not proven best', message: 'The solver ran out of time. More solver time may improve it.' });
  if (a.consistencyNote) exceptions.push({ level: 'INFO', code: 'CONSISTENCY', subject: 'Same start and end times', message: a.consistencyNote });
  if (a.historyNote) exceptions.push({ level: 'INFO', code: 'HISTORY', subject: 'Carried over from the previous schedule', message: a.historyNote });
  if (a.thinNote) exceptions.push({ level: 'INFO', code: 'THINNED', subject: 'Some shift choices were left out', message: a.thinNote });
  if (a.repeatNote) exceptions.push({ level: 'INFO', code: 'REPEAT', subject: 'The week is assumed to repeat', message: a.repeatNote });
  if (a.crewNote) exceptions.push({ level: a.crewNote.level, code: 'CREW_SIZE', subject: 'More paid hours than the forecast needs', message: a.crewNote.message });
  if (a.contractNote) exceptions.push({ level: a.contractNote.level, code: 'CONTRACT_FIT', subject: 'Contract hours cannot be met exactly', message: a.contractNote.message });
  if (a.skillNote) exceptions.push({ level: 'INFO', code: 'SKILLS', subject: 'Coverage judged per skill', message: a.skillNote });
  const warnings = exceptions.filter((e) => e.level === 'WARNING').length;
  const reasonFor = (e: any) => (a.optionsByPerson.get(e.id) ?? 0) === 0
    ? `No shift possible: ${top(a.blockedByPerson.get(e.id)) || 'no shift template fits their working days'}`
    : 'Not needed: the requirement was covered by others, or their own rules kept them out';
  return {
    status: (warnings ? 'SUCCEEDED_WITH_WARNINGS' : 'SUCCEEDED') as RunStatus,
    people: { inPool: a.poolSize, scheduled: scheduled.size, notScheduled: unscheduled.length, noPossibleShift: noOptions.length },
    exceptions,
    // everyone who got no shift, with the reason, for the downloadable report
    unscheduled: unscheduled.slice(0, 2000).map((e) => ({ id: e.id as string, employeeNumber: (e.employeeNumber ?? '') as string, name: nameOf(e), reason: reasonFor(e) })),
  };
}

/**
 * Whether the people chosen can plausibly be kept busy by this forecast. Contracts that add up to far more than the hours the forecast needs
 * on shift mean surplus however well the solver works: the fix is fewer people, fewer contract hours or shorter shifts, not a better schedule.
 * `requiredSlots` is the requirement summed over every 15-minute slot (it already includes shrinkage); `contractHours` the people's weekly contracts times the weeks.
 */
export function crewSizeNote(a: { people: number; contractHours: number; requiredSlots: number }): { level: 'WARNING' | 'INFO'; message: string } | null {
  const needed = a.requiredSlots / 4;
  if (needed <= 0 || a.contractHours <= 0) return null;
  const ratio = a.contractHours / needed;
  if (ratio < 1.25) return null;
  const surplus = Math.round((1 - needed / a.contractHours) * 100);
  const wholeNeeded = Math.ceil(needed / (a.contractHours / a.people));
  return {
    level: ratio >= 1.5 ? 'WARNING' : 'INFO',
    message: `The ${a.people} people chosen have ${Math.round(a.contractHours).toLocaleString('en-US')} contract hours between them; the forecast needs about ${Math.round(needed).toLocaleString('en-US')} hours on shift. Giving everyone their contract leaves about ${surplus}% of the paid time with no demand behind it. About ${wholeNeeded} people would cover this forecast. Schedule fewer people, lower "Meet contract hours", or offer shorter shifts.`,
  };
}

// ---------------------------------------------------------------- stale schedules

/** Reasons a schedule no longer matches the forecast it was built from. Empty when it is still current. */
export function staleReasons(a: { settings: any; forecastId: string | null; forecastRevNow: number | null; forecastStatusNow: string | null; newerPublishedForecast: { id: string; name: string } | null }): string[] {
  const out: string[] = [];
  const built = a.settings?.forecastRev as number | undefined;
  if (a.forecastId && a.forecastRevNow != null && built != null && a.forecastRevNow !== built) out.push('The forecast it was built from has been edited since.');
  if (a.forecastId && a.forecastStatusNow && a.forecastStatusNow !== 'PUBLISHED') out.push(`The forecast it was built from is now ${a.forecastStatusNow.toLowerCase()}.`);
  if (a.newerPublishedForecast) out.push(`A newer forecast (${a.newerPublishedForecast.name}) has been published.`);
  return out;
}
