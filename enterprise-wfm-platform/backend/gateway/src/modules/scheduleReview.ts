/**
 * The rules of schedule review and change impact, kept free of the database so they can be tested on their own (see scheduleApproval.ts for the routes that use them).
 */
import { wallToUtcMs } from './clockChange.ts';

const hhmm = (slot: number) => `${String(Math.floor(slot / 4) % 24).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;

export interface Approval { state: 'NONE' | 'SUBMITTED' | 'APPROVED'; changedSince: boolean; submittedBy: string | null; submittedAt: string | null; approvedBy: string | null; approvedAt: string | null; note: string | null }

/** Where a draft stands in review. A review given for an older revision no longer counts (`changedSince` says the schedule was edited after it). */
export function approvalOf(v: any): Approval {
  const stored = (v.approvalState ?? 'NONE') as Approval['state'];
  const current = stored === 'SUBMITTED' ? v.submittedRev === v.rev : stored === 'APPROVED' ? v.approvedRev === v.rev : true;
  return {
    state: v.status === 'DRAFT' && current ? stored : 'NONE', changedSince: v.status === 'DRAFT' && stored !== 'NONE' && !current,
    submittedBy: v.submittedBy ?? null, submittedAt: v.submittedAt ?? null, approvedBy: v.approvedBy ?? null, approvedAt: v.approvedAt ?? null, note: v.reviewNote ?? null,
  };
}

/** Why this draft cannot be published for want of approval, or null when it can (approval is not required, or it has been approved in its present form). */
export function approvalProblem(v: any, required: boolean): string | null {
  if (!required) return null;
  const a = approvalOf(v);
  if (a.state === 'APPROVED') return null;
  return a.changedSince
    ? 'This schedule was changed after it was reviewed. Submit it for approval again before publishing.'
    : a.state === 'SUBMITTED' ? 'This schedule is waiting for approval. An approver must approve it before it can be published.' : 'Publishing needs approval first. Submit this schedule for approval.';
}

export interface Change { day: string; kind: 'ADDED' | 'REMOVED' | 'CHANGED'; from: { start: string; end: string } | null; to: { start: string; end: string } | null; shortNotice: boolean }
export interface PersonImpact { employeeId: string; name: string; added: number; removed: number; changed: number; hoursDelta: number; shortNotice: number; changes: Change[] }
export type ShiftRow = { employeeId: string; day: string; startSlot: number; lengthSlots: number };
type Row = ShiftRow;
const span = (r: Row) => ({ start: hhmm(r.startSlot), end: hhmm(r.startSlot + r.lengthSlots) });

/** Pure comparison of two sets of shifts (one shift per person per day), from `today` on: the days already over are locked and never part of an impact. */
export function diffShifts(before: Row[], after: Row[], today: string, noticeHours: number, tz: string, now = Date.now()): { people: Map<string, Omit<PersonImpact, 'name'>>; unchanged: number } {
  const key = (r: Row) => `${r.employeeId}|${r.day}`;
  const old = new Map(before.filter((r) => r.day >= today).map((r) => [key(r), r])), neu = new Map(after.filter((r) => r.day >= today).map((r) => [key(r), r]));
  const people = new Map<string, Omit<PersonImpact, 'name'>>();
  let unchanged = 0;
  const of = (id: string) => { let x = people.get(id); if (!x) { x = { employeeId: id, added: 0, removed: 0, changed: 0, hoursDelta: 0, shortNotice: 0, changes: [] }; people.set(id, x); } return x; };
  // a change is short notice when the earliest of the old and the new start comes before the notice period ends
  const late = (day: string, ...starts: number[]) => wallToUtcMs(day, Math.min(...starts) * 15, tz) < now + noticeHours * 3_600_000;
  for (const [k, a] of neu) {
    const b = old.get(k);
    if (!b) { const x = of(a.employeeId), s = late(a.day, a.startSlot); x.added++; x.hoursDelta += a.lengthSlots / 4; if (s) x.shortNotice++; x.changes.push({ day: a.day, kind: 'ADDED', from: null, to: span(a), shortNotice: s }); }
    else if (a.startSlot !== b.startSlot || a.lengthSlots !== b.lengthSlots) { const x = of(a.employeeId), s = late(a.day, a.startSlot, b.startSlot); x.changed++; x.hoursDelta += (a.lengthSlots - b.lengthSlots) / 4; if (s) x.shortNotice++; x.changes.push({ day: a.day, kind: 'CHANGED', from: span(b), to: span(a), shortNotice: s }); }
    else unchanged++;
  }
  for (const [k, b] of old) if (!neu.has(k)) { const x = of(b.employeeId), s = late(b.day, b.startSlot); x.removed++; x.hoursDelta -= b.lengthSlots / 4; if (s) x.shortNotice++; x.changes.push({ day: b.day, kind: 'REMOVED', from: span(b), to: null, shortNotice: s }); }
  for (const x of people.values()) { x.changes.sort((p, q) => p.day.localeCompare(q.day)); x.hoursDelta = Math.round(x.hoursDelta * 10) / 10; }
  return { people, unchanged };
}

