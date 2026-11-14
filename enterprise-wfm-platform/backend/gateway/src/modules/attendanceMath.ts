/**
 * What happened on one scheduled day, from the schedule and the punches, as plain arithmetic with no database.
 *
 * Times are minutes on one clock for the person-day: 0 is midnight at the start of `day`, so a shift that runs past midnight ends after 1440 and "now" before the day starts is negative.
 * Punches are wall-clock times (the time-clock file's own clock, stored as if UTC), compared with the schedule's wall-clock slots: the same convention the import and the manual form use.
 */
export type DayStatus = 'MATCHED' | 'MISSED' | 'UNSCHEDULED' | 'OPEN' | 'UPCOMING';
/** What a person-day can be filtered by. A day can have more than one (late and then early leave). */
export type Issue = 'missed' | 'late' | 'early' | 'open' | 'unscheduled' | 'upcoming' | 'excused' | 'ok';
export const ISSUES: Issue[] = ['missed', 'late', 'early', 'open', 'unscheduled', 'upcoming', 'excused', 'ok'];
/** The problems a manager can excuse. (A day nobody was scheduled on, or that has not happened yet, has nothing to excuse.) */
export type ExcusableKind = 'missed' | 'late' | 'early' | 'open';
export const EXCUSABLE: ExcusableKind[] = ['missed', 'late', 'early', 'open'];
export const REASONS = ['APPROVED_ABSENCE', 'CLOCK_FAULT', 'SYSTEM_OUTAGE', 'WORKED_ELSEWHERE', 'MANAGER_OVERRIDE', 'OTHER'] as const;
export type ReasonCode = typeof REASONS[number];

export interface Sched { hours: number; startMin: number; endMin: number }
export interface PunchMin { inMin: number; outMin: number | null }
export interface DayFacts { sched: Sched | null; punches: PunchMin[]; nowMin: number; graceMin: number }
export interface DayResult { status: DayStatus; actualHours: number; lateMinutes: number; earlyLeaveMinutes: number; due: boolean; issues: Issue[] }

const r1 = (v: number) => Math.round(v * 10) / 10;

export function classifyDay(f: DayFacts): DayResult {
  const { sched, punches, nowMin, graceMin } = f;
  const scheduled = !!sched && sched.hours > 0;
  const actualHours = r1(punches.reduce((s, p) => s + (p.outMin !== null ? (p.outMin - p.inMin) / 60 : 0), 0));
  const open = punches.some((p) => p.outMin === null);
  // a scheduled day is only "missed" once the shift is over (and the grace has passed): before that the person may simply not have arrived yet
  const due = scheduled ? nowMin >= sched!.endMin + graceMin : true;
  const status: DayStatus = !punches.length && scheduled ? (due ? 'MISSED' : 'UPCOMING') : punches.length && !scheduled ? 'UNSCHEDULED' : open ? 'OPEN' : 'MATCHED';

  let lateMinutes = 0, earlyLeaveMinutes = 0;
  if (scheduled && punches.length) {
    const first = Math.min(...punches.map((p) => p.inMin));
    if (first - sched!.startMin > graceMin) lateMinutes = first - sched!.startMin;
    const closed = punches.filter((p) => p.outMin !== null);
    // leaving early only counts when nobody is still clocked in (an open punch is a different problem) and they actually clocked out
    if (!open && closed.length) {
      const last = Math.max(...closed.map((p) => p.outMin as number));
      if (sched!.endMin - last > graceMin) earlyLeaveMinutes = sched!.endMin - last;
    }
  }

  const issues: Issue[] = [];
  if (status === 'MISSED') issues.push('missed');
  if (lateMinutes) issues.push('late');
  if (earlyLeaveMinutes) issues.push('early');
  if (status === 'OPEN') issues.push('open');
  if (status === 'UNSCHEDULED') issues.push('unscheduled');
  if (status === 'UPCOMING') issues.push('upcoming');
  if (!issues.length) issues.push('ok');
  return { status, actualHours, lateMinutes, earlyLeaveMinutes, due, issues };
}

/** The one thing to show for a day when there is room for only one: the most serious. */
export function headlineIssue(issues: Issue[]): Issue {
  return ISSUES.find((i) => issues.includes(i)) ?? 'ok';
}

export type Counts = Record<Issue, number> & { total: number; punches: number; dueScheduled: number; noPunch: number };
export function emptyCounts(): Counts { return { missed: 0, late: 0, early: 0, open: 0, unscheduled: 0, upcoming: 0, excused: 0, ok: 0, total: 0, punches: 0, dueScheduled: 0, noPunch: 0 }; }
/** Person-days per issue (a day with two issues counts under both, so the issues can add up to more than the total). */
export function tally(days: { issues: Issue[]; punchCount: number; scheduledHours: number; due: boolean }[]): Counts {
  const c = emptyCounts();
  for (const d of days) {
    c.total++; c.punches += d.punchCount;
    for (const i of d.issues) c[i]++;
    if (d.scheduledHours > 0 && d.due) { c.dueScheduled++; if (d.punchCount === 0) c.noPunch++; }
  }
  return c;
}

/**
 * Nearly every scheduled day that is over has no punch at all. That is almost never 300 people skipping work: the time-clock file has not been imported (or the feed is down), and showing a
 * wall of red "missed" says nothing. The screen mutes the red and says so once instead.
 */
export function feedLooksMissing(c: Pick<Counts, 'noPunch' | 'dueScheduled'>): boolean {
  // counted from days with no punch at all, not from "missed", so excusing them does not make the warning disappear
  return c.dueScheduled >= 10 && c.noPunch / c.dueScheduled >= 0.9;
}

/**
 * Take the excused problems off a day. A day whose only problems were excused is "excused" (not "ok": something did go wrong, and someone dealt with it); a day with other problems left
 * keeps them and also counts as having an excused one. An excuse for a problem the day does not have is ignored.
 */
export function applyExcuses(issues: Issue[], excused: ExcusableKind[]): Issue[] {
  const hit = issues.filter((i) => (excused as Issue[]).includes(i));
  if (!hit.length) return issues;
  const rest = issues.filter((i) => !(excused as Issue[]).includes(i) && i !== 'ok');
  return [...rest, 'excused'];
}

/** Order for the person list: people with the most problems first, then by name. */
export function problemScore(c: { missed: number; late: number; early: number; open: number }): number {
  return c.missed * 3 + c.late * 2 + c.early * 2 + c.open;
}

/** The grace, in whole minutes, from the adherence grace in seconds (at least one minute: a punch is only recorded to the minute). */
export const graceMinutes = (seconds: number | null | undefined) => Math.max(1, Math.round((seconds ?? 300) / 60));

/** Minutes of a wall-clock timestamp text ("2026-01-05 08:58:00+00" or an ISO string) from midnight at the start of `day`. */
export function minutesFromDay(stamp: string, day: string): number {
  const d = stamp.slice(0, 10), t = stamp.slice(11, 16);
  const days = Math.round((Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) - Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))) / 864e5);
  return days * 1440 + Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
}

/** "Now" on the group's wall clock, as minutes from midnight at the start of `day` (negative for a day still to come). */
export function nowMinutesFrom(day: string, tz: string, at = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const days = Math.round((Date.UTC(g('year'), g('month') - 1, g('day')) - Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))) / 864e5);
  return days * 1440 + g('hour') * 60 + g('minute');
}

/**
 * The week for the screen: one row per person (their days across, totals, overtime), with counts per kind of problem, a filter by problem, a search, and a page of people at a time, those
 * with the most problems first. The counts cover the whole week for everyone matching the search, whatever page or filter is showing.
 */
export function weekView(days: any[], weeks: any[], opts: { issue?: Issue; q?: string; limit: number; offset: number }) {
  const q = (opts.q ?? '').trim().toLowerCase();
  const byPerson = new Map<string, any[]>();
  for (const d of days) {
    if (q && !`${d.name} ${d.employeeNumber}`.toLowerCase().includes(q)) continue;
    byPerson.set(d.employeeId, [...(byPerson.get(d.employeeId) ?? []), d]);
  }
  const overtime = new Map<string, number>();
  for (const w of weeks) overtime.set(w.employeeId, r1((overtime.get(w.employeeId) ?? 0) + w.overtimeHours));
  const all = [...byPerson.values()].flat();
  const counts = tally(all.map((d) => ({ issues: d.issues, punchCount: d.punches.length, scheduledHours: d.scheduledHours, due: d.due })));
  const people = [...byPerson.entries()].map(([employeeId, ds]) => {
    const n = (i: Issue) => ds.filter((d) => d.issues.includes(i)).length;
    const c = { missed: n('missed'), late: n('late'), early: n('early'), open: n('open'), excused: n('excused') };
    const scheduledHours = r1(ds.reduce((s, d) => s + d.scheduledHours, 0)), actualHours = r1(ds.reduce((s, d) => s + d.actualHours, 0));
    // variance only counts days that are over: a shift later in the week is not "8 hours short" yet
    const doneSched = ds.filter((d) => d.due).reduce((s, d) => s + d.scheduledHours, 0), doneActual = ds.filter((d) => d.due).reduce((s, d) => s + d.actualHours, 0);
    return { employeeId, employeeNumber: ds[0].employeeNumber, name: ds[0].name, scheduledHours, actualHours, varianceHours: r1(doneActual - doneSched), overtimeHours: overtime.get(employeeId) ?? 0, problems: c, score: problemScore(c), days: ds };
  }).filter((p) => !opts.issue || p.days.some((d) => d.issues.includes(opts.issue!)))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return { counts, feedMissing: feedLooksMissing(counts), total: people.length, people: people.slice(opts.offset, opts.offset + opts.limit).map(({ score: _s, ...rest }) => rest) };
}


// ---------------------------------------------------------------- the daily note

const WORDS: Record<ExcusableKind, string> = { missed: 'missed', late: 'late', early: 'left early', open: 'still clocked in' };
export interface Problem { teamId: string | null; kinds: ExcusableKind[] }

/** Per person to tell: how many of each kind of problem are theirs. Pure: who is told is decided by the caller. */
export function summarizeFor(problems: Problem[], audienceOf: (teamId: string | null) => string[]) {
  const per = new Map<string, Record<ExcusableKind, number>>();
  for (const p of problems) for (const u of audienceOf(p.teamId)) {
    const c = per.get(u) ?? { missed: 0, late: 0, early: 0, open: 0 };
    for (const k of p.kinds) c[k]++;
    per.set(u, c);
  }
  return per;
}
export const wordsFor = (c: Record<ExcusableKind, number>) => EXCUSABLE.filter((k) => c[k] > 0).map((k) => `${c[k]} ${WORDS[k]}`).join(', ');

