/**
 * Who is deciding a request, or who decided it, in plain words for the person who made it. No imports, so it is tested directly.
 * The same file is kept in the employee portal and the mobile app; a test checks they agree.
 */
export type Waiting = { level: 'SUPERVISOR' | 'MANAGER'; names: string[] } | null | undefined;
export interface Decidable {
  status: string; decidedBy?: string | null; decidedLevel?: 'SUPERVISOR' | 'MANAGER' | null; autoDecided?: boolean; autoApproved?: boolean; escalatedAt?: string | null; waitingFor?: Waiting;
}
const PENDING = new Set(['REQUESTED', 'PENDING_APPROVAL']);

/** The short label for a request that is waiting for a decision. */
export const waitingLabel = (w: Waiting): string => (w?.level === 'SUPERVISOR' ? 'Waiting for your supervisor' : 'Waiting for a manager');

/** The sentence under a request: who has it, or who decided it. Null when there is nothing to add. */
export function approvalLine(r: Decidable): string | null {
  if (PENDING.has(r.status)) {
    const w = r.waitingFor;
    const who = w?.level === 'SUPERVISOR' ? `your supervisor${w.names.length ? `, ${w.names.join(' or ')}` : ''}` : w?.level === 'MANAGER' ? 'a manager' : null;
    if (!who) return null;
    return `Waiting for ${who}.${r.escalatedAt ? ' It has waited longer than usual, so the managers have been told.' : ''}`;
  }
  if ((r.status === 'APPROVED' || r.status === 'REJECTED') && !(r.autoDecided || r.autoApproved) && (r.decidedBy || r.decidedLevel)) {
    const verb = r.status === 'APPROVED' ? 'Approved' : 'Declined';
    const by = r.decidedLevel === 'SUPERVISOR' ? 'your supervisor' : r.decidedLevel === 'MANAGER' ? 'a manager' : null;
    return `${verb} by ${by ? `${by}${r.decidedBy ? `, ${r.decidedBy}` : ''}` : r.decidedBy}.`;
  }
  return null;
}
