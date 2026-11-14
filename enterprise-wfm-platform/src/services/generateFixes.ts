/**
 * Rules behind the Generate Schedule checklist, with no React and no browser so they are tested on their own: when the forecast does not cover the dates picked, what would put it right
 * (start on a day it does cover, open the draft that does, or build one), how a shift template is named so its start window is not read as its hours, and how long a build is said to take.
 */
export interface Fc { id: string; seq: number; name: string; status: string; kind: string; fromDay: string; toDay: string }
export type ForecastFix =
  | { kind: 'NONE' }
  | { kind: 'START'; startDay: string; text: string; label: string }
  | { kind: 'DRAFT'; version: Fc; text: string; label: string }
  | { kind: 'BUILD'; text: string; label: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "3 Jan 2027" */
export const niceDay = (d: string): string => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${MONTHS[m - 1]} ${y}`; };
const utc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const addDay = (d: string, n: number) => new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
/** Monday 0 ... Sunday 6 */
export const dowOf = (d: string): number => (new Date(utc(d)).getUTCDay() + 6) % 7;
/** The first day on or after `day` that starts a pay week (the schedule's weeks start on that weekday). */
export const startOnOrAfter = (day: string, weekStart: number): string => addDay(day, (weekStart - dowOf(day) + 7) % 7);

const RANK: Record<string, number> = { APPROVED: 3, SUBMITTED: 2, DRAFT: 1 };

/** Nothing when a published short-term forecast covers any of the dates; otherwise the one thing that would fix it. */
export function forecastFix(o: { from: string; weeks: number; weekStart: number; forecasts: Fc[] }): ForecastFix {
  const to = addDay(o.from, o.weeks * 7 - 1);
  const live = o.forecasts.filter((f) => f.kind === 'SHORT' && f.status !== 'ARCHIVED');
  const overlaps = (f: Fc) => f.fromDay <= to && f.toDay >= o.from;
  if (live.some((f) => f.status === 'PUBLISHED' && overlaps(f))) return { kind: 'NONE' };
  // a draft that does cover the dates: it only has to be reviewed and published
  const draft = live.filter((f) => f.status !== 'PUBLISHED' && overlaps(f)).sort((a, b) => (RANK[b.status] ?? 0) - (RANK[a.status] ?? 0) || b.seq - a.seq)[0];
  if (draft) return { kind: 'DRAFT', version: draft, text: `Forecast v${draft.seq} covers these dates but is ${draft.status === 'DRAFT' ? 'still a draft' : draft.status === 'SUBMITTED' ? 'waiting for approval' : 'approved but not published'}`, label: `Open forecast v${draft.seq} to publish it` };
  const published = live.filter((f) => f.status === 'PUBLISHED').sort((a, b) => b.seq - a.seq)[0];
  if (published && published.fromDay > to) {
    let startDay = startOnOrAfter(published.fromDay, o.weekStart);
    if (startDay > published.toDay) startDay = published.fromDay;
    return { kind: 'START', startDay, text: `The published forecast covers ${niceDay(published.fromDay)} to ${niceDay(published.toDay)}, not ${niceDay(o.from)} to ${niceDay(to)}`, label: `Start on ${niceDay(startDay)}` };
  }
  if (published) return { kind: 'BUILD', text: `The published forecast ended on ${niceDay(published.toDay)}`, label: 'Build a forecast for these dates' };
  return { kind: 'BUILD', text: 'No published short-term forecast', label: 'Build a forecast for these dates' };
}

/** Days with no staffing target: start on the first day the published forecast covers when they come before it, otherwise a forecast has to be built. */
export function uncoveredFix(uncovered: string[], published: Fc | undefined, weekStart: number): { kind: 'START'; startDay: string; label: string } | { kind: 'BUILD'; label: string } | null {
  if (!uncovered.length) return null;
  const first = [...uncovered].sort()[0];
  if (published && first < published.fromDay) { let s = startOnOrAfter(published.fromDay, weekStart); if (s > published.toDay) s = published.fromDay; return { kind: 'START', startDay: s, label: `Start on ${niceDay(s)}` }; }
  return { kind: 'BUILD', label: 'Build a forecast for these dates' };
}

// ---------------------------------------------------------------- templates and time

export interface TemplateLike { name: string; earliestStart: string; latestStart: string; durationHours: number }
const hrs = (n: number) => `${Math.round(n * 100) / 100}h`;
/** "Day shift · starts 06:00–09:00 · 8.5h": the times are when it may START, not the shift's hours, and the label says so. */
export const templateLabel = (t: TemplateLike): string => `${t.name} · starts ${t.earliestStart === t.latestStart ? t.earliestStart : `${t.earliestStart}–${t.latestStart}`} · ${hrs(t.durationHours)}`;

// ---------------------------------------------------------------- too many people for the work

/** Said before a build when the people chosen carry far more contract time than the forecast needs on shift (a quarter or more). */
export function crewNote(a: { people: number; contractHours: number; neededHours: number }): { text: string; neededPeople: number; surplusPct: number } | null {
  if (a.neededHours <= 0 || a.contractHours <= 0 || a.people <= 0 || a.contractHours / a.neededHours < 1.25) return null;
  const surplusPct = Math.round((1 - a.neededHours / a.contractHours) * 100);
  const neededPeople = Math.ceil((a.neededHours * a.people) / a.contractHours);
  const n = (x: number) => Math.round(x).toLocaleString('en-US');
  return { surplusPct, neededPeople, text: `Contracts give ${n(a.contractHours)} h but the forecast needs about ${n(a.neededHours)} h: about ${surplusPct}% of the paid time has no demand behind it. About ${neededPeople} of these ${a.people} people would cover it, so not everyone can reach their full contract without being overstaffed.` };
}

/** Shift choices the optimiser has to search, at most: people x days x every start time of every template (a template that runs on fewer weekdays counts for those days only). */
export function optionEstimate(a: { people: number; days: number; templates: { earliestStart: string; latestStart: string; startStepMinutes?: number | null; workDays?: number[] | null }[] }): number {
  const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  let per = 0;
  for (const t of a.templates) {
    const span = Math.max(0, mins(t.latestStart) - mins(t.earliestStart)), step = Math.max(5, t.startStepMinutes ?? 15);
    per += (Math.floor(span / step) + 1) * ((t.workDays?.length ?? 7) / 7);
  }
  return Math.round(a.people * a.days * per);
}
/** Above this many shift choices the optimiser stopped improving on its starting roster in our tests (355 people: tuned at 29,820 by this estimate, not at 59,640). */
export const OPTION_LIMIT = 45_000;
export const optionsNote = (n: number): string | null => (n > OPTION_LIMIT
  ? `About ${n.toLocaleString('en-US')} shift choices to search (people x days x start times). Above about ${OPTION_LIMIT.toLocaleString('en-US')} the optimiser tends to stop at its starting roster, which is valid but may be far from the best, whatever the solver time. Choose fewer templates or start times, or fewer people.`
  : null);

/** How much more paid time a schedule has than the forecast needs on shift, in whole percent (0 when it is not more). */
export const overstaffPct = (paidHours: number, neededHours: number): number => (neededHours > 0 && paidHours > neededHours ? Math.round((paidHours / neededHours - 1) * 100) : 0);

/** The solver tile's headline: a roster the optimiser could not improve says so, instead of "good solution". */
export const solverHeadline = (status: string, startingRosterOnly: boolean): string => (startingRosterOnly ? 'Starting roster only' : status === 'OPTIMAL' ? 'Best possible' : 'Good solution');

/** "45 seconds", "1 min 20 s", "6 minutes". */
export function durationText(seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
  const m = Math.floor(s / 60), r = s % 60;
  if (m >= 5 || r === 0) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
  return `${m} min${r ? ` ${r} s` : ''}`;
}
/** What a build is said to take: the most the solver is allowed, since it can stop sooner when it has a good roster. */
export const solveNote = (est: { people: number; windows: number; seconds: number }, limitSec: number): string =>
  `Takes up to about ${durationText(est.seconds)} for ${est.people} ${est.people === 1 ? 'person' : 'people'}: the search stops at ${limitSec} s per four-week window, sooner if it has a good roster. It can be changed under Advanced.`;
