/**
 * Accuracy over time. The hold-out test says how good a forecast would have been; this says how good the published forecasts really were,
 * week after week, so drift shows up before the schedule suffers. Per queue and overall: the average miss (daily and 15-minute), whether the
 * forecast runs high or low, and whether it is getting better or worse.
 */
export interface DayRow { queueId: string; name: string; day: string; actual: number; forecast: number; absErr: number; intervals: number }
export interface WeekPoint { weekStart: string; days: number; actual: number; forecast: number; wapeDaily: number; wape15: number; bias: number }
export type Direction = 'IMPROVING' | 'STEADY' | 'WORSENING';
export interface QueueTrend {
  queueId: string; name: string; weeks: WeekPoint[]; latest: WeekPoint | null; direction: Direction; status: 'GOOD' | 'CHECK' | 'POOR' | 'NO_DATA';
  consistentBias: 'HIGH' | 'LOW' | null; message: string;
}

export const GOOD = 0.08, POOR = 0.15, BIAS = 0.05, MIN_DAYS = 4, SHIFT = 0.015;

const utc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const addDay = (d: string, n: number) => new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => (new Date(utc(d)).getUTCDay() + 6) % 7;
/** First day of the pay week a day falls in (Monday 0 ... Sunday 6). */
export const weekOf = (day: string, weekStart: number) => addDay(day, -((dow(day) - weekStart + 7) % 7));
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** Weekly points for rows that belong together (one queue, or the whole group). A week with fewer than MIN_DAYS days of data is left out: a part week says nothing. */
export function weeklyPoints(rows: DayRow[], weekStart: number): WeekPoint[] {
  const byWeek = new Map<string, DayRow[]>();
  for (const r of rows) byWeek.set(weekOf(r.day, weekStart), [...(byWeek.get(weekOf(r.day, weekStart)) ?? []), r]);
  const out: WeekPoint[] = [];
  for (const [wk, list] of [...byWeek].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const perDay = new Map<string, { a: number; f: number }>();
    for (const r of list) { const d = perDay.get(r.day) ?? { a: 0, f: 0 }; d.a += r.actual; d.f += r.forecast; perDay.set(r.day, d); }
    if (perDay.size < MIN_DAYS) continue;
    const actual = list.reduce((n, r) => n + r.actual, 0), forecast = list.reduce((n, r) => n + r.forecast, 0), abs15 = list.reduce((n, r) => n + r.absErr, 0);
    const dayAbs = [...perDay.values()].reduce((n, d) => n + Math.abs(d.f - d.a), 0), dayAct = [...perDay.values()].reduce((n, d) => n + d.a, 0);
    if (actual <= 0) continue;
    out.push({ weekStart: wk, days: perDay.size, actual: Math.round(actual), forecast: Math.round(forecast), wapeDaily: r3(dayAct ? dayAbs / dayAct : 0), wape15: r3(abs15 / actual), bias: r3((forecast - actual) / actual) });
  }
  return out;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function judge(weeks: WeekPoint[]): Pick<QueueTrend, 'latest' | 'direction' | 'status' | 'consistentBias' | 'message'> {
  const latest = weeks.at(-1) ?? null;
  if (!latest) return { latest: null, direction: 'STEADY', status: 'NO_DATA', consistentBias: null, message: 'No published forecast has been compared with actuals yet.' };
  const recent = weeks.slice(-3), before = weeks.slice(-6, -3);
  const direction: Direction = before.length >= 2 && mean(recent.map((w) => w.wapeDaily)) < mean(before.map((w) => w.wapeDaily)) - SHIFT ? 'IMPROVING'
    : before.length >= 2 && mean(recent.map((w) => w.wapeDaily)) > mean(before.map((w) => w.wapeDaily)) + SHIFT ? 'WORSENING' : 'STEADY';
  const recentAvg = mean(recent.map((w) => w.wapeDaily));
  const status = recentAvg >= POOR ? 'POOR' : recentAvg >= GOOD ? 'CHECK' : 'GOOD';
  const last3 = weeks.slice(-3);
  const consistentBias = last3.length === 3 && last3.every((w) => w.bias >= BIAS) ? 'HIGH' : last3.length === 3 && last3.every((w) => w.bias <= -BIAS) ? 'LOW' : null;
  const parts = [`Over the last ${recent.length} week${recent.length === 1 ? '' : 's'} the forecast missed by ${pct(recentAvg)} a day on average`];
  if (consistentBias === 'HIGH') parts.push(`and ran high for 3 weeks in a row (by ${pct(mean(last3.map((w) => w.bias)))}): it plans for more people than arrive`);
  if (consistentBias === 'LOW') parts.push(`and ran low for 3 weeks in a row (by ${pct(Math.abs(mean(last3.map((w) => w.bias))))}): it plans for fewer people than arrive`);
  const tail = direction === 'WORSENING' ? 'It is getting worse: check for a change in demand, a new campaign or a data problem.' : direction === 'IMPROVING' ? 'It is improving.' : '';
  return { latest, direction, status, consistentBias, message: `${parts.join(' ')}. ${tail}`.trim() };
}

export function trendOf(rows: DayRow[], weekStart: number, maxWeeks = 26): { total: QueueTrend; queues: QueueTrend[] } {
  const cut = (w: WeekPoint[]) => w.slice(-maxWeeks);
  const byQueue = new Map<string, DayRow[]>();
  for (const r of rows) byQueue.set(r.queueId, [...(byQueue.get(r.queueId) ?? []), r]);
  const queues = [...byQueue].map(([queueId, list]) => { const weeks = cut(weeklyPoints(list, weekStart)); return { queueId, name: list[0].name, weeks, ...judge(weeks) }; }).sort((a, b) => a.name.localeCompare(b.name));
  const tw = cut(weeklyPoints(rows, weekStart));
  return { total: { queueId: 'ALL', name: 'All queues', weeks: tw, ...judge(tw) }, queues };
}
