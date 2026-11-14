/**
 * Rules behind the Forecast Builder form and the Adjustments page, with no React and no browser, so they are tested on their own: the data-check summary, the goals as sentences, which
 * section of a long form is in view, why Create is not available, a month calendar for events, and how a drag over a chart becomes a range.
 */

// ---------------------------------------------------------------- the data check

export type Severity = 'INFO' | 'WARNING' | 'CRITICAL';
/** BLOCK: a forecast cannot be built. CAUTION: go ahead, but it will be less accurate. TIP: optional housekeeping. */
export type Kind = 'BLOCK' | 'CAUTION' | 'TIP';
export interface FindingLike { severity: Severity; kind?: Kind; code?: string; title?: string; count?: number }
export const kindOf = (f: FindingLike): Kind => f.kind ?? (f.code === 'NO_HISTORY' ? 'BLOCK' : f.severity === 'INFO' ? 'TIP' : 'CAUTION');

export interface FindingSummary {
  /** things that need a look: blocking problems plus cautions (what the section badge counts; tips are not in it) */
  total: number; blocks: number; cautions: number; tips: number;
  bySeverity: Record<Severity, number>; worst: Severity | null; queuesWithFindings: number;
}
/** Findings across the queues, counted by kind so an optional tip never inflates the count or turns the box red. */
export function summarizeFindings(queues: { findings: FindingLike[] }[]): FindingSummary {
  const by: Record<Severity, number> = { INFO: 0, WARNING: 0, CRITICAL: 0 };
  let blocks = 0, cautions = 0, tips = 0, withAny = 0;
  for (const q of queues) {
    let attention = false;
    for (const f of q.findings) {
      by[f.severity]++;
      const k = kindOf(f);
      if (k === 'BLOCK') { blocks++; attention = true; } else if (k === 'CAUTION') { cautions++; attention = true; } else tips++;
    }
    if (attention) withAny++;
  }
  const worst: Severity | null = by.CRITICAL ? 'CRITICAL' : by.WARNING ? 'WARNING' : by.INFO ? 'INFO' : null;
  return { total: blocks + cautions, blocks, cautions, tips, bySeverity: by, worst, queuesWithFindings: withAny };
}
const n = (c: number, one: string, many: string) => `${c} ${c === 1 ? one : many}`;
/** "2 cautions · 1 tip", "1 blocking problem", or "Nothing to fix in the history". */
export const findingsText = (s: FindingSummary) => {
  const parts = [s.blocks && n(s.blocks, 'blocking problem', 'blocking problems'), s.cautions && n(s.cautions, 'caution', 'cautions'), s.tips && n(s.tips, 'tip', 'tips')].filter(Boolean) as string[];
  return parts.length ? parts.join(' · ') : 'Nothing to fix in the history';
};

export interface QueueCheck {
  name: string; days?: number; repairedDays?: number;
  findings: (FindingLike & { title?: string })[];
  length?: { level: 'GOOD' | 'OK' | 'LOW' | 'NONE'; days: number };
  freshness?: { level: 'CURRENT' | 'BEHIND' | 'OLD' | 'NONE'; daysBehind: number | null };
}
export interface Verdict { level: 'READY' | 'CAUTION' | 'BLOCKED'; label: string; text: string }
const lower = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t);
/** One plain sentence on whether the forecast can be created and what, if anything, will make it less accurate. Red only when it cannot be created. */
export function verdictFor(queues: QueueCheck[]): Verdict {
  const empty = queues.filter((q) => q.findings.some((f) => kindOf(f) === 'BLOCK'));
  const repaired = queues.reduce((t, q) => t + (q.repairedDays ?? 0), 0);
  const repair = repaired > 0 ? ` ${n(repaired, 'odd day', 'odd days')} will be repaired automatically.` : '';
  if (empty.length) return { level: 'BLOCKED', label: "Can't forecast yet", text: `${empty.map((q) => q.name).join(', ')} ${empty.length === 1 ? 'has' : 'have'} no history. Import it first.` };
  const issues: string[] = [];
  const many = queues.length > 1;
  for (const q of queues) for (const f of q.findings) if (kindOf(f) === 'CAUTION') issues.push(`${many ? `${q.name}: ` : ''}${lower(f.title ?? 'a data problem')}`);
  if (!issues.length) return { level: 'READY', label: 'Ready', text: `The history is fit to forecast from.${repair}` };
  const shown = issues.slice(0, 3).join('; ') + (issues.length > 3 ? ` and ${issues.length - 3} more` : '');
  return { level: 'CAUTION', label: issues.length === 1 ? 'Ready, with a caution' : 'Ready, with cautions', text: `You can create this forecast. ${issues.length === 1 ? 'One thing will make it less accurate' : 'These will make it less accurate'}: ${shown}.${repair}` };
}
/** "History length: good (56 days) · Freshness: 12 days behind": two facts, so one weak spot cannot hide that the rest is fine. */
export function statusLine(q: QueueCheck): string {
  const L = q.length ?? { level: 'NONE', days: q.days ?? 0 }, F = q.freshness ?? { level: 'NONE', daysBehind: null };
  const len = L.level === 'NONE' ? 'none' : `${L.level === 'GOOD' ? 'good' : L.level === 'OK' ? 'enough to start' : 'too short'} (${L.days} days)`;
  const fresh = F.level === 'NONE' || F.daysBehind === null ? 'no data' : F.level === 'CURRENT' ? 'current' : `${F.daysBehind} ${F.daysBehind === 1 ? 'day' : 'days'} behind`;
  return `History length: ${len} · Freshness: ${fresh}`;
}
/** What the footer says next to Create: nothing when all is well or only tips remain, otherwise that it can still be created. */
export function footerNote(s: FindingSummary): { text: string; tone: 'bad' | 'warn' } | null {
  if (s.blocks) return { text: `History check: ${n(s.blocks, 'blocking problem', 'blocking problems')}`, tone: 'bad' };
  if (s.cautions) return { text: `History check: ${n(s.cautions, 'caution', 'cautions')}. You can still create the forecast; it will be less accurate`, tone: 'warn' };
  return null;
}

// ---------------------------------------------------------------- goals as sentences

export const goalSentence = (percent: number, seconds: number) => `${percent}% answered within ${seconds} s`;
export const occupancySentence = (percent: number) => `Agents busy at most ${percent}% of their logged-in time`;
export const shrinkageSentence = (percent: number) => `${percent}% of paid time is lost to breaks, training and absence`;

// ---------------------------------------------------------------- which section is in view

export interface SectionPos { id: string; /** distance of the section's top from the top of the scrolling area (negative once it has scrolled past) */ top: number }
/** The section being read: the last one whose top has reached `offset` from the top, or the first when none has. */
export function activeSection(sections: SectionPos[], offset = 96): string | null {
  if (!sections.length) return null;
  let current = sections[0].id;
  for (const s of sections) if (s.top <= offset) current = s.id;
  return current;
}

// ---------------------------------------------------------------- why Create is not available

export function createBlockers(o: { canCreate: boolean; shortestHistoryDays: number; horizonProblem: string; busy: boolean }): string[] {
  const out: string[] = [];
  if (!o.canCreate) out.push('You do not have permission to create forecasts.');
  if (o.shortestHistoryDays === 0) out.push('This group has no interval history yet: import it first.');
  if (o.horizonProblem) out.push(o.horizonProblem);
  return out;
}

// ---------------------------------------------------------------- a month of events

const utc = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);
export const addIsoDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

/** The weeks (Monday first) that cover a month, as arrays of seven dates. `month` is 0 to 11. */
export function monthWeeks(year: number, month: number): string[][] {
  const first = iso(new Date(Date.UTC(year, month, 1))), lead = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate(), total = Math.ceil((lead + days) / 7) * 7, start = addIsoDays(first, -lead);
  return Array.from({ length: total / 7 }, (_, w) => Array.from({ length: 7 }, (_, d) => addIsoDays(start, w * 7 + d)));
}

export interface EventSpan { id: string; name: string; kind: string; startDay: string; endDay: string; upliftPct: number; leadDays: number; lagDays: number }
/** The events that touch a day: "on" the day itself, or in the ramp before or after (shown lighter). */
export function eventsOnDay(events: EventSpan[], day: string): { event: EventSpan; phase: 'on' | 'ramp-in' | 'ramp-out' }[] {
  const out: { event: EventSpan; phase: 'on' | 'ramp-in' | 'ramp-out' }[] = [];
  for (const e of events) {
    if (day >= e.startDay && day <= e.endDay) out.push({ event: e, phase: 'on' });
    else if (e.leadDays > 0 && day < e.startDay && day >= addIsoDays(e.startDay, -e.leadDays)) out.push({ event: e, phase: 'ramp-in' });
    else if (e.lagDays > 0 && day > e.endDay && day <= addIsoDays(e.endDay, e.lagDays)) out.push({ event: e, phase: 'ramp-out' });
  }
  return out;
}

/** Clicking days to pick a range: the first click is both ends, a later click on or after it sets the end, an earlier one moves the start; a click when a range is already set starts over. */
export function pickRange(cur: { start: string; end: string } | null, day: string): { start: string; end: string } {
  if (!cur || cur.start !== cur.end) return { start: day, end: day };
  return day >= cur.start ? { start: cur.start, end: day } : { start: day, end: cur.end };
}

// ---------------------------------------------------------------- dragging over a chart

/** The two ends of a drag over a chart, in either direction, as the first and last point it covers (inclusive, clamped to the chart). */
export function dragSpan(a: number, b: number, length: number): { first: number; last: number } | null {
  if (length <= 0 || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(length - 1, Math.max(a, b));
  return lo > hi ? null : { first: lo, last: hi };
}

/** "08:00" from a quarter-hour slot, and back. */
export const slotTime = (slot: number) => `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;
export const timeSlot = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 4 + Math.floor(m / 15); };

export type AdjustMode = 'pct' | 'add' | 'total' | 'zero' | 'reset';
/** What an adjustment will do, as a sentence, before it is applied. */
export function adjustmentSentence(o: { mode: AdjustMode; value: number; from: string; to: string; short: boolean; tFrom: string; tTo: string; queue: string }): string {
  const when = o.from === o.to ? o.from : `${o.from} to ${o.to}`;
  const times = o.short ? ` between ${o.tFrom} and ${o.tTo}` : '';
  const where = ` for ${o.queue || 'all queues'}`;
  const n = (v: number) => Math.abs(v).toLocaleString('en', { maximumFractionDigits: 2 });
  if (o.mode === 'pct') return `${o.value >= 0 ? 'Increase' : 'Decrease'} the forecast by ${n(o.value)}% on ${when}${times}${where}.`;
  if (o.mode === 'add') return `${o.value >= 0 ? 'Add' : 'Remove'} ${n(o.value)} contacts on ${when}${times}${where}, shared across the intervals by their usual weight.`;
  if (o.mode === 'total') return `Set the total to ${n(o.value)} contacts on ${when}${times}${where}, keeping the usual shape of the day.`;
  if (o.mode === 'zero') return `Expect no contacts on ${when}${times}${where} (the queue is closed).`;
  return `Take off the adjustments on ${when}${times}${where} and go back to the model's own numbers.`;
}
