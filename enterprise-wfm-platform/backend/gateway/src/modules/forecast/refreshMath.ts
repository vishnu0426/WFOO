/**
 * The rules of the scheduled forecast refresh, with no database: when is a schedule due, is the data fresh enough, what the report says, and what the notification says. The runner
 * (refresh.ts) gathers the facts and these decide what they mean.
 */
export interface Schedule { enabled: boolean; frequency: 'DAILY' | 'WEEKLY'; dayOfWeek: number; hour: number; lastRunDay: string | null }
/** "Now" on the group's wall clock: its date, weekday (Monday 0) and hour. */
export interface LocalNow { day: string; dow: number; hour: number }

const DOW = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const dowName = (d: number) => DOW[((d % 7) + 7) % 7];
const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;

/** Due when it is the scheduled weekday (any day for a daily one), the hour has come, and it has not already been tried today. */
export function isDue(s: Schedule, now: LocalNow): boolean {
  if (!s.enabled) return false;
  if (s.lastRunDay === now.day) return false;
  if (s.frequency === 'WEEKLY' && now.dow !== s.dayOfWeek) return false;
  return now.hour >= s.hour;
}

const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
/** When it will next run, as words for the screen: "Monday 06:00" (or "today at 06:00" / "tomorrow at 06:00"), with the date. */
export function nextRun(s: Schedule, now: LocalNow): { day: string; text: string } | null {
  if (!s.enabled) return null;
  for (let i = 0; i < 8; i++) {
    const day = addDay(now.day, i), dow = (now.dow + i) % 7;
    if (s.frequency === 'WEEKLY' && dow !== s.dayOfWeek) continue;
    if (i === 0) {
      if (s.lastRunDay === now.day) continue;                                    // already tried today: the next occasion
      return { day, text: now.hour >= s.hour ? 'now (it is due)' : `today at ${hh(s.hour)}` };
    }
    return { day, text: `${i === 1 ? 'tomorrow' : dowName(dow)} at ${hh(s.hour)}` };
  }
  return null;
}

export const describe = (s: Pick<Schedule, 'frequency' | 'dayOfWeek' | 'hour'>) => (s.frequency === 'DAILY' ? `every day at ${hh(s.hour)}` : `every ${dowName(s.dayOfWeek)} at ${hh(s.hour)}`);

// ---------------------------------------------------------------- is the data fresh enough

export interface Freshness { ok: boolean; newestDay: string | null; ageDays: number | null; limit: number; text: string }
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 864e5);
/** The newest history day against today. A day behind is normal (yesterday's intervals arrive overnight); older than the limit means the feed has stopped or been late. */
export function freshness(newestDay: string | null, today: string, limit: number): Freshness {
  if (!newestDay) return { ok: false, newestDay, ageDays: null, limit, text: 'There is no interval history for this group.' };
  const age = Math.max(0, days(newestDay, today));
  // "age" counts from the newest day to today: yesterday's data is 1 day old, which is as fresh as a nightly feed can be
  const ok = age <= limit;
  return { ok, newestDay, ageDays: age, limit, text: ok ? (age <= 1 ? 'The history is up to date (to yesterday).' : `The newest history is ${age} days old (the limit is ${limit}).`) : `The newest history is ${age} days old, which is more than the ${limit} allowed. Check the data feed.` };
}

// ---------------------------------------------------------------- the report

export type Verdict = 'GOOD' | 'CHECK' | 'POOR' | 'NO_DATA';
export interface QueueMiss { name: string; wapeDaily: number; bias: number; status: Verdict }
export interface AccuracyPart {
  status: Verdict; direction: 'IMPROVING' | 'STEADY' | 'WORSENING'; message: string;
  latestWeek: { weekStart: string; days: number; wapeDaily: number; bias: number } | null;
  /** The worst queues first (at most five). */
  queues: QueueMiss[];
}
export interface ComparePart { baseVersion: string; days: number; volumeBase: number | null; volumeNew: number | null; deltaPct: number | null; biggest: { day: string; delta: number; deltaPct: number | null } | null; peakRequiredBase: number | null; peakRequiredNew: number | null }

export interface Report {
  freshness: Freshness;
  live: { id: string; seq: number; name: string } | null;
  accuracy: AccuracyPart | null;
  /** The accuracy figure from the run before, so the report can say it improved or slipped. */
  previousWape: number | null;
  draft: { id: string; seq: number; name: string; fromDay: string; toDay: string; model: string | null } | null;
  compare: ComparePart | null;
  archivedDrafts: number;
  notified: number;
  /** The report in sentences, so a screen shows exactly what the notification says. */
  text?: { freshness: string; accuracy: string; compare: string };
}

const pct = (v: number, d = 1) => `${(Math.round(v * 10 ** (d + 2)) / 10 ** d).toLocaleString('en', { maximumFractionDigits: d })}%`;
const signedPct = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('en', { maximumFractionDigits: 1 })}%`;

/** How the live forecast did, in a sentence a planner can use. */
export function accuracyLine(a: AccuracyPart | null, previousWape: number | null): string {
  if (!a || !a.latestWeek) return 'There is not enough finished data yet to say how the live forecast did (it needs four days of a week).';
  const w = a.latestWeek, word = a.status === 'GOOD' ? 'good' : a.status === 'CHECK' ? 'worth watching' : 'poor';
  const bias = Math.abs(w.bias) < 0.02 ? 'with no real lean either way' : w.bias > 0 ? `running ${pct(w.bias)} high` : `running ${pct(Math.abs(w.bias))} low`;
  const trend = previousWape === null ? '' : w.wapeDaily < previousWape - 0.005 ? `, better than the ${pct(previousWape)} before` : w.wapeDaily > previousWape + 0.005 ? `, worse than the ${pct(previousWape)} before` : `, about the same as before`;
  return `The live forecast missed by ${pct(w.wapeDaily)} a day last week (${word}), ${bias}${trend}.`;
}

export function compareLine(c: ComparePart | null): string {
  if (!c) return 'There was no live forecast to compare the new draft with.';
  if (c.deltaPct === null || c.days === 0) return `The new draft and ${c.baseVersion} share no days to compare.`;
  if (c.deltaPct === 0) return `The new draft gives the same volume as ${c.baseVersion} over the ${c.days} days they share.`;
  const where = c.biggest ? ` Biggest difference: ${c.biggest.day} (${c.biggest.delta > 0 ? '+' : '−'}${Math.abs(Math.round(c.biggest.delta)).toLocaleString('en')} contacts).` : '';
  return `Over the ${c.days} days it shares with ${c.baseVersion}, the new draft is ${signedPct(c.deltaPct)} ${c.deltaPct > 0 ? 'higher' : 'lower'} (${c.deltaPct > 0 ? '+' : '−'}${Math.abs(Math.round((c.volumeNew ?? 0) - (c.volumeBase ?? 0))).toLocaleString('en')} contacts).${where}`;
}

export interface Note { title: string; body: string }
/** What the people who approve forecasts are told when a run ends. */
export function notification(o: { group: string; kind: 'SHORT' | 'LONG'; status: 'CREATED' | 'SKIPPED' | 'FAILED'; reason: string; report: Report }): Note {
  const type = o.kind === 'SHORT' ? 'short-term' : 'long-term';
  if (o.status === 'SKIPPED') return { title: `${o.group}: ${type} forecast not refreshed`, body: `${o.reason} No new draft was made. The live forecast is unchanged.` };
  if (o.status === 'FAILED') return { title: `${o.group}: ${type} forecast refresh failed`, body: `${o.reason} No new draft was made. The live forecast is unchanged; you can run it again from Forecasts > Auto-refresh.` };
  const parts = [accuracyLine(o.report.accuracy, o.report.previousWape), compareLine(o.report.compare), 'Review it under Forecasts, then submit it for approval.'];
  return { title: `${o.group}: new ${type} forecast draft is ready`, body: parts.join(' ') };
}

/** Pull the accuracy part out of what accuracyTrendFor returns (its `total` and `queues`). */
export function accuracyFrom(trend: { total: { status: Verdict; direction: AccuracyPart['direction']; message: string; latest: { weekStart: string; days: number; wapeDaily: number; bias: number } | null }; queues: { name: string; status: Verdict; latest: { wapeDaily: number; bias: number } | null }[] } | null): AccuracyPart | null {
  if (!trend) return null;
  const t = trend.total;
  const queues = trend.queues.filter((q) => q.latest).map((q) => ({ name: q.name, wapeDaily: q.latest!.wapeDaily, bias: q.latest!.bias, status: q.status })).sort((a, b) => b.wapeDaily - a.wapeDaily).slice(0, 5);
  return { status: t.status, direction: t.direction, message: t.message, latestWeek: t.latest ? { weekStart: t.latest.weekStart, days: t.latest.days, wapeDaily: t.latest.wapeDaily, bias: t.latest.bias } : null, queues };
}

/** The forecast length for the new draft: what was asked, else the same as the live one, else the usual. */
export function horizonFor(kind: 'SHORT' | 'LONG', s: { horizonWeeks: number | null; horizonDays: number | null }, live: { fromDay: string; toDay: string } | null): { weeks?: number; days?: number } {
  const span = live ? days(live.fromDay, live.toDay) + 1 : null;
  if (kind === 'SHORT') return { weeks: s.horizonWeeks ?? (span ? Math.min(18, Math.max(1, Math.ceil(span / 7))) : 6) };
  return { days: s.horizonDays ?? (span ? Math.min(730, Math.max(30, span)) : 365) };
}

/** "Now" on a group's wall clock, from a time zone name. */
export function localNow(tz: string, at = new Date()): LocalNow {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)!.value;
  const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(g('weekday'));
  return { day: `${g('year')}-${g('month')}-${g('day')}`, dow, hour: Number(g('hour')) };
}
