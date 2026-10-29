/**
 * A planning forecast supplied as a file, for the days ahead: queue, date, interval, forecast volume, handle time. It becomes a forecast version
 * of its own (type Imported) that goes through the usual submit, approve and publish steps, and the schedule generator then uses it like any other.
 *
 * Not the same as importing history: history is what already happened and trains the forecast models. Pure logic here; the route lives in routes.ts.
 */
import type { StagedRecord } from '../csv.ts';

const SLOTS = 96;
/** Names a planning file may give its volume column. Only used by this import: the history importer must never accept them, or a forecast would be stored as what happened. */
export const PLAN_VOLUME_HEADERS = ['forecast_volume', 'forecasted_volume', 'forecast', 'planned_volume', 'planning_volume', 'predicted_volume', 'expected_volume', 'planned', 'plan'];

const norm = (h: string) => h.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** The file with its volume column renamed to `volume`, so the shared reader can read it. Null when the file already has a plain volume column or none of the planning names. */
export function withPlainVolumeHeader(matrix: string[][]): { matrix: string[][]; renamedFrom: string | null } {
  const header = matrix[0].map(norm);
  const plain = ['volume', 'offered', 'contacts', 'calls', 'received', 'presented'];
  if (header.some((h) => plain.includes(h))) return { matrix, renamedFrom: null };
  const at = header.findIndex((h) => PLAN_VOLUME_HEADERS.includes(h));
  if (at < 0) return { matrix, renamedFrom: null };
  const out = matrix.map((r) => r.slice());
  const from = out[0][at].trim();
  out[0][at] = 'volume';
  return { matrix: out, renamedFrom: from };
}

export interface PlanSummary {
  from: string; to: string; days: number; queues: { id: string; name: string }[]; intervals: number; totalVolume: number;
  byDay: { day: string; volume: number }[];
  /** Days before `today`: a plan for the past is almost certainly history sent to the wrong place. */
  pastDays: string[];
  /** Queue and day pairs that do not have all 96 quarter-hours, with how many they have. */
  gaps: { queue: string; day: string; have: number }[];
}

export function summarisePlan(records: StagedRecord[], queueNames: Map<string, string>, today: string): PlanSummary {
  const days = new Set<string>(), byDay = new Map<string, number>(), perQD = new Map<string, number>(), queues = new Set<string>();
  let total = 0;
  for (const r of records) {
    days.add(r.day); queues.add(r.queueId); total += r.volume;
    byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.volume);
    perQD.set(`${r.queueId}|${r.day}`, (perQD.get(`${r.queueId}|${r.day}`) ?? 0) + 1);
  }
  const sorted = [...days].sort();
  const gaps = [...perQD].filter(([, n]) => n !== SLOTS).map(([k, have]) => { const [q, day] = k.split('|'); return { queue: queueNames.get(q) ?? q, day, have }; }).sort((a, b) => (a.day < b.day ? -1 : 1));
  return {
    from: sorted[0] ?? '', to: sorted.at(-1) ?? '', days: sorted.length, queues: [...queues].map((id) => ({ id, name: queueNames.get(id) ?? id })), intervals: records.length, totalVolume: total,
    byDay: sorted.map((day) => ({ day, volume: byDay.get(day) ?? 0 })), pastDays: sorted.filter((d) => d < today), gaps,
  };
}

/** Rows for forecast_intervals: one per quarter-hour (slot 0 to 95) and one per queue and day (slot -1) with the day's volume and its volume-weighted handle time. No likely range: low and high equal the plan. */
export function planRows(records: StagedRecord[]): { queueId: string; day: string; slot: number; volume: number; aht: number }[] {
  const out: { queueId: string; day: string; slot: number; volume: number; aht: number }[] = [];
  const day = new Map<string, { queueId: string; day: string; volume: number; work: number }>();
  for (const r of records) {
    out.push({ queueId: r.queueId, day: r.day, slot: r.slot, volume: r.volume, aht: r.ahtSec });
    const k = `${r.queueId}|${r.day}`, c = day.get(k) ?? { queueId: r.queueId, day: r.day, volume: 0, work: 0 };
    c.volume += r.volume; c.work += r.volume * r.ahtSec; day.set(k, c);
  }
  for (const c of day.values()) out.push({ queueId: c.queueId, day: c.day, slot: -1, volume: c.volume, aht: c.volume > 0 ? Math.round(c.work / c.volume) : 0 });
  return out;
}
