/**
 * Rules behind the Staffing (capacity) page, with no React and no browser so they are tested on their own: how the people needed are built up from the workload (workload, then the
 * service-level buffer, then shrinkage), how that compares with who there is (over, short or about right), and the sentences that say so.
 */
export type GapState = 'OVER' | 'SHORT' | 'BALANCED';
export interface Gap { state: GapState; /** people there are minus people needed (positive: over) */ gapFte: number; /** the gap as a share of the need, in percent */ pct: number; label: string }

const r1 = (n: number) => Math.round(n * 10) / 10;
const whole = (n: number) => Math.round(Math.abs(n)).toLocaleString('en');
/** Within 5% of the need (and at least one person) counts as about right: a plan is never exact. */
export function gapOf(need: number, have: number): Gap {
  const gap = have - need, within = Math.max(1, need * 0.05);
  const pct = need > 0 ? (gap / need) * 100 : 0;
  if (Math.abs(gap) <= within) return { state: 'BALANCED', gapFte: r1(gap), pct: r1(pct), label: 'About right' };
  return gap > 0
    ? { state: 'OVER', gapFte: r1(gap), pct: r1(pct), label: `Over by ${whole(gap)} FTE` }
    : { state: 'SHORT', gapFte: r1(gap), pct: r1(pct), label: `Short by ${whole(gap)} FTE` };
}

export interface CapPeriod { days: number; workloadHours: number; agentHours: number; fte: number; peakFte: number }
export interface Step { id: 'workload' | 'erlang' | 'shrinkage' | 'need' | 'have' | 'gap'; label: string; /** where the bar starts and how tall it is, so a floating bar can be drawn */ base: number; value: number; tone: 'neutral' | 'add' | 'total' | 'have' | 'over' | 'short' | 'ok'; text: string }
export interface Build { workload: number; erlang: number; shrinkage: number; need: number; peak: number; have: number; gap: Gap; steps: Step[] }

/**
 * From the workload to the people needed, averaged over the whole period (weighted by days): the workload in people, plus the extra agents the service level needs on top of it
 * (the Erlang factor), plus what shrinkage takes away from paid time. Then the people there are, and the gap.
 */
export function buildUp(periods: CapPeriod[], o: { fteHoursWeek: number; factor: number; headcountFte: number }): Build | null {
  const days = periods.reduce((t, p) => t + p.days, 0);
  if (!periods.length || days <= 0 || o.fteHoursWeek <= 0) return null;
  const perPerson = o.fteHoursWeek * (days / 7);
  const workload = periods.reduce((t, p) => t + p.workloadHours, 0) / perPerson;
  const need = periods.reduce((t, p) => t + p.agentHours, 0) / perPerson;
  const erlang = Math.max(0, workload * (o.factor - 1));
  const shrinkage = Math.max(0, need - workload - erlang);
  const peak = Math.max(0, ...periods.map((p) => p.peakFte));
  const gap = gapOf(need, o.headcountFte);
  const lo = Math.min(need, o.headcountFte), hi = Math.max(need, o.headcountFte);
  const steps: Step[] = [
    { id: 'workload', label: 'Workload', base: 0, value: workload, tone: 'neutral', text: `${r1(workload)}` },
    { id: 'erlang', label: '+ Service-level buffer', base: workload, value: erlang, tone: 'add', text: `+${r1(erlang)}` },
    { id: 'shrinkage', label: '+ Shrinkage', base: workload + erlang, value: shrinkage, tone: 'add', text: `+${r1(shrinkage)}` },
    { id: 'need', label: 'People needed', base: 0, value: need, tone: 'total', text: `${r1(need)}` },
    { id: 'have', label: 'People you have', base: 0, value: o.headcountFte, tone: 'have', text: `${r1(o.headcountFte)}` },
    { id: 'gap', label: gap.state === 'OVER' ? 'Surplus' : gap.state === 'SHORT' ? 'Shortfall' : 'Gap', base: lo, value: hi - lo, tone: gap.state === 'OVER' ? 'over' : gap.state === 'SHORT' ? 'short' : 'ok', text: `${gap.gapFte > 0 ? '+' : gap.gapFte < 0 ? '−' : ''}${r1(Math.abs(gap.gapFte))}` },
  ];
  return { workload, erlang, shrinkage, need, peak, have: o.headcountFte, gap, steps };
}

/** One paragraph on the capacity position: over, short or about right, and, when the running schedule leaves intervals uncovered, that the problem is when people work, not how many. */
export function storySentence(o: { gap: Gap; need: number; haveFte: number; people: number; coveragePct: number | null }): string {
  if (o.people === 0 || o.haveFte <= 0) return 'No active people are assigned to this group yet, so the need cannot be set against anyone. Assign people to the group to see whether you are over or short.';
  const have = `${whole(o.haveFte)} FTE (${whole(o.people)} ${o.people === 1 ? 'person' : 'people'})`;
  const base = `You have ${have} against an average need of ${whole(o.need)}.`;
  const covered = o.coveragePct !== null && o.coveragePct < 95;
  if (o.gap.state === 'OVER') {
    return `${base} That is ${whole(o.gap.gapFte)} FTE more than needed (+${Math.round(o.gap.pct)}%).${covered ? ` Yet the running schedule covers only ${o.coveragePct}% of intervals: the people are there, but not at the right times, so look at the shift patterns before cutting or hiring.` : ''}`;
  }
  if (o.gap.state === 'SHORT') return `${base} That is ${whole(o.gap.gapFte)} FTE fewer than needed (−${Math.abs(Math.round(o.gap.pct))}%).${covered ? ` The running schedule covers ${o.coveragePct}% of intervals.` : ''} Hiring, overtime or a lower service-level goal would close it.`;
  return `${base} That is about right.${covered ? ` But the running schedule covers only ${o.coveragePct}% of intervals, so the shift patterns need a look.` : ''}`;
}

export interface ShrinkageSource { source: 'CATEGORIES' | 'FLAT'; effectivePct: number; flatPct: number; categories: { name: string; pct: number }[] }
/** Where the shrinkage percentage on the page comes from, so it can be checked against the group. */
export function shrinkageNote(s: ShrinkageSource): string {
  if (s.source === 'FLAT') return `${s.effectivePct}% from the group's shrinkage setting.`;
  const parts = s.categories.map((c) => `${c.name.toLowerCase()} ${c.pct}%`).join(' + ');
  return `${s.effectivePct}% from the group's shrinkage categories (${parts}).${s.flatPct !== s.effectivePct ? ` The flat ${s.flatPct}% setting is not used while categories exist.` : ''}`;
}

export interface PlanRow { needed: number; start: number; end: number; hires: number; attritionLoss: number }
/** The headcount plan in one line: a surplus is said out loud instead of reading as "0 hires needed, short-handed: none". */
export function planNote(rows: PlanRow[]): { tone: 'over' | 'short' | 'ok'; text: string } | null {
  if (!rows.length) return null;
  const total = rows.reduce((t, r) => t + r.hires, 0), first = rows[0], last = rows[rows.length - 1];
  if (total > 0) { const at = rows.findIndex((r) => r.hires > 0); return { tone: 'short', text: `Hire ${total} ${total === 1 ? 'person' : 'people'} over ${rows.length} ${rows.length === 1 ? 'month' : 'months'}, starting ${at === 0 ? 'in the first month' : `in month ${at + 1}`}.` }; }
  const startOver = first.start - first.needed, endOver = last.end - last.needed;
  if (startOver > 0) return { tone: 'over', text: `No hiring is needed. You start ${startOver} above the need${endOver > 0 ? ` and, after attrition, are still ${endOver} above it at the end` : ' and attrition brings you down to it by the end'}.` };
  return { tone: 'ok', text: 'No hiring is needed over this period.' };
}
