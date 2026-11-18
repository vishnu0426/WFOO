/**
 * Several published short-term forecasts can be live for one group at once, each for its own stretch of days. Publishing one replaces only a live forecast with the same horizon
 * (the same first and last day); everything else stays live. When two live forecasts cover the same day, the one published most recently wins. Pure rules, tested on their own.
 */
export interface LiveRow { id: string; seq: number; name: string; fromDay: string; toDay: string; publishedAt?: string | Date | null }

/** The most live forecasts one group may have at a time, so the lists stay readable. */
export const MAX_LIVE_PER_GROUP = 12;

export const sameHorizon = (a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }) => a.fromDay === b.fromDay && a.toDay === b.toDay;
export const overlaps = (a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }) => a.fromDay <= b.toDay && a.toDay >= b.fromDay;
/** Days both cover (inclusive); 0 when they do not meet. */
export function overlapDays(a: { fromDay: string; toDay: string }, b: { fromDay: string; toDay: string }): number {
  const from = a.fromDay > b.fromDay ? a.fromDay : b.fromDay, to = a.toDay < b.toDay ? a.toDay : b.toDay;
  return from > to ? 0 : Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
}

const when = (r: LiveRow) => (r.publishedAt ? new Date(r.publishedAt).getTime() : 0);
/** Newest published first; the version number breaks a tie. */
const newest = (a: LiveRow, b: LiveRow) => when(b) - when(a) || b.seq - a.seq;

/** What publishing `v` does among the forecasts already live for the group: which it replaces (same horizon), which stay live (and how many days they share with it). */
export function publishEffect(v: { id: string; fromDay: string; toDay: string }, live: LiveRow[]): { replaces: LiveRow[]; alsoLive: (LiveRow & { sharedDays: number })[]; tooMany: boolean } {
  const others = live.filter((l) => l.id !== v.id);
  const replaces = others.filter((l) => sameHorizon(l, v));
  const alsoLive = others.filter((l) => !sameHorizon(l, v)).map((l) => ({ ...l, sharedDays: overlapDays(l, v) }));
  return { replaces, alsoLive, tooMany: alsoLive.length + 1 > MAX_LIVE_PER_GROUP };
}

/** The live forecast to use for these days: one that covers them all (the newest), otherwise the one covering the most of them (the newest on a tie), otherwise the newest. */
export function pickForDays<T extends LiveRow>(live: T[], days: string[]): T | null {
  if (!live.length) return null;
  if (!days.length) return [...live].sort(newest)[0];
  const first = days[0], last = days[days.length - 1];
  const covers = (l: T) => days.filter((d) => l.fromDay <= d && d <= l.toDay).length;
  const all = live.filter((l) => l.fromDay <= first && l.toDay >= last);
  if (all.length) return [...all].sort(newest)[0];
  return [...live].sort((a, b) => covers(b) - covers(a) || newest(a, b))[0];
}
