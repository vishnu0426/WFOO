import { tzFmt } from '../tzFormat.ts';
/**
 * Follow-the-sun arithmetic: several sites in different time zones, put on one clock (UTC). Where is the combined need not met, how is the day shared between sites,
 * and would sliding one site's whole roster earlier or later close the gaps? Pure functions, so they can be tested without a database.
 *
 * Series are keyed by absolute quarter-hour number (milliseconds since 1970 / 900000), so sites with different local days line up exactly.
 */
export interface GroupSeries { id: string; name: string; timezone: string; required: Map<number, number>; scheduled: Map<number, number> }

const SLOT_MS = 900_000;
export const slotOf = (d: Date) => Math.floor(d.getTime() / SLOT_MS);
export const isoOf = (slot: number) => new Date(slot * SLOT_MS).toISOString().slice(0, 16) + 'Z';

/** The absolute quarter-hour at which local midnight of `day` falls in `tz`. */
export function localMidnightSlot(day: string, tz: string): number {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const off = (t: number) => {
    const f = tzFmt('en-CA', tz, { hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const g = (k: string) => Number(f.find((x) => x.type === k)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;       // how far the local clock is ahead of UTC at instant t
  };
  let t = guess - off(guess);
  t = guess - off(t);                                                                                    // once more: the offset can differ either side of a clock change
  return Math.round(t / SLOT_MS);
}

export interface Gap { from: string; to: string; hours: number; worstShort: number; sites: string[] }
export interface Analysis {
  hourly: { utc: string; required: number; scheduled: number; short: number; byGroup: Record<string, number> }[];
  profile: { utcHour: number; required: number; scheduled: number; byGroup: Record<string, number> }[];
  gaps: Gap[];
  totals: { requiredHours: number; scheduledHours: number; shortHours: number; coveredPercent: number };
  suggestions: { groupId: string; name: string; currentShortHours: number; bestShiftHours: number; shortHoursAfter: number; improvementPercent: number }[];
}

const sum = (m: Map<number, number>, k: number) => m.get(k) ?? 0;

/** Total quarter-hours of shortage if group `i` is slid by `shift` quarter-hours (positive: later). Others stay put. */
function shortAfterShift(groups: GroupSeries[], i: number, shift: number, slots: number[]): number {
  let short = 0;
  for (const s of slots) {
    let req = 0, have = 0;
    groups.forEach((g, j) => { req += sum(g.required, s); have += j === i ? sum(g.scheduled, s - shift) : sum(g.scheduled, s); });
    if (have < req) short += req - have;
  }
  return short;
}

export function analyse(groups: GroupSeries[], opts: { maxShiftHours?: number } = {}): Analysis {
  const all = new Set<number>();
  for (const g of groups) { for (const k of g.required.keys()) all.add(k); for (const k of g.scheduled.keys()) all.add(k); }
  const slots = [...all].sort((a, b) => a - b);
  const byHour = new Map<number, { req: number; have: number; by: Record<string, number>; n: number }>();
  for (const s of slots) {
    const h = Math.floor(s / 4);
    const c = byHour.get(h) ?? { req: 0, have: 0, by: {}, n: 0 };
    c.n++;
    for (const g of groups) { c.req += sum(g.required, s); const v = sum(g.scheduled, s); c.have += v; c.by[g.id] = (c.by[g.id] ?? 0) + v; }
    byHour.set(h, c);
  }
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const hourly = [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, c]) => {
    const req = c.req / 4, have = c.have / 4;                                                          // people-hours in this hour -> average people on the hour
    return { utc: isoOf(h * 4), required: r2(req), scheduled: r2(have), short: r2(Math.max(0, req - have)), byGroup: Object.fromEntries(Object.entries(c.by).map(([k, v]) => [k, r2(v / 4)])) };
  });
  // the typical day on the one clock: the average over the days covered, for each UTC hour
  const prof = Array.from({ length: 24 }, () => ({ req: 0, have: 0, n: 0, by: {} as Record<string, number> }));
  for (const [h, c] of byHour) { const p = prof[((h % 24) + 24) % 24]; p.req += c.req / 4; p.have += c.have / 4; p.n++; for (const [k, v] of Object.entries(c.by)) p.by[k] = (p.by[k] ?? 0) + v / 4; }
  const profile = prof.map((p, utcHour) => ({ utcHour, required: r2(p.n ? p.req / p.n : 0), scheduled: r2(p.n ? p.have / p.n : 0), byGroup: Object.fromEntries(Object.entries(p.by).map(([k, v]) => [k, r2(p.n ? v / p.n : 0)])) }));
  // runs of hours where the combined need is not met
  const gaps: Gap[] = [];
  let cur: Gap | null = null;
  for (const h of hourly) {
    if (h.short > 0.25) {
      if (!cur) cur = { from: h.utc, to: h.utc, hours: 0, worstShort: 0, sites: [] };
      cur.to = h.utc; cur.hours++; cur.worstShort = Math.max(cur.worstShort, h.short);
    } else if (cur) { gaps.push(cur); cur = null; }
  }
  if (cur) gaps.push(cur);
  const needHours = hourly.reduce((n, h) => n + h.required, 0), shortHours = hourly.reduce((n, h) => n + h.short, 0);
  // would sliding a site's whole roster earlier or later close more of it? (a what-if: it ignores each person's own hours and availability)
  const maxShift = (opts.maxShiftHours ?? 4) * 4, suggestions = groups.map((g, i) => {
    const base = shortAfterShift(groups, i, 0, slots);
    let best = 0, bestShort = base;
    for (let sh = -maxShift; sh <= maxShift; sh += 4) { if (!sh) continue; const v = shortAfterShift(groups, i, sh, slots); if (v < bestShort - 1e-9) { bestShort = v; best = sh; } }
    return { groupId: g.id, name: g.name, currentShortHours: r2(base / 4), bestShiftHours: best / 4, shortHoursAfter: r2(bestShort / 4), improvementPercent: base ? Math.round(((base - bestShort) / base) * 1000) / 10 : 0 };
  });
  return { hourly, profile, gaps, totals: { requiredHours: r2(needHours), scheduledHours: r2(hourly.reduce((n, h) => n + h.scheduled, 0)), shortHours: r2(shortHours), coveredPercent: needHours ? r2((1 - shortHours / needHours) * 100) : 100 }, suggestions };
}
