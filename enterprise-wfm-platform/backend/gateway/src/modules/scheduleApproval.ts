/**
 * Schedule approval and change impact.
 *
 * Approval: a draft is submitted for review, then approved or sent back with a reason. When the organisation requires approval (scheduling policy), only an approved draft
 * can be published, and the person who submitted it cannot approve it when the organisation uses the four-eyes rule. A review belongs to one revision of the schedule: if the
 * draft is edited after it was submitted or approved it is no longer the schedule that was reviewed, and it goes back to needing review.
 *
 * Impact: what publishing a schedule changes for each person against the schedule that is live now, so the planner sees who is affected (and how late) before publishing,
 * and the people affected, and only those, are told what changed.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, requiresAny } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, notFound, parse } from '../http.ts';
import { publish } from '../infra.ts';
import { notify, usersOf } from '../notify.ts';
import { loadPolicy } from './policyRoutes.ts';
import { hhmm } from './workforceRoutes.ts';
import { todayIn } from './forecast/service.ts';
import { approvalOf, approvalProblem, diffShifts, type Change, type PersonImpact, type ShiftRow } from './scheduleReview.ts';

export { approvalOf, diffShifts } from './scheduleReview.ts';

/** Throws when the organisation requires approval and this draft has not been approved (in its present form). */
export function requireApproved(v: any, required: boolean): void {
  const why = approvalProblem(v, required);
  if (why) throw new HttpError(409, 'APPROVAL_REQUIRED', why);
}
export type { Approval, Change, PersonImpact } from './scheduleReview.ts';

export const scheduleApprovalRoutes = Router();
const uuid = z.string().uuid();

/** The login accounts whose role is allowed to approve schedules. */
async function approvers(tx: Tx): Promise<string[]> {
  return (await tx.q<{ id: string }>(`SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN (SELECT role FROM role_permissions WHERE tenant_id = :t AND permission = 'schedule:approve')`)).map((r) => r.id);
}

async function loadDraft(tx: Tx, id: string): Promise<any> {
  const v = await tx.one<any>('SELECT *, period_start::text AS period_start, period_end::text AS period_end FROM schedule_versions WHERE tenant_id = :t AND id = $1 FOR UPDATE', [id]);
  if (!v) throw notFound('Schedule version');
  if (v.status !== 'DRAFT') throw conflict(`Only a draft goes through approval (this one is ${v.status.toLowerCase()}).`);
  return v;
}

const dto = (v: any) => ({ id: v.id, name: v.name, approval: approvalOf(v) });

scheduleApprovalRoutes.post('/versions/:id/submit', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), note = String(req.body?.note ?? '').trim().slice(0, 500);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadDraft(tx, id);
    await tx.exec(`UPDATE schedule_versions SET approval_state = 'SUBMITTED', submitted_by = $2, submitted_by_id = $3, submitted_at = now(), submitted_rev = rev, approved_by = NULL, approved_by_id = NULL, approved_at = NULL, approved_rev = NULL, review_note = $4 WHERE tenant_id = :t AND id = $1`, [id, p.name, p.userId, note || null]);
    await audit(tx, p, req, { action: 'SUBMIT', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason: note || undefined, after: { approval: 'SUBMITTED', rev: v.rev } });
    await notify(tx, (await approvers(tx)).filter((u) => u !== p.userId), { kind: 'INFO', title: 'A schedule is waiting for your approval', body: `${p.name} submitted "${v.name}" (${v.periodStart ?? ''}).${note ? ` Note: ${note}` : ''}`, data: { screen: 'schedule', versionId: id } });
    return tx.one<any>('SELECT * FROM schedule_versions WHERE tenant_id = :t AND id = $1', [id]);
  });
  publish(p.tenantId, ['schedule', 'submit'], { id, name: out.name, by: p.name });
  res.json(dto(out));
});

scheduleApprovalRoutes.post('/versions/:id/approve', requires('schedule:approve'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), note = String(req.body?.note ?? '').trim().slice(0, 500);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadDraft(tx, id);
    const a = approvalOf(v);
    if (a.state !== 'SUBMITTED') throw conflict(a.changedSince ? 'This schedule was changed after it was submitted. It has to be submitted again before it can be approved.' : 'Only a schedule that was submitted can be approved.');
    const t = await tx.one<{ fourEyes: boolean }>('SELECT four_eyes FROM tenants WHERE id = :t');
    if (t?.fourEyes && v.submittedById === p.userId) throw new HttpError(403, 'FOUR_EYES', 'Four-eyes rule: the person who submitted a schedule cannot approve it.');
    await tx.exec(`UPDATE schedule_versions SET approval_state = 'APPROVED', approved_by = $2, approved_by_id = $3, approved_at = now(), approved_rev = rev, review_note = coalesce($4, review_note) WHERE tenant_id = :t AND id = $1`, [id, p.name, p.userId, note || null]);
    await audit(tx, p, req, { action: 'APPROVE', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason: note || undefined, before: { approval: 'SUBMITTED' }, after: { approval: 'APPROVED', rev: v.rev } });
    if (v.submittedById) await notify(tx, [v.submittedById], { kind: 'INFO', title: 'Your schedule was approved', body: `"${v.name}" was approved by ${p.name}. It can be published now.`, data: { screen: 'schedule', versionId: id } });
    return tx.one<any>('SELECT * FROM schedule_versions WHERE tenant_id = :t AND id = $1', [id]);
  });
  publish(p.tenantId, ['schedule', 'approve'], { id, name: out.name, by: p.name });
  res.json(dto(out));
});

scheduleApprovalRoutes.post('/versions/:id/reject', requiresAny('schedule:approve', 'schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), reason = String(req.body?.reason ?? '').trim();
  if (reason.length < 3) throw bad('A reason is required');
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadDraft(tx, id);
    if (approvalOf(v).state === 'NONE' && !approvalOf(v).changedSince) throw conflict('This schedule is not under review.');
    await tx.exec(`UPDATE schedule_versions SET approval_state = 'NONE', approved_by = NULL, approved_by_id = NULL, approved_at = NULL, approved_rev = NULL, review_note = $2 WHERE tenant_id = :t AND id = $1`, [id, reason]);
    await audit(tx, p, req, { action: 'REJECT', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v.name, reason, before: { approval: v.approvalState }, after: { approval: 'NONE' } });
    if (v.submittedById && v.submittedById !== p.userId) await notify(tx, [v.submittedById], { kind: 'INFO', title: 'Your schedule was sent back', body: `"${v.name}" was sent back by ${p.name}: ${reason}`, data: { screen: 'schedule', versionId: id } });
    return tx.one<any>('SELECT * FROM schedule_versions WHERE tenant_id = :t AND id = $1', [id]);
  });
  publish(p.tenantId, ['schedule', 'reject'], { id, name: out.name, by: p.name });
  res.json(dto(out));
});

// ---------------------------------------------------------------- change impact

export interface Impact {
  previous: { id: string; name: string }[]; noticeHours: number; today: string;
  totals: { people: number; added: number; removed: number; changed: number; unchanged: number; hoursDelta: number; shortNotice: number };
  people: PersonImpact[];
}

/** What publishing draft `v` changes for each person against the schedule(s) live now for the same group and dates. `previous` is empty when nothing is live: then it is all new. */
export async function computeImpact(tx: Tx, v: any): Promise<Impact> {
  const pol = await loadPolicy(tx);
  const g = await tx.one<{ timezone: string }>('SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1', [v.wfmGroupId]);
  const tz = g?.timezone ?? 'UTC', today = todayIn(tz), noticeHours = pol.scheduling.changeNoticeHours;
  const live = await tx.q<{ id: string; name: string }>(
    `SELECT id, name FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND id <> $2 AND kind = $3 AND period_start <= $5::date AND period_end >= $4::date`,
    [v.wfmGroupId, v.id, v.kind ?? 'DEMAND', v.periodStart, v.periodEnd]);
  const shifts = (ids: string[], through: boolean) => tx.q<ShiftRow>(
    `SELECT s.employee_id, s.day::text AS day, s.start_slot, s.length_slots FROM schedule_shifts s JOIN schedule_versions x ON x.id = s.version_id
      WHERE s.tenant_id = :t AND s.version_id = ANY($1::uuid[]) AND s.day >= $2::date AND s.day <= $3::date ${through ? 'AND (x.publish_through IS NULL OR s.day <= x.publish_through)' : ''}`, [ids, v.periodStart, v.periodEnd]);
  const after = await shifts([v.id], false), before = live.length ? await shifts(live.map((x) => x.id), true) : [];
  const { people, unchanged } = diffShifts(before, after.filter((r) => !v.publishThrough || r.day <= v.publishThrough), today, noticeHours, tz);
  const names = new Map((await tx.q<{ id: string; first: string; last: string }>(`SELECT id, first_name AS first, last_name AS last FROM employees WHERE tenant_id = :t AND id = ANY($1::uuid[])`, [[...people.keys()]])).map((e) => [e.id, `${e.first} ${e.last}`]));
  const list = [...people.values()].map((x) => ({ ...x, name: names.get(x.employeeId) ?? 'Unknown' })).sort((a, b) => b.shortNotice - a.shortNotice || (b.added + b.removed + b.changed) - (a.added + a.removed + a.changed) || a.name.localeCompare(b.name));
  const sum = (f: (x: PersonImpact) => number) => list.reduce((n, x) => n + f(x), 0);
  return {
    previous: live, noticeHours, today, people: list,
    totals: { people: list.length, added: sum((x) => x.added), removed: sum((x) => x.removed), changed: sum((x) => x.changed), unchanged, hoursDelta: Math.round(sum((x) => x.hoursDelta) * 10) / 10, shortNotice: sum((x) => x.shortNotice) },
  };
}

const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const changeText = (c: Change) => `${dayName(c.day)}: ${c.kind === 'ADDED' ? `new shift ${c.to!.start}-${c.to!.end}` : c.kind === 'REMOVED' ? `shift ${c.from!.start}-${c.from!.end} removed` : `${c.from!.start}-${c.from!.end} is now ${c.to!.start}-${c.to!.end}`}`;

/**
 * Tell people about a published schedule. When it replaces a live one, only the people whose shifts changed hear, and they hear what changed; when nothing was live (or the
 * people had no shifts before) it is the usual "your schedule is ready". People whose shifts did not change get nothing: a republished week should not wake the whole group.
 */
export async function notifyImpact(tx: Tx, v: any, impact: Impact, everyone: string[]): Promise<{ notified: number }> {
  if (!impact.previous.length) {
    const users = await usersOf(tx, everyone);
    await notify(tx, users, { kind: 'SCHEDULE', title: 'Your schedule is ready', body: `${v.periodStart} to ${v.periodEnd}: open Schedule to see your shifts.`, data: { screen: 'schedule', versionId: v.id } });
    return { notified: users.length };
  }
  let n = 0;
  for (const person of impact.people) {
    const users = await usersOf(tx, [person.employeeId]);
    if (!users.length) continue;
    const shown = person.changes.slice(0, 4).map(changeText).join('; ') + (person.changes.length > 4 ? ` and ${person.changes.length - 4} more` : '');
    await notify(tx, users, { kind: 'SCHEDULE', title: person.shortNotice ? 'Your shifts changed at short notice' : 'Your shifts changed', body: shown, data: { screen: 'schedule', versionId: v.id } });
    n++;
  }
  return { notified: n };
}

scheduleApprovalRoutes.get('/versions/:id/impact', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const v = await tx.one<any>('SELECT *, period_start::text AS period_start, period_end::text AS period_end FROM schedule_versions WHERE tenant_id = :t AND id = $1', [id]);
    if (!v) throw notFound('Schedule version');
    if (v.status !== 'DRAFT') throw conflict(`Impact is worked out for a draft, before it is published (this one is ${v.status.toLowerCase()}).`);
    return computeImpact(tx, v);
  }));
});

