/**
 * What the Today page says, and the arithmetic behind it. Pure functions: no database, no clock, nothing to mock, so every figure on the page can be checked by a test.
 *
 * Two rules the page keeps:
 *   - "All clear" is only said when every signal was actually checked and none is a problem. A signal that could not be checked is listed as such; it is never read as "fine".
 *   - Every percentage is a ratio of totals (people-time, minutes, contacts), never an average of percentages, so a quiet interval or a short shift does not count as much as a busy one.
 */

export const round1 = (x: number) => Math.round(x * 10) / 10;

export function weightedMean(items: { value: number; weight: number }[]): number | null {
  let w = 0, v = 0;
  for (const i of items) { if (!(i.weight > 0) || !Number.isFinite(i.value)) continue; w += i.weight; v += i.value * i.weight; }
  return w > 0 ? v / w : null;
}

/** Slots are quarter hours. Coverage is the share of the required people-time that is scheduled; short and surplus are counted separately, so a short interval is not cancelled out by a long one. */
export function dayCoverage(required: number[], scheduled: number[]) {
  let req = 0, met = 0, sched = 0, short = 0, over = 0;
  const n = Math.max(required.length, scheduled.length);
  for (let i = 0; i < n; i++) {
    const r = Math.max(0, required[i] ?? 0), s = Math.max(0, scheduled[i] ?? 0);
    req += r; sched += s; met += Math.min(r, s); short += Math.max(0, r - s); over += Math.max(0, s - r);
  }
  return { coveragePercent: req > 0 ? round1((100 * met) / req) : null, requiredHours: round1(req / 4), scheduledHours: round1(sched / 4), shortHours: round1(short / 4), surplusHours: round1(over / 4) };
}

/** Adherence for a set of people: all the minutes they were doing what was scheduled over all the minutes scheduled. (An average of each person's percentage would count a four-hour shift as much as an eight-hour one.) */
export function groupAdherencePercent(rows: { scheduledMin: number; adherentMin: number }[]): number | null {
  let sched = 0, adh = 0;
  for (const r of rows) { if (!(r.scheduledMin > 0)) continue; sched += r.scheduledMin; adh += Math.min(r.adherentMin, r.scheduledMin); }
  return sched > 0 ? round1((100 * adh) / sched) : null;
}

export interface Trend { direction: 'UP' | 'DOWN' | 'FLAT'; delta: number; better: boolean | null }
/** Change from `previous` to `current` in the figure's own units (percentage points for a percentage). Inside `flatBand` it is FLAT, because a move that small is noise. `better` says whether the change is good news. */
export function trendOf(current: number | null, previous: number | null, opts: { higherIsBetter: boolean; flatBand?: number }): Trend | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = round1(current - previous), band = opts.flatBand ?? 0.5;
  if (Math.abs(current - previous) < band) return { direction: 'FLAT', delta, better: null };
  const up = current > previous;
  return { direction: up ? 'UP' : 'DOWN', delta, better: up === opts.higherIsBetter };
}

export type Tone = 'good' | 'warn' | 'bad';
/** Against a target: at or past it is good; within `warnWithin` of it (points) is a warning; further is bad. */
export function toneFor(value: number | null, target: number, higherIsBetter: boolean, warnWithin = 10): Tone | undefined {
  if (value === null) return undefined;
  const gap = higherIsBetter ? target - value : value - target;
  return gap <= 1e-9 ? 'good' : gap <= warnWithin ? 'warn' : 'bad';
}

// ---------------------------------------------------------------- the attention rail

export type Area = 'schedule' | 'forecast' | 'live' | 'rta' | 'feed';
export type Severity = 'urgent' | 'check' | 'todo';
export interface Action { label: string; module: string; section: string; needs: string | null; allowed: boolean }
export interface AttentionItem { id: string; area: Area; severity: Severity; title: string; detail: string; action: Action | null }

export interface Signals {
  today: string;
  schedule: { checked: boolean; published: null | { id: string; name: string; periodStart: string; periodEnd: string; coveragePercent: number | null; violations: number; stale: string[] }; coversToday: boolean; draftsWithViolations: { name: string; violations: number }[] };
  forecast: { checked: boolean; publishedShort: null | { name: string; fromDay: string; toDay: string }; coversToday: boolean; daysLeft: number | null; waiting: { name: string; by: string | null }[]; approvedNotPublished: { name: string }[] };
  live: { checked: boolean; understaffedIntervals: number; worst: { time: string; gap: number } | null };
  rta: { checked: boolean; hasEvents: boolean; scheduledNow: boolean; outOfAdherence: number; unknownAgents: number; unmappedStates: { state: string; agents: number }[] };
  feed: { checked: boolean; lastHistoryDay: string | null; lagDays: number | null };
  targets: { coveragePercent: number };
}

export const SIGNAL_NAMES: Record<Area, string> = { schedule: 'the published schedule', forecast: 'the forecast', live: "today's live coverage", rta: 'agent activity (RTA)', feed: 'the volume feed' };
const FORECAST_RUNWAY_DAYS = 3;       // a forecast that ends in fewer days than this is about to leave the schedule without a requirement
const FEED_LAG_DAYS = 2;              // interval history more than this many days behind is a feed that has stopped

/** Roles in the order of what they act on: the same facts, the ones that person can fix first. */
export const FOCUS: Record<string, Area[]> = {
  WFM_ADMIN: ['schedule', 'forecast', 'live', 'rta', 'feed'], WFM_MANAGER: ['schedule', 'live', 'forecast', 'rta', 'feed'],
  FORECAST_PLANNER: ['forecast', 'feed', 'schedule', 'live', 'rta'], SCHEDULER: ['schedule', 'forecast', 'live', 'rta', 'feed'],
  SUPERVISOR_RTA: ['live', 'rta', 'schedule', 'forecast', 'feed'], ANALYST: ['schedule', 'forecast', 'live', 'rta', 'feed'], AGENT: [],
};

const plural = (n: number, one: string, many = one + 's') => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function buildAttention(s: Signals, can: (permission: string) => boolean): AttentionItem[] {
  const out: AttentionItem[] = [];
  const act = (label: string, module: string, section: string, needs: string | null): Action => ({ label, module, section, needs, allowed: needs === null || can(needs) });
  const add = (id: string, area: Area, severity: Severity, title: string, detail: string, action: Action | null) => out.push({ id, area, severity, title, detail, action });

  // ---- the published schedule
  if (s.schedule.checked) {
    const p = s.schedule.published;
    if (!p) add('schedule-none', 'schedule', 'check', 'No published schedule', 'Nobody is scheduled for this group, and adherence has nothing to compare against.', act('Generate a schedule', 'scheduling', 'generate-schedule', 'schedule:generate'));
    else {
      if (!s.schedule.coversToday) add('schedule-ended', 'schedule', 'urgent', `The published schedule does not cover today`, `"${p.name}" runs ${p.periodStart} to ${p.periodEnd}.`, act('Generate the next schedule', 'scheduling', 'generate-schedule', 'schedule:generate'));
      if (p.violations > 0) add('schedule-violations', 'schedule', 'urgent', `The published schedule breaks ${plural(p.violations, 'rule')}`, `"${p.name}" has people working more, with less rest or in ways their limits do not allow.`, act('See the violations', 'scheduling', 'schedule-timeline', 'schedule:read'));
      if (p.stale.length) add('schedule-stale', 'schedule', 'check', 'The published schedule is out of date', `${p.stale[0]}${p.stale.length > 1 ? ` (and ${p.stale.length - 1} more reason${p.stale.length > 2 ? 's' : ''})` : ''}`, act('Rebuild it', 'scheduling', 'generate-schedule', 'schedule:generate'));
      if (p.coveragePercent !== null && p.coveragePercent + 1e-9 < s.targets.coveragePercent) add('schedule-coverage', 'schedule', p.coveragePercent < s.targets.coveragePercent - 10 ? 'urgent' : 'check', `The schedule covers ${p.coveragePercent}% of the demand`, `The target is ${s.targets.coveragePercent}%.`, act('See where it is short', 'scheduling', 'schedule-timeline', 'schedule:read'));
    }
    for (const d of s.schedule.draftsWithViolations) add(`draft-${d.name}`, 'schedule', 'todo', `Draft "${d.name}" has ${plural(d.violations, 'rule violation')}`, 'They must be fixed before it can be published.', act('Open the draft', 'scheduling', 'schedule-timeline', 'schedule:read'));
  }

  // ---- the forecast
  if (s.forecast.checked) {
    const f = s.forecast;
    if (!f.publishedShort) add('forecast-none', 'forecast', 'check', 'No published short-term forecast', 'Live coverage, staffing and adherence targets need one.', act('Build a forecast', 'forecasting', 'forecast-builder', 'forecast:create'));
    else {
      if (!f.coversToday) add('forecast-gap', 'forecast', 'urgent', 'No published forecast covers today', `"${f.publishedShort.name}" runs ${f.publishedShort.fromDay} to ${f.publishedShort.toDay}, so today has no requirement.`, act('Build a forecast', 'forecasting', 'forecast-builder', 'forecast:create'));
      else if (f.daysLeft !== null && f.daysLeft < FORECAST_RUNWAY_DAYS) add('forecast-ending', 'forecast', 'check', `The forecast ends ${f.daysLeft <= 0 ? 'today' : `in ${plural(f.daysLeft, 'day')}`}`, `"${f.publishedShort.name}" runs to ${f.publishedShort.toDay}; after that nothing sets the requirement.`, act('Build the next forecast', 'forecasting', 'forecast-builder', 'forecast:create'));
    }
    for (const w of f.waiting) add(`forecast-waiting-${w.name}`, 'forecast', 'todo', `"${w.name}" is waiting for approval`, `Submitted by ${w.by ?? 'a planner'}.`, act('Review it', 'forecasting', 'all-forecasts', 'forecast:approve'));
    for (const a of f.approvedNotPublished) add(`forecast-approved-${a.name}`, 'forecast', 'todo', `"${a.name}" is approved but not published`, 'Publish it so scheduling and staffing use it.', act('Publish it', 'forecasting', 'all-forecasts', 'forecast:publish'));
  }

  // ---- today's live coverage
  if (s.live.checked && s.live.understaffedIntervals > 0) {
    const w = s.live.worst;
    add('live-short', 'live', 'urgent', `${plural(s.live.understaffedIntervals, 'upcoming interval')} understaffed`, w ? `Worst at ${w.time}: ${Math.abs(w.gap)} fewer people than needed.` : 'Fewer people are scheduled than needed.', act('Open live coverage', 'intraday', 'live-coverage', 'intraday:read'));
  }

  // ---- agent activity
  if (s.rta.checked) {
    const r = s.rta;
    if (!r.hasEvents && r.scheduledNow) add('rta-silent', 'rta', 'check', 'No agent activity is arriving', 'People are scheduled right now but no status has been received today, so adherence cannot be judged. Check the RTA feed.', act('Check the RTA mapping', 'configuration', 'rta-mapping', 'config:read'));
    if (r.hasEvents && r.outOfAdherence > 0) add('rta-out', 'rta', 'check', `${plural(r.outOfAdherence, 'agent')} out of adherence`, 'Their status differs from the published schedule beyond the grace period.', act('Open adherence', 'intraday', 'adherence', 'intraday:read'));
    if (r.unknownAgents > 0 || r.unmappedStates.length) {
      const names = r.unmappedStates.slice(0, 3).map((u) => u.state).join(', ');
      add('rta-unmapped', 'rta', 'check', `${plural(r.unknownAgents, 'agent')} in a state the system cannot read`, names ? `${names} ${r.unmappedStates.length === 1 ? 'cannot' : 'cannot'} be matched to an activity, so those agents are not judged.` : 'Their state cannot be matched to an activity, so they are not judged.', act('Map the states', 'configuration', 'rta-mapping', 'config:write'));
    }
  }

  // ---- the volume feed
  if (s.feed.checked && s.feed.lagDays !== null && s.feed.lagDays > FEED_LAG_DAYS) add('feed-stale', 'feed', 'check', `The volume feed is ${plural(s.feed.lagDays, 'day')} behind`, `The latest interval history is for ${s.feed.lastHistoryDay}. Forecast accuracy and live actuals are going stale.`, act('Open the data feeds', 'data', 'staged-ingestion', 'data:read'));

  return out;
}

const RANK: Record<Severity, number> = { urgent: 0, check: 1, todo: 2 };
/** Most serious first; inside a severity, what this role acts on first; then in a fixed order so the rail does not shuffle between refreshes. */
export function orderFor(items: AttentionItem[], role: string): AttentionItem[] {
  const focus = FOCUS[role] ?? FOCUS.WFM_ADMIN;
  const at = (a: Area) => { const i = focus.indexOf(a); return i < 0 ? focus.length : i; };
  return [...items].sort((a, b) => RANK[a.severity] - RANK[b.severity] || at(a.area) - at(b.area) || a.id.localeCompare(b.id));
}

export type VerdictStatus = 'ATTENTION' | 'PARTIAL' | 'OK';
export interface Verdict { status: VerdictStatus; text: string; checked: string[]; notChecked: string[] }
/** The one line on top of the page. OK only when nothing is wrong AND everything was checked. */
export function verdictOf(s: Signals, items: AttentionItem[], hidden: Area[] = []): Verdict {
  const areas = (['schedule', 'forecast', 'live', 'rta', 'feed'] as Area[]).filter((a) => !hidden.includes(a));      // what this person's role is not shown is not "unchecked": it is not theirs
  const checked = areas.filter((a) => s[a].checked).map((a) => SIGNAL_NAMES[a]);
  const notChecked = areas.filter((a) => !s[a].checked).map((a) => SIGNAL_NAMES[a]);
  const serious = items.filter((i) => i.severity !== 'todo');
  if (serious.length) return { status: 'ATTENTION', text: `${plural(serious.length, 'thing')} need${serious.length === 1 ? 's' : ''} attention`, checked, notChecked };
  if (notChecked.length) return { status: 'PARTIAL', text: `Nothing wrong in what could be checked; ${notChecked.join(', ')} could not be`, checked, notChecked };
  return { status: 'OK', text: 'Everything checked is on track', checked, notChecked };
}
