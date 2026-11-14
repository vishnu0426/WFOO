/**
 * What the Forecasting screens are looking at: the date range, the interval and the queue. One selection shared by every Forecasting page (and kept between visits), so a person who
 * picked "Billing, next Tuesday" does not have to pick it again on each page. Pure functions only (no React, no browser), so the rules are tested on their own.
 */
export type Grain = '15' | '30' | '60' | 'day' | 'week' | 'month';
export type Range = 'Day' | 'Week' | 'Month' | 'Custom Range';
export type Kind = 'SHORT' | 'LONG';

export interface ViewState { range: Range; grain: Grain; start: string; end: string; queueId: string }
export interface VersionWindow { fromDay: string; toDay: string }

export const RANGES: Range[] = ['Day', 'Week', 'Month', 'Custom Range'];
export const GRAINS: { id: Grain; label: string }[] = [
  { id: '15', label: '15 min' }, { id: '30', label: '30 min' }, { id: '60', label: '60 min' }, { id: 'day', label: 'Daily' }, { id: 'week', label: 'Weekly' }, { id: 'month', label: 'Monthly' },
];
/** The interval each range opens with: time of day first for a day, an hour for a week, whole days for a month. */
export const DEFAULT_GRAIN: Record<Range, Grain> = { Day: '30', Week: '60', Month: 'day', 'Custom Range': '60' };
export const PER_BUCKET: Record<string, number> = { '15': 1, '30': 2, '60': 4 };   // 15-minute slots in one bucket

const addDays = (s: string, n: number) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const spanDays = (a: string, b: string) => Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 864e5) + 1;
const clamp = (d: string, w: VersionWindow) => (d < w.fromDay ? w.fromDay : d > w.toDay ? w.toDay : d);
export const covers = (w: VersionWindow, day: string) => day >= w.fromDay && day <= w.toDay;

/** A forecast opens on today when it covers today, otherwise on its first day. */
export function defaultView(w: VersionWindow, today: string): ViewState {
  return { range: 'Day', grain: DEFAULT_GRAIN.Day, start: covers(w, today) ? today : w.fromDay, end: w.toDay, queueId: '' };
}

/**
 * Bring a remembered selection onto the forecast now being looked at. The range and interval carry over; the dates carry over only if they still fall inside this forecast (otherwise
 * today when it is covered, else the first day); the queue carries over only if the group still has it.
 */
export function reconcileView(prev: ViewState | null, w: VersionWindow, queueIds: string[], today: string): ViewState {
  const d = defaultView(w, today);
  if (!prev) return d;
  const inside = (x: string) => !!x && x >= w.fromDay && x <= w.toDay;
  const start = inside(prev.start) ? prev.start : d.start;
  const end = inside(prev.end) && prev.end >= start ? prev.end : w.toDay;
  return { range: RANGES.includes(prev.range) ? prev.range : d.range, grain: GRAINS.some((g) => g.id === prev.grain) ? prev.grain : d.grain, start, end, queueId: prev.queueId && queueIds.includes(prev.queueId) ? prev.queueId : '' };
}

/** The days and interval actually asked of the server: clamped to the forecast, with the limits the gateway enforces (15-minute views span at most 14 days; a long-term forecast splits a day by time for at most 31). */
export function resolveWindow(v: ViewState, w: VersionWindow, kind: Kind): { from: string; to: string; grain: Grain } {
  const s = clamp(v.start || w.fromDay, w);
  let from = s, to = s;
  if (v.range === 'Week') to = clamp(addDays(s, 6), w);
  else if (v.range === 'Month') { from = w.fromDay; to = w.toDay; }
  else if (v.range === 'Custom Range') to = clamp(v.end < s ? s : v.end, w);
  const days = spanDays(from, to);
  let g: Grain = v.grain === '15' && days > 14 ? '60' : v.grain;
  if (kind === 'LONG' && PER_BUCKET[g] && days > 31) g = 'day';
  return { from, to, grain: g };
}

/** Changing the interval to days, weeks or months needs a range wide enough to hold more than one of them, or the chart would be a single point. */
export function rangeForGrain(range: Range, grain: Grain): Range {
  return (grain === 'day' || grain === 'week' || grain === 'month') && (range === 'Day' || (range === 'Week' && grain !== 'day')) ? 'Month' : range;
}

/** How many of the choices are not the ones a person would get by default (shown as a count on the "Advanced" button). */
export function advancedCount(v: ViewState, shownGrain: Grain): number {
  return (shownGrain !== DEFAULT_GRAIN[v.range] ? 1 : 0) + (v.queueId ? 1 : 0);
}

/** A series that never moves: every value within a hair of the mean (a chart of it is a straight line that says nothing a number does not). */
export function isFlat(values: (number | null | undefined)[], tolerance = 0.01): boolean {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length < 2) return false;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const room = Math.max(1, Math.abs(mean) * tolerance);
  return Math.max(...v) - Math.min(...v) <= room;
}

// ---------------------------------------------------------------- remembered between visits

export const VIEW_KEY = 'wfm_fc_view';
export interface StoredView extends ViewState { groupId: string }
export function readStoredView(raw: string | null): StoredView | null {
  if (!raw) return null;
  try {
    const x = JSON.parse(raw);
    if (!x || typeof x.groupId !== 'string' || !RANGES.includes(x.range) || !GRAINS.some((g) => g.id === x.grain)) return null;
    const day = /^\d{4}-\d{2}-\d{2}$/;
    return { groupId: x.groupId, range: x.range, grain: x.grain, start: day.test(x.start) ? x.start : '', end: day.test(x.end) ? x.end : '', queueId: typeof x.queueId === 'string' ? x.queueId : '' };
  } catch { return null; }
}
export const writeStoredView = (groupId: string, v: ViewState) => JSON.stringify({ groupId, ...v });
