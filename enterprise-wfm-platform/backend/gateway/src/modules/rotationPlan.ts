/**
 * The arithmetic behind rotation patterns, kept apart from the routes so it can be tested on its own.
 *
 *  - compileWeekly: a weekly rotation (a list of weekly templates, each repeated for some weeks) is stored as the day cycle it unrolls to,
 *    so generating shifts needs no second code path.
 *  - analysePattern: what a pattern means for the people on it, before anyone is put on it: hours a week, the longest run of work days, the
 *    shortest rest between shifts (including where the cycle wraps), how weekends fall, and which of the company's limits it breaks.
 */
const SPD = 96;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface WeeklyStep { name: string; weeks: number; days: (string | null)[] }

/** The day cycle a weekly rotation unrolls to: each step's seven days, repeated for its number of weeks, one step after the other. Day 0 is the first day of a pay week. */
export function compileWeekly(steps: WeeklyStep[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (const s of steps) for (let w = 0; w < s.weeks; w++) out.push(...s.days);
  return out;
}

export interface TemplateLite { id: string; name: string; startSlot: number; lengthSlots: number; paidSlots: number; active: boolean }
export interface Limits { minRestHours?: number | null; maxWeeklyHours?: number | null; maxConsecutiveDays?: number | null; maxDaysPerWeek?: number | null }
export interface AnalysisInput {
  cycleDays: number; sequence: (string | null)[]; crews: { name: string; offsetDays: number }[];
  anchorDow: number;                     // weekday of day 0, Monday = 0
  templates: Map<string, TemplateLite>; limits: Limits; contractHours?: number | null;
}
export interface Finding { level: 'WARN' | 'INFO' | 'OK'; text: string }
export interface CrewSummary {
  name: string; offsetDays: number; shiftsPerCycle: number; paidHoursPerCycle: number; averageWeeklyHours: number; maxHoursInAnyWeek: number; maxDaysInAnyWeek: number;
  longestRun: number; neverOff: boolean; shortestRestHours: number | null; weekendDaysPerWeek: number; weekendsFullyOff: number;
}

export function analysePattern(a: AnalysisInput): { crews: CrewSummary[]; findings: Finding[]; cycleDays: number } {
  const n = a.cycleDays, findings: Finding[] = [];
  const missing = new Set<string>();
  const tplAt = (id: string | null) => (id ? a.templates.get(id) ?? null : null);
  for (const id of a.sequence) if (id && (!a.templates.get(id) || !a.templates.get(id)!.active)) missing.add(id);
  if (missing.size) findings.push({ level: 'WARN', text: `${missing.size} shift template${missing.size === 1 ? ' is' : 's are'} inactive or missing, so those days would have no shift.` });

  const lcm = (n * 7) / gcd(n, 7);                       // the cycle and the week line up again after this many days
  const crews: CrewSummary[] = a.crews.map((c) => {
    const day = (d: number) => tplAt(a.sequence[mod(d + c.offsetDays, n)]);      // what this crew works on calendar day d after the anchor
    const worked = (d: number) => !!day(d);
    const slots = (d: number) => { const t = day(d); return t ? t.paidSlots : 0; };
    let shifts = 0, paid = 0;
    for (let d = 0; d < n; d++) if (worked(d)) { shifts++; paid += slots(d); }
    // any seven days in a row, around the cycle
    let maxH = 0, maxD = 0;
    for (let s = 0; s < n; s++) { let h = 0, dd = 0; for (let k = 0; k < 7; k++) { h += slots(s + k); if (worked(s + k)) dd++; } maxH = Math.max(maxH, h); maxD = Math.max(maxD, dd); }
    // longest run of working days around the cycle; a crew that never has a day off has no end to its run
    const neverOff = shifts === n;
    let run = 0, longest = 0;
    if (neverOff) longest = n;
    else {
      const start = [...Array(n).keys()].find((d) => !worked(d))!;       // begin on a day off, so no run is split by the wrap
      for (let k = 1; k <= n; k++) { if (worked(start + k)) { run++; longest = Math.max(longest, run); } else run = 0; }
    }
    // the rest between one shift and the next, on consecutive days
    let rest: number | null = null;
    for (let d = 0; d < n; d++) {
      const x = day(d), y = day(d + 1);
      if (!x || !y) continue;
      const gap = (SPD + y.startSlot - (x.startSlot + x.lengthSlots)) / 4;
      rest = rest === null ? gap : Math.min(rest, gap);
    }
    // weekends, over as many days as it takes for the cycle and the week to line up
    let wkendDays = 0, offWeekends = 0, weeks = 0;
    for (let d = 0; d < lcm; d++) {
      const dow = mod(a.anchorDow + d, 7);
      if (dow >= 5 && worked(d)) wkendDays++;
      if (dow === 6) { weeks++; if (!worked(d) && !worked(d - 1)) offWeekends++; }
    }
    return {
      name: c.name, offsetDays: c.offsetDays, shiftsPerCycle: shifts, paidHoursPerCycle: r1(paid / 4), averageWeeklyHours: r1((paid / 4) * 7 / n),
      maxHoursInAnyWeek: r1(maxH / 4), maxDaysInAnyWeek: maxD, longestRun: longest, neverOff, shortestRestHours: rest === null ? null : r1(rest),
      weekendDaysPerWeek: r2(wkendDays / (lcm / 7)), weekendsFullyOff: weeks ? r2(offWeekends / weeks) : 0,
    };
  });

  if (!crews.length || crews.every((c) => c.shiftsPerCycle === 0)) { findings.push({ level: 'WARN', text: 'No day in this pattern has a shift yet.' }); return { crews, findings, cycleDays: n }; }
  const c0 = crews[0], L = a.limits;
  if (c0.neverOff) findings.push({ level: 'WARN', text: 'There is no day off anywhere in the cycle.' });
  if (a.contractHours && Math.abs(c0.averageWeeklyHours - a.contractHours) > 1) {
    findings.push({ level: 'WARN', text: `The pattern averages ${c0.averageWeeklyHours} h a week, but contracts are ${a.contractHours} h. ${c0.averageWeeklyHours > a.contractHours ? 'The difference is overtime, or time owed back.' : 'People would be paid for hours they are not scheduled.'}` });
  } else if (a.contractHours) findings.push({ level: 'OK', text: `Averages ${c0.averageWeeklyHours} h a week, in line with ${a.contractHours} h contracts.` });
  if (L.maxWeeklyHours && c0.maxHoursInAnyWeek > L.maxWeeklyHours + 1e-9) findings.push({ level: 'WARN', text: `In the busiest seven days people work ${c0.maxHoursInAnyWeek} h, over the ${L.maxWeeklyHours} h weekly limit.` });
  if (L.maxDaysPerWeek && c0.maxDaysInAnyWeek > L.maxDaysPerWeek) findings.push({ level: 'WARN', text: `In the busiest seven days people work ${c0.maxDaysInAnyWeek} days, over the limit of ${L.maxDaysPerWeek}.` });
  if (L.maxConsecutiveDays && !c0.neverOff && c0.longestRun > L.maxConsecutiveDays) findings.push({ level: 'WARN', text: `The longest run is ${c0.longestRun} working days in a row, over the limit of ${L.maxConsecutiveDays}.` });
  if (L.minRestHours && c0.shortestRestHours !== null && c0.shortestRestHours < L.minRestHours - 1e-9) findings.push({ level: 'WARN', text: `Some shifts are only ${c0.shortestRestHours} h apart (for example when the cycle moves from a late shift to an early one), under the ${L.minRestHours} h rest limit.` });
  const wk = crews.map((c) => c.weekendDaysPerWeek);
  if (crews.length > 1 && Math.max(...wk) - Math.min(...wk) > 0.25) {
    const hi = crews[wk.indexOf(Math.max(...wk))], lo = crews[wk.indexOf(Math.min(...wk))];
    findings.push({ level: 'INFO', text: `${hi.name} works more weekend days (${hi.weekendDaysPerWeek} a week) than ${lo.name} (${lo.weekendDaysPerWeek}).` });
  }
  if (!findings.some((f) => f.level === 'WARN')) findings.push({ level: 'OK', text: 'No limit is broken by the pattern itself.' });
  return { crews, findings, cycleDays: n };
}
