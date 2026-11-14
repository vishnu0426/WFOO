/**
 * What approving a leave request does to the team's cover, as plain arithmetic with no database: given what the group needs in each quarter hour, who is scheduled, and which of those
 * hours belong to the person asking, how covered is each day with them and without them, where is the worst stretch, and does the request pass the rules for a one-click approval.
 *
 * "Coverage" is the share of needed agent-hours that are staffed: sum of min(staffed, needed) over the day's quarter hours, divided by the sum of needed. Hours nobody needs do not
 * count for or against (an overstaffed slot cannot make up for a short one).
 */
export const SPD = 96;

export interface DayInput {
  day: string;
  /** What the group needs in each of the day's 96 quarter hours; null when there is no forecast or coverage template for the day. */
  required: number[] | null;
  /** Everyone else who is scheduled and not away, per quarter hour (the person asking is not in it). */
  others: number[];
  /** The part of the schedule that is this person's, per quarter hour. All zero when they are not scheduled that day. */
  mine: number[];
  /** A schedule has been published for the group on this day. Without one nobody is rostered, so "cover" would read 0% for a reason that has nothing to do with the leave. */
  published: boolean;
}

export interface Block { startSlot: number; endSlot: number; percent: number; short: number }

export interface DayImpact {
  day: string;
  /** The person is on the schedule this day, so approving takes them off it. */
  scheduled: boolean;
  /** A schedule is published for the group on this day. */
  published: boolean;
  /** Whether the day could be judged: there is a requirement for it and a published schedule to compare it with. */
  judged: boolean;
  /** Coverage with and without the person, whole percent; null when the day has no requirement. */
  beforePercent: number | null;
  afterPercent: number | null;
  /** The worst stretch that becomes short once the person is off. null when none does. */
  worst: Block | null;
}

const pct = (num: number, den: number) => den <= 0 ? null : Math.round((num / den) * 100);

export const clock = (slot: number) => `${String(Math.floor((slot * 15) / 60) % 24).padStart(2, '0')}:${String((slot * 15) % 60).padStart(2, '0')}`;

/** Share of the needed hours that are staffed, as a whole percent; null when nothing is needed. */
export function coveragePercent(required: number[], staffed: number[]): number | null {
  let need = 0, got = 0;
  for (let i = 0; i < required.length; i++) { need += required[i]; got += Math.min(required[i], staffed[i] ?? 0); }
  return pct(got, need);
}

/**
 * The stretches where the person's own hours matter and the team is short without them. A stretch is a run of quarter hours in which they are scheduled and the others alone do
 * not meet the need. Its percent is the others' cover over the need across the run (so "82%" reads as "the team would have 82% of what it needs").
 */
export function shortBlocks(required: number[], others: number[], mine: number[]): Block[] {
  const out: Block[] = [];
  let start = -1;
  const close = (end: number) => {
    let need = 0, got = 0, short = 0;
    for (let i = start; i < end; i++) { need += required[i]; got += Math.min(required[i], others[i]); short = Math.max(short, required[i] - others[i]); }
    out.push({ startSlot: start, endSlot: end, percent: pct(got, need) ?? 100, short });
    start = -1;
  };
  for (let i = 0; i < required.length; i++) {
    const matters = mine[i] > 0 && others[i] < required[i];
    if (matters && start < 0) start = i;
    else if (!matters && start >= 0) close(i);
  }
  if (start >= 0) close(required.length);
  return out;
}

export function dayImpact(d: DayInput): DayImpact {
  const scheduled = d.mine.some((v) => v > 0);
  if (!d.required || !d.published) return { day: d.day, scheduled, published: d.published, judged: false, beforePercent: null, afterPercent: null, worst: null };
  const withHim = d.others.map((v, i) => v + (d.mine[i] ?? 0));
  const blocks = shortBlocks(d.required, d.others, d.mine);
  // the worst stretch is the one with the lowest coverage; of equal ones, the longer
  const worst = blocks.length ? [...blocks].sort((a, b) => a.percent - b.percent || (b.endSlot - b.startSlot) - (a.endSlot - a.startSlot) || a.startSlot - b.startSlot)[0] : null;
  return { day: d.day, scheduled, published: true, judged: true, beforePercent: coveragePercent(d.required, withHim), afterPercent: coveragePercent(d.required, d.others), worst };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const dayName = (day: string) => DAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()];

/** "Approving leaves Tue 10:00–12:00 at 82% coverage", or the reason there is nothing to say. */
export function headline(days: DayImpact[], target: number): { text: string; tone: 'good' | 'warn' | 'bad' | 'unknown' } {
  const worked = days.filter((d) => d.scheduled);
  if (!worked.length) return { text: days.every((d) => !d.published) ? 'No schedule is published for these days yet, so approving takes nothing off one; the leave will be planned around when it is.' : 'They are not scheduled on any of these days, so approving takes nothing off the schedule.', tone: 'good' };
  const unjudged = worked.filter((d) => !d.judged);
  const judged = worked.filter((d) => d.judged);
  const hit = judged.filter((d) => d.worst).sort((a, b) => a.worst!.percent - b.worst!.percent)[0];
  if (hit) {
    const w = hit.worst!;
    const tone = (hit.afterPercent ?? 100) < target ? 'bad' : 'warn';
    return { text: `Approving leaves ${dayName(hit.day)} ${hit.day.slice(5)} ${clock(w.startSlot)}–${clock(w.endSlot)} at ${w.percent}% coverage.`, tone };
  }
  if (unjudged.length) return { text: `There is no forecast or coverage template for ${unjudged.length === 1 ? unjudged[0].day : `${unjudged.length} of these days`}, so the effect on cover cannot be shown.`, tone: 'unknown' };
  return { text: 'The team stays fully covered on every day they would miss.', tone: 'good' };
}

export interface PassInput {
  /** Rule blockers and reasons from the time-off rules (blackout dates, daily caps). */
  blockers: string[]; reasons: string[];
  /** Days left of the person's balance for this type after the request; null when the type has no entitlement set. */
  balanceAfter: number | null;
  /** The first day on which too many colleagues would be off, if any. */
  capBreach: { day: string; off: number; cap: number } | null;
  days: DayImpact[];
  target: number;
  status: string;
}

/**
 * Can this request be approved without a manager looking at it twice? Every one of these must hold; the list of what did not is returned so the screen can say why a request is
 * left out of a bulk approval. A day the person works but that could not be judged does not pass: not knowing is not the same as being safe.
 */
export function passes(i: PassInput): { ok: boolean; why: string[] } {
  const why: string[] = [];
  if (i.status !== 'REQUESTED') why.push(i.status === 'APPROVED' ? 'Already approved.' : 'No longer waiting.');
  why.push(...i.blockers, ...i.reasons);
  if (i.balanceAfter !== null && i.balanceAfter < 0) why.push(`It uses ${Math.abs(Math.round(i.balanceAfter * 100) / 100)} more day${Math.abs(i.balanceAfter) === 1 ? '' : 's'} than they have left.`);
  if (i.capBreach) why.push(`Too many colleagues would be off on ${i.capBreach.day} (${i.capBreach.off} of at most ${i.capBreach.cap}).`);
  for (const d of i.days) {
    if (!d.scheduled) continue;
    if (!d.judged) { why.push(`${d.day}: cover cannot be judged (no forecast or coverage template).`); continue; }
    if ((d.afterPercent ?? 100) < i.target) why.push(`${dayName(d.day)} ${d.day.slice(5)}: cover would fall to ${d.afterPercent}% (target ${i.target}%).`);
  }
  return { ok: why.length === 0, why };
}
