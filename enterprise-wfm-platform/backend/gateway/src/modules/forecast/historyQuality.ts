/**
 * Is a queue's history fit to forecast from? Looks for what makes a forecast wrong before it is made: too little history, days with no data
 * in the middle of it, days that are cut short or far below the usual, spikes, and a share of abandoned callers that suggests the volume
 * leaves them out. The forecast already repairs odd days by replacing them with the same-weekday baseline; this says how many it will repair
 * and why, so the planner can fix the data instead.
 */
export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface DayRow { day: string; intervals: number; volume: number; abandoned: number; ahtOutliers: number }
export interface QueueInput { id: string; name: string; openSlot: number; closeSlot: number; volumeBasis: 'OFFERED' | 'ANSWERED'; rows: DayRow[] }
export interface Finding { code: string; severity: Severity; message: string; days?: string[]; count?: number }
export interface QueueQuality {
  queueId: string; name: string; status: 'GOOD' | 'CHECK' | 'POOR'; firstDay: string | null; lastDay: string | null; days: number;
  abandonRatePct: number | null; volumeBasis: 'OFFERED' | 'ANSWERED'; repairedDays: number; findings: Finding[];
}

const utc = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
const addDay = (d: string, n: number) => new Date(utc(d) + n * 86_400_000).toISOString().slice(0, 10);
const dow = (d: string) => (new Date(utc(d)).getUTCDay() + 6) % 7;
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const list = (days: string[], n = 6) => (days.length <= n ? days.join(', ') : `${days.slice(0, n).join(', ')} and ${days.length - n} more`);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export const LOW = 0.25, HIGH = 3;            // a day under a quarter, or over three times, the usual for its weekday

export function analyseQueue(q: QueueInput, today: string): QueueQuality {
  const out: Finding[] = [];
  const rows = [...q.rows].sort((a, b) => (a.day < b.day ? -1 : 1));
  const base: QueueQuality = { queueId: q.id, name: q.name, status: 'GOOD', firstDay: rows[0]?.day ?? null, lastDay: rows.at(-1)?.day ?? null, days: rows.length, abandonRatePct: null, volumeBasis: q.volumeBasis, repairedDays: 0, findings: out };
  if (!rows.length) {
    out.push({ code: 'NO_HISTORY', severity: 'CRITICAL', message: 'There is no interval history for this queue, so a forecast cannot be built. Import it under Data Management.' });
    base.status = 'POOR';
    return base;
  }

  const first = rows[0].day, last = rows.at(-1)!.day, span = Math.round((utc(last) - utc(first)) / 86_400_000) + 1;
  if (span < 28) out.push({ code: 'SHORT', severity: 'CRITICAL', count: span, message: `Only ${span} days of history. At least 4 weeks are needed to learn the weekly pattern, and 8 or more give a steadier forecast.` });
  else if (span < 56) out.push({ code: 'SHORT', severity: 'WARNING', count: span, message: `${span} days of history. It is enough to start, but 8 weeks or more give a steadier weekly pattern, and a year is needed to learn seasons.` });

  const staleDays = Math.round((utc(today) - utc(last)) / 86_400_000);
  if (staleDays > 2) out.push({ code: 'STALE', severity: staleDays > 7 ? 'CRITICAL' : 'WARNING', count: staleDays, message: `The newest data is ${staleDays} days old (${last}). A forecast starts from the last full day, so it will be less sharp.` });

  const have = new Set(rows.map((r) => r.day));
  const missing: string[] = [];
  for (let d = first; d <= last; d = addDay(d, 1)) if (!have.has(d)) missing.push(d);
  if (missing.length) out.push({ code: 'MISSING_DAYS', severity: missing.length > span * 0.1 ? 'CRITICAL' : 'WARNING', days: missing, count: missing.length, message: `${missing.length} ${plural(missing.length, 'day', 'days')} with no data inside the history (${list(missing)}). If the queue was open, this is an outage in the feed; the forecast fills these from the same weekday.` });

  const need = Math.max(1, q.closeSlot - q.openSlot);
  const partial = rows.filter((r) => r.intervals > 0 && r.intervals < need * 0.9).map((r) => r.day);
  if (partial.length) out.push({ code: 'PARTIAL_DAYS', severity: partial.length > 3 ? 'WARNING' : 'INFO', days: partial, count: partial.length, message: `${partial.length} ${plural(partial.length, 'day is', 'days are')} missing intervals (${list(partial)}): fewer than 90% of the ${need} intervals the queue is open. Those days under-count demand.` });

  // a day far from the usual for its weekday: a feed outage (low) or an event (high)
  const byDow = new Map<number, number[]>();
  for (const r of rows) byDow.set(dow(r.day), [...(byDow.get(dow(r.day)) ?? []), r.volume]);
  const low: string[] = [], high: string[] = [];
  for (const r of rows) {
    const peers = byDow.get(dow(r.day))!;
    if (peers.length < 4) continue;
    const m = median(peers);
    if (m <= 0) continue;
    if (r.volume < m * LOW) low.push(r.day); else if (r.volume > m * HIGH) high.push(r.day);
  }
  if (low.length) out.push({ code: 'LOW_DAYS', severity: low.length > 3 ? 'WARNING' : 'INFO', days: low, count: low.length, message: `${low.length} ${plural(low.length, 'day', 'days')} far below the usual for that weekday (${list(low)}). A closure or a recording gap? If real demand was normal, the forecast treats them as outliers and replaces them.` });
  if (high.length) out.push({ code: 'SPIKE_DAYS', severity: 'INFO', days: high, count: high.length, message: `${high.length} ${plural(high.length, 'day', 'days')} far above the usual (${list(high)}). If a campaign or an outage caused them, add a special event so the forecast learns them; otherwise they are replaced as outliers.` });

  const vol = rows.reduce((n, r) => n + r.volume, 0), ab = rows.reduce((n, r) => n + r.abandoned, 0);
  if (vol > 0) {
    const rate = Math.round((ab / (vol + (q.volumeBasis === 'ANSWERED' ? ab : 0))) * 1000) / 10;
    base.abandonRatePct = rate;
    if (q.volumeBasis === 'OFFERED' && rate >= 5) out.push({ code: 'ABANDON_BASIS', severity: 'INFO', count: rate, message: `${rate}% of callers abandoned. If the volume column counts only the calls agents answered, the forecast under-plans by about that much: set this queue to "answered calls only" so the abandoned callers are added back.` });
    if (q.volumeBasis === 'ANSWERED' && ab === 0) out.push({ code: 'ABANDON_MISSING', severity: 'WARNING', message: 'This queue is set to "answered calls only" but the history has no abandoned counts, so nothing can be added back. Import the abandoned column too.' });
  }
  const odd = rows.reduce((n, r) => n + r.ahtOutliers, 0);
  if (odd > 0) out.push({ code: 'AHT_ODD', severity: 'INFO', count: odd, message: `${odd} ${plural(odd, 'interval has', 'intervals have')} a handle time more than five times the queue's usual (looking at the last 120 days). The staffing needed in those intervals may be wrong.` });

  base.repairedDays = new Set([...missing, ...low, ...high]).size;
  const has = (s: Severity) => out.some((f) => f.severity === s);
  base.status = has('CRITICAL') ? 'POOR' : has('WARNING') ? 'CHECK' : 'GOOD';
  const rank = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return base;
}
