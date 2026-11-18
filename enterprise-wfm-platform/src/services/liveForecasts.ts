/**
 * Several published short-term forecasts can be live for one group, each for its own stretch of days. What publishing a forecast does among them, which forecasts a schedule can follow, and the
 * history dates a new forecast starts from. Pure functions (no React, no browser), tested on their own. The gateway applies the same rules when it publishes.
 */
export interface Fv { id: string; seq: number; name: string; status: string; kind: string; fromDay: string; toDay: string; publishedAt?: string | null; publishedBy?: string | null }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const utc = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
export const addDay = (d: string, n: number) => new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
export const dayCount = (a: string, b: string) => Math.round((utc(b) - utc(a)) / 86_400_000) + 1;
/** "18 Nov" (the year only when it is not the one given) */
export const niceDate = (d: string, yearOf?: number) => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]}${yearOf !== undefined && +d.slice(0, 4) !== yearOf ? ` ${d.slice(0, 4)}` : ''}`;
const span = (f: { fromDay: string; toDay: string }) => `${niceDate(f.fromDay)} to ${niceDate(f.toDay)}`;

export const sameHorizon = (a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }) => a.fromDay === b.fromDay && a.toDay === b.toDay;
export function overlapDays(a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }): number {
  const from = a.fromDay > b.fromDay ? a.fromDay : b.fromDay, to = a.toDay < b.toDay ? a.toDay : b.toDay;
  return from > to ? 0 : dayCount(from, to);
}

// ---------------------------------------------------------------- publishing

/** What publishing a forecast for these dates will do, in plain words: the live forecast it replaces (same dates) and the ones that stay live. */
export function publishLines(v: { id?: string; fromDay: string; toDay: string }, all: Fv[]): { replaces: Fv[]; lines: string[] } {
  const live = all.filter((f) => f.kind === 'SHORT' && f.status === 'PUBLISHED' && f.id !== v.id);
  const replaces = live.filter((f) => sameHorizon(f, v));
  const rest = live.filter((f) => !sameHorizon(f, v));
  const lines: string[] = [];
  if (replaces.length) lines.push(`Replaces ${replaces.map((f) => `v${f.seq}`).join(', ')}, which covers the same period (${span(v)}). ${replaces.length === 1 ? 'It is' : 'They are'} archived and kept.`);
  else lines.push(`Nothing is replaced. This becomes a live forecast for ${span(v)}.`);
  for (const f of rest) {
    const n = overlapDays(f, v);
    lines.push(n > 0 ? `v${f.seq} stays live and shares ${n} day${n === 1 ? '' : 's'} with it; for those days the one published last is used.` : `v${f.seq} (${span(f)}) stays live.`);
  }
  return { replaces, lines };
}

// ---------------------------------------------------------------- what a schedule can follow

export interface ForecastChoice { fv: Fv; covers: 'ALL' | 'PART' | 'NONE'; coveredDays: number; totalDays: number; live: boolean; note: string }

/**
 * The short-term forecasts a schedule for these dates could follow, best first: a published forecast that covers every day, then one still being reviewed that does, then ones that cover only part,
 * then ones that cover none (shown so the reason is visible). Archived forecasts are left out unless asked for.
 */
export function forecastChoices(o: { from: string; to: string; forecasts: Fv[]; withArchived?: boolean }): ForecastChoice[] {
  const total = dayCount(o.from, o.to);
  const when = (f: Fv) => (f.publishedAt ? Date.parse(f.publishedAt) : 0);
  const rows = o.forecasts.filter((f) => f.kind === 'SHORT' && (o.withArchived || f.status !== 'ARCHIVED')).map((fv): ForecastChoice => {
    const coveredDays = overlapDays(fv, { fromDay: o.from, toDay: o.to }), live = fv.status === 'PUBLISHED';
    const covers = coveredDays >= total ? 'ALL' : coveredDays > 0 ? 'PART' : 'NONE';
    const state = live ? 'live' : fv.status === 'DRAFT' ? 'draft' : fv.status === 'SUBMITTED' ? 'waiting for approval' : fv.status === 'APPROVED' ? 'approved, not published' : 'archived';
    const there = shortSpan(fv.fromDay, fv.toDay, new Date().getFullYear());
    const note = covers === 'ALL' ? `Covers all ${total} days · ${state}` : covers === 'PART' ? `Covers ${coveredDays} of ${total} days (${there}) · ${state}` : `Does not cover these dates (${there}) · ${state}`;
    return { fv, covers, coveredDays, totalDays: total, live, note };
  });
  const rank = (c: ForecastChoice) => (c.covers === 'ALL' ? 0 : c.covers === 'PART' ? 2 : 4) + (c.live ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || when(b.fv) - when(a.fv) || b.fv.seq - a.fv.seq);
}

/** What "Automatic" follows: the best published forecast covering every day; else the published one covering most. Null when nothing published reaches these dates. */
export function automaticChoice(choices: ForecastChoice[]): ForecastChoice | null {
  const live = choices.filter((c) => c.live && c.covers !== 'NONE');
  return live.find((c) => c.covers === 'ALL') ?? [...live].sort((a, b) => b.coveredDays - a.coveredDays)[0] ?? null;
}

// ---------------------------------------------------------------- the picker on Generate Schedule

// One way of writing dates on the Generate Schedule page. A day is "Nov 16" (with its weekday where the weekday matters: "Mon, Nov 16"); a range joins two days with an en dash and shares
// what it can: "Nov 16 – 22", "Nov 28 – Dec 4". The year is written only when it is not `yearOf` (the current year): "Dec 28 – Jan 3, 2027". Never "16 Nov", never "to".
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const LONG_WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dowOf = (d: string) => (new Date(utc(d)).getUTCDay() + 6) % 7;
const yearText = (d: string, yearOf?: number) => (yearOf !== undefined && +d.slice(0, 4) !== yearOf ? `, ${d.slice(0, 4)}` : '');

/** "Nov 16" */
export const monthDay = (d: string, yearOf?: number) => `${MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}${yearText(d, yearOf)}`;
/** "Mon, Nov 16" */
export const dayWithWeekday = (d: string, yearOf?: number) => `${WEEKDAYS[dowOf(d)]}, ${monthDay(d, yearOf)}`;
/** "Monday, Nov 16, 2026": the full date, for reading back a date typed into a date box (whose own display follows the browser's language). */
export const longDay = (d: string) => `${LONG_WEEKDAYS[dowOf(d)]}, ${LONG_MONTHS[+d.slice(5, 7) - 1]} ${+d.slice(8, 10)}, ${d.slice(0, 4)}`;

/** "Nov 16 – 22" (one month), "Nov 28 – Dec 4" (two months), "Dec 28 – Jan 3, 2027" (two years); one day alone is "Nov 16". */
export function shortSpan(from: string, to: string, yearOf?: number): string {
  if (from === to) return monthDay(from, yearOf);
  const [fy, fm] = [from.slice(0, 4), from.slice(5, 7)], [ty, tm] = [to.slice(0, 4), to.slice(5, 7)];
  const toDayNum = +to.slice(8, 10);
  if (fy === ty && fm === tm) return `${MONTHS[+fm - 1]} ${+from.slice(8, 10)} – ${toDayNum}${yearText(to, yearOf)}`;
  if (fy === ty) return `${MONTHS[+fm - 1]} ${+from.slice(8, 10)} – ${MONTHS[+tm - 1]} ${toDayNum}${yearText(to, yearOf)}`;
  return `${monthDay(from, yearOf)} – ${monthDay(to, yearOf)}`;
}
/** The schedule's period with weekdays, for the one line that states it: "Mon, Nov 16 – Sun, Nov 22". */
export const periodText = (from: string, to: string, yearOf?: number) => (from === to ? dayWithWeekday(from, yearOf) : `${dayWithWeekday(from, yearOf)} – ${dayWithWeekday(to, yearOf)}`);

/** Days as ranges: ["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-09"] -> "Nov 30 – Dec 2, Dec 9". Unsorted and repeated days are fine. */
export function daysText(days: string[], yearOf?: number): string {
  const sorted = [...new Set(days)].sort();
  const runs: [string, string][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && addDay(last[1], 1) === d) last[1] = d; else runs.push([d, d]);
  }
  return runs.map(([a, z]) => shortSpan(a, z, yearOf)).join(', ');
}

/** A forecast still has the name the system gave it ("Short-term v8 · 2 wk from 16 Nov") unless someone chose one. */
export const hasOwnName = (f: Pick<Fv, 'name' | 'seq'>) => !!f.name?.trim() && !new RegExp(`\\bv${f.seq}\\b`).test(f.name);
/** What a forecast is called on screen: the name someone gave it, else "Forecast v8". The version number always stays visible beside a given name. */
export const forecastTitle = (f: Pick<Fv, 'name' | 'seq'>) => (hasOwnName(f) ? f.name.trim() : `Forecast v${f.seq}`);

export type ChoiceSection = 'USABLE' | 'UNAPPROVED' | 'ARCHIVED' | 'NONE';
/** Where a choice sits in the picker: published and reaching the dates, not published yet, archived, or not reaching the dates at all. */
export function sectionOf(c: ForecastChoice): ChoiceSection {
  if (c.covers === 'NONE') return 'NONE';
  if (c.live) return 'USABLE';
  return c.fv.status === 'ARCHIVED' ? 'ARCHIVED' : 'UNAPPROVED';
}

export interface PickerView { auto: ForecastChoice | null; usable: ForecastChoice[]; unapproved: ForecastChoice[]; archived: ForecastChoice[]; none: ForecastChoice[]; hiddenUnapproved: number; hiddenNone: number }
/**
 * What the picker lists. Forecasts that are not published yet, and those that do not reach the dates, are tucked away unless `showUnapproved` ("show everything") is on (a schedule for real
 * people should follow a published forecast); one that is already chosen stays visible so the choice is never hidden from the person who made it. Archived ones come only with `withArchived` in the choices passed in.
 */
export function pickerView(choices: ForecastChoice[], o: { showUnapproved: boolean; chosenId?: string | null }): PickerView {
  const keep = (c: ForecastChoice) => c.fv.id === o.chosenId;
  const by = (k: ChoiceSection) => choices.filter((c) => sectionOf(c) === k);
  const unapprovedAll = by('UNAPPROVED');
  const unapproved = o.showUnapproved ? unapprovedAll : unapprovedAll.filter(keep);
  const noneAll = by('NONE'), none = o.showUnapproved ? noneAll : noneAll.filter(keep);
  return { auto: automaticChoice(choices), usable: by('USABLE'), unapproved, archived: by('ARCHIVED'), none, hiddenUnapproved: unapprovedAll.length - unapproved.length, hiddenNone: noneAll.length - none.length };
}

export const coverText = (c: ForecastChoice) => (c.covers === 'ALL' ? `Covers all ${c.totalDays} days` : c.covers === 'PART' ? `Covers ${c.coveredDays} of ${c.totalDays} days` : 'Does not reach these dates');
export const statusText = (f: Pick<Fv, 'status'>) => ({ PUBLISHED: 'Live', DRAFT: 'Draft', SUBMITTED: 'Waiting for approval', APPROVED: 'Approved, not published', ARCHIVED: 'Archived' } as Record<string, string>)[f.status] ?? f.status.toLowerCase();

export interface FvAccuracy { state: 'NONE' | 'SPARSE' | 'OK'; days: number; accuracyPct: number | null }
/** Days that have passed before a forecast's miss says anything useful about it: under this the figure is left out, not shown as a verdict. */
export const MIN_DAYS_TO_JUDGE = 7;
/** How well a forecast has done so far, in words: never a zero for "nothing to compare yet", and no percentage from a day or two. */
export function accuracyText(a?: FvAccuracy | null): string {
  if (!a || a.state === 'NONE' || a.accuracyPct === null || a.days < 1) return 'Accuracy: not measured yet';
  if (a.days < MIN_DAYS_TO_JUDGE) return `Too early to judge (${a.days} ${a.days === 1 ? 'day' : 'days'} so far)`;
  return a.state === 'OK' ? `${a.accuracyPct}% accurate over ${a.days} days` : `Early reading: ${a.accuracyPct}% over ${a.days} days`;
}

/** The sentence under "Automatic": exactly which forecast it will follow. */
export function autoLine(choices: ForecastChoice[], yearOf?: number): string {
  const a = automaticChoice(choices);
  if (!a) return 'No published forecast reaches these dates';
  return `Uses ${forecastTitle(a.fv)}${hasOwnName(a.fv) ? ` (v${a.fv.seq})` : ''} · live · ${coverText(a).toLowerCase()} (${shortSpan(a.fv.fromDay, a.fv.toDay, yearOf)})`;
}
/** The short form for the closed field: which forecast, and its dates. */
export function autoShort(choices: ForecastChoice[], yearOf?: number): string {
  const a = automaticChoice(choices);
  return a ? `${forecastTitle(a.fv)}${hasOwnName(a.fv) ? ` (v${a.fv.seq})` : ''} · ${shortSpan(a.fv.fromDay, a.fv.toDay, yearOf)}` : 'No published forecast reaches these dates';
}

// ---------------------------------------------------------------- history dates

export interface QueueDays { name: string; firstDay: string | null; lastDay: string | null; days: number }

/** The history to learn from when nothing was chosen: the last 12 months that have data (or all there is, if less), ending at the last day with data, never today. */
export function defaultHistory(queues: QueueDays[], today: string): { from: string; to: string } | null {
  const firsts = queues.map((q) => q.firstDay).filter(Boolean).sort() as string[], lasts = queues.map((q) => q.lastDay).filter(Boolean).sort() as string[];
  if (!firsts.length || !lasts.length) return null;
  const yesterday = addDay(today, -1), last = lasts.at(-1)! > yesterday ? yesterday : lasts.at(-1)!;
  const from = addDay(last, -364) > firsts[0] ? addDay(last, -364) : firsts[0];
  return from <= last ? { from, to: last } : null;
}

/** Quick picks for the history dates, each ending on `to`: the last 3, 6 and 12 months, and all of it. */
export const historyPicks = (to: string, first: string): { label: string; from: string }[] =>
  [{ label: 'Last 3 months', n: 91 }, { label: 'Last 6 months', n: 182 }, { label: 'Last 12 months', n: 364 }]
    .map((p) => ({ label: p.label, from: addDay(to, -p.n) })).filter((p) => p.from > first).concat([{ label: 'All of it', from: first }]);

/** How much of the chosen dates each queue has data for: at most its number of days of data (it may have gaps), and none outside the days it starts and ends. */
export function queueDaysIn(queues: QueueDays[], from: string, to: string): { name: string; days: number; total: number; thin: boolean }[] {
  const total = dayCount(from, to);
  return queues.map((q) => {
    const inside = q.firstDay && q.lastDay ? overlapDays({ fromDay: q.firstDay, toDay: q.lastDay }, { fromDay: from, toDay: to }) : 0;
    const days = Math.min(q.days, inside);
    return { name: q.name, days, total, thin: days < 28 };
  });
}
