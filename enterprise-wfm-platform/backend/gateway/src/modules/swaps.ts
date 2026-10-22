/**
 * Shift swaps and giveaways between colleagues.
 *   SWAP:     two people exchange shifts.        The partner accepts, then the rules decide, then (if needed) a manager.
 *   GIVEAWAY: a shift is offered on the board.   Anyone eligible takes it, then the rules decide, then (if needed) a manager.
 * "The rules" means: the change is tried on a copy of the published schedule and the same validation the scheduler uses is run again,
 * including the labour-law pack, availability, time off, rest and weekly limits, and the effect on cover. Only problems the change
 * itself creates count against it. A change that is clean, keeps cover and is far enough ahead can be approved automatically.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, conflict, notFound, parse } from '../http.ts';
import { dropCache, publish } from '../infra.ts';
import { notify, usersOf } from '../notify.ts';
import { noticeFinding } from './compliance/rules.ts';
import { computeStats, liveStats, loadVersion, refreshStats, revision, validateShifts, type ShiftRow } from './scheduleRoutes.ts';
import { loadSelfPolicy, whoAmI, type Me, type Policy } from './selfService.ts';
import { hhmm } from './workforceRoutes.ts';

export const swapsMe = Router();       // mounted at /me/swaps
export const swapsAdmin = Router();    // mounted at /scheduling/swaps
const uuid = z.string().uuid();
const ACTIVE = ['OPEN', 'PENDING_PARTNER', 'PENDING_APPROVAL'];
const MANAGERS = `SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN ('WFM_ADMIN', 'WFM_MANAGER', 'SCHEDULER')`;

// ---------------------------------------------------------------- what would happen

type Live = Awaited<ReturnType<typeof liveStats>>;
export interface Verdict { ok: boolean; auto: boolean; blockers: string[]; warnings: string[]; extraGapSlots: number; coverageBefore: number; coverageAfter: number }
type Move = { shiftId: string; toEmployeeId: string };

const epoch = (day: string, slot: number) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d, 0, slot * 15); };
function nowIn(tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const g = (t: string) => +parts.find((x) => x.type === t)!.value;
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
}
export const hoursUntil = (tz: string, day: string, slot: number) => (epoch(day, slot) - nowIn(tz)) / 3.6e6;
const todayLocal = (tz: string) => new Date(nowIn(tz)).toISOString().slice(0, 10);

/** Try the moves on a copy of the schedule and report what they would cause. */
export function evaluate(live: Live, pol: Policy, moves: Move[]): Verdict {
  const byId = new Map(live.shifts.map((s) => [s.id!, s]));
  const hyp: ShiftRow[] = live.shifts.map((s) => { const m = moves.find((x) => x.shiftId === s.id); return m ? { ...s, employeeId: m.toEmployeeId } : s; });
  const people = new Set<string>();
  for (const m of moves) { people.add(m.toEmployeeId); people.add(byId.get(m.shiftId)!.employeeId); }
  const key = (v: { type: string; employeeId: string; day: string }) => `${v.type}|${v.employeeId}|${v.day}`;
  const before = new Set(live.violations.filter((v) => people.has(v.employeeId)).map(key));
  const created = computeAfter(live, hyp).filter((v) => people.has(v.employeeId) && !before.has(key(v)));
  const blockers = [...new Set(created.filter((v) => v.severity !== 'WARN').map((v) => v.message))];
  const warnings = [...new Set(created.filter((v) => v.severity === 'WARN').map((v) => v.message))];

  const tz = live.ctx.tz, today = todayLocal(tz);
  for (const m of moves) {
    const s = byId.get(m.shiftId)!;
    const h = hoursUntil(tz, s.day, s.startSlot);
    if (h < 0) blockers.push(`The shift on ${s.day} has already started.`);
    else if (h < pol.swapMinNoticeHours) blockers.push(`The shift on ${s.day} starts in ${Math.round(h)} hours; changes need at least ${pol.swapMinNoticeHours} hours' notice.`);
    for (const id of [m.toEmployeeId, s.employeeId]) {
      const e = live.ctx.employees.find((x) => x.id === id);
      if (!e) continue;
      const f = noticeFinding(live.ctx.rules.forTeam(e.teamId, e.id), { id, name: `${e.firstName} ${e.lastName}`, nightConsent: !!e.nightShiftConsent }, s.day, today);
      if (f && !warnings.includes(f.message)) warnings.push(f.message);
    }
  }
  const after = computeStats(live.ctx, live.days, live.required, hyp, null);
  const extra = after.coverage.underSlots - live.stats.coverage.underSlots;
  if (extra > 0) warnings.push(`Cover on ${moves.map((m) => byId.get(m.shiftId)!.day).filter((d, i, a) => a.indexOf(d) === i).join(', ')} would drop: ${extra} more 15-minute interval${extra === 1 ? '' : 's'} short of the forecast.`);
  const ok = blockers.length === 0;
  return { ok, auto: ok && warnings.length === 0 && extra <= pol.swapMaxExtraGapSlots, blockers, warnings, extraGapSlots: extra, coverageBefore: live.stats.coverage.percent, coverageAfter: after.coverage.percent };
}
const computeAfter = (live: Live, hyp: ShiftRow[]) => validateShifts(live.ctx, hyp);

// ---------------------------------------------------------------- reading swaps

const SQL = `SELECT sw.*, rs.day::text AS r_day, rs.start_slot AS r_start, rs.length_slots AS r_len, ps.day::text AS p_day, ps.start_slot AS p_start, ps.length_slots AS p_len,
    re.first_name || ' ' || re.last_name AS requester_name, pe.first_name || ' ' || pe.last_name AS partner_name, v.name AS version_name
  FROM shift_swaps sw JOIN schedule_shifts rs ON rs.id = sw.requester_shift_id LEFT JOIN schedule_shifts ps ON ps.id = sw.partner_shift_id
  JOIN employees re ON re.id = sw.requester_id LEFT JOIN employees pe ON pe.id = sw.partner_id JOIN schedule_versions v ON v.id = sw.version_id
  WHERE sw.tenant_id = :t`;
const dto = (s: any) => ({
  id: s.id, kind: s.kind, status: s.status, note: s.note, versionId: s.versionId, versionName: s.versionName, requesterId: s.requesterId, requesterName: s.requesterName, partnerId: s.partnerId, partnerName: s.partnerName ?? null,
  give: { shiftId: s.requesterShiftId, day: s.rDay, startTime: hhmm(s.rStart), endTime: hhmm(s.rStart + s.rLen) },
  get: s.partnerShiftId ? { shiftId: s.partnerShiftId, day: s.pDay, startTime: hhmm(s.pStart), endTime: hhmm(s.pStart + s.pLen) } : null,
  decisionReason: s.decisionReason, decidedBy: s.decidedBy, decidedAt: s.decidedAt, autoApproved: s.autoApproved, checks: s.checks, expiresAt: s.expiresAt, createdAt: s.createdAt, updatedAt: s.updatedAt,
});
async function expire(tx: Tx) { await tx.exec(`UPDATE shift_swaps SET status = 'EXPIRED', updated_at = now() WHERE tenant_id = :t AND status IN ('OPEN', 'PENDING_PARTNER') AND expires_at < now()`); }
async function load(tx: Tx, id: string) { const r = (await tx.q<any>(`${SQL} AND sw.id = $1`, [id]))[0]; if (!r) throw notFound('Swap request'); return r; }

async function liveFor(tenantId: string, versionId: string) {
  const v = await withTenant(tenantId, (tx) => loadVersion(tx, versionId));
  return { v, live: await liveStats(tenantId, v) };
}
const movesOf = (s: any): Move[] => (s.kind === 'SWAP' ? [{ shiftId: s.requesterShiftId, toEmployeeId: s.partnerId }, { shiftId: s.partnerShiftId, toEmployeeId: s.requesterId }] : [{ shiftId: s.requesterShiftId, toEmployeeId: s.partnerId }]);

// ---------------------------------------------------------------- doing it

/** Make the change in the published schedule. Same-day swaps exchange the times, so nobody is ever briefly on two shifts. */
async function apply(tenantId: string, s: any, by: Principal, how: string, reason: string | null) {
  await withTenant(tenantId, async (tx) => {
    const a = (await tx.one<any>('SELECT * FROM schedule_shifts WHERE tenant_id = :t AND id = $1', [s.requesterShiftId]))!;
    if (s.kind === 'SWAP') {
      const b = (await tx.one<any>('SELECT * FROM schedule_shifts WHERE tenant_id = :t AND id = $1', [s.partnerShiftId]))!;
      if (a.day === b.day) {
        for (const [id, o] of [[a.id, b], [b.id, a]] as const) await tx.exec(`UPDATE schedule_shifts SET template_id = $2, start_slot = $3, length_slots = $4, activities = $5, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [id, o.templateId, o.startSlot, o.lengthSlots, JSON.stringify(o.activities)]);
      } else {
        await tx.exec(`UPDATE schedule_shifts SET employee_id = $2, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [a.id, s.partnerId]);
        await tx.exec(`UPDATE schedule_shifts SET employee_id = $2, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [b.id, s.requesterId]);
      }
    } else {
      await tx.exec(`UPDATE schedule_shifts SET employee_id = $2, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [a.id, s.partnerId]);
    }
    await tx.exec(`UPDATE shift_swaps SET status = 'APPROVED', auto_approved = $2, decided_by = $3, decided_at = now(), decision_reason = $4, updated_at = now() WHERE tenant_id = :t AND id = $1`, [s.id, how === 'auto', by.name, reason]);
    const summary = s.kind === 'SWAP' ? `Shift swap: ${s.requesterName} (${s.rDay}) and ${s.partnerName} (${s.pDay})` : `Shift given away: ${s.requesterName}'s shift on ${s.rDay} taken by ${s.partnerName}`;
    await audit(tx, by, null, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: s.versionId, entityName: s.versionName, reason: reason ?? undefined, diffSummary: `${summary} (${how === 'auto' ? 'approved by the rules' : 'approved by a manager'})` });
  });
  const st = await refreshStats(tenantId, s.versionId);
  await withTenant(tenantId, async (tx) => {
    const summary = s.kind === 'SWAP' ? `Swap: ${s.requesterName} on ${s.rDay} with ${s.partnerName} on ${s.pDay}` : `Giveaway: ${s.requesterName} on ${s.rDay} to ${s.partnerName}`;
    await revision(tx, by, s.versionId, 'EDIT', summary, reason ?? (how === 'auto' ? 'Approved by the swap rules' : null), st.stats);
    const users = await usersOf(tx, [s.requesterId, s.partnerId]);
    await notify(tx, users, { kind: 'SWAP', title: 'Shift change confirmed', body: s.kind === 'SWAP' ? `Your swap on ${s.rDay} and ${s.pDay} is confirmed.` : `The shift on ${s.rDay} has moved to ${s.partnerName}.`, data: { screen: 'swap', id: s.id } });
  });
  await dropCache(tenantId, 'sched:*');
  publish(tenantId, ['schedule', 'swap'], { id: s.id, version: s.versionId });
}

/** The second person has agreed (or taken the shift): check it again on the live schedule, then approve it or send it to a manager. */
async function settle(p: Principal, swapId: string, pol: Policy) {
  const s = await withTenant(p.tenantId, (tx) => load(tx, swapId));
  const { live } = await liveFor(p.tenantId, s.versionId);
  const verdict = evaluate(live, pol, movesOf(s));
  if (!verdict.ok) {
    await withTenant(p.tenantId, async (tx) => {
      if (s.kind === 'GIVEAWAY') { await tx.exec('UPDATE shift_swaps SET partner_id = NULL, updated_at = now() WHERE tenant_id = :t AND id = $1', [swapId]); return; }   // stays on the board for someone else
      await tx.exec(`UPDATE shift_swaps SET status = 'FAILED', checks = $2, decision_reason = $3, updated_at = now() WHERE tenant_id = :t AND id = $1`, [swapId, JSON.stringify(verdict), verdict.blockers.join(' ')]);
      await notify(tx, await usersOf(tx, [s.requesterId, s.partnerId]), { kind: 'SWAP', title: 'Shift change not possible', body: verdict.blockers[0], data: { screen: 'swap', id: swapId } });
    });
    return { status: 'FAILED', verdict };
  }
  if (pol.swapAutoApprove && verdict.auto) { await apply(p.tenantId, s, p, 'auto', null); return { status: 'APPROVED', verdict }; }
  await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE shift_swaps SET status = 'PENDING_APPROVAL', checks = $2, updated_at = now() WHERE tenant_id = :t AND id = $1`, [swapId, JSON.stringify(verdict)]);
    await notify(tx, (await tx.q<{ id: string }>(MANAGERS)).map((r) => r.id), { kind: 'SWAP', title: 'Shift change needs approval', body: `${s.requesterName} and ${s.partnerName}: ${s.rDay}${s.pDay ? ` and ${s.pDay}` : ''}`, data: { screen: 'swap', id: swapId } });
    await notify(tx, await usersOf(tx, [s.requesterId, s.partnerId]), { kind: 'SWAP', title: 'Waiting for a manager', body: verdict.warnings[0] ?? 'A manager will review the change.', data: { screen: 'swap', id: swapId } });
  });
  return { status: 'PENDING_APPROVAL', verdict };
}

// ---------------------------------------------------------------- the person's side

async function ownShift(tx: Tx, w: Me, shiftId: string) {
  const s = await tx.one<any>(`SELECT s.*, s.day::text AS day, v.status AS vstatus FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id WHERE s.tenant_id = :t AND s.id = $1`, [shiftId]);
  if (!s) throw notFound('Shift');
  if (s.vstatus !== 'PUBLISHED') throw conflict('Only shifts in the published schedule can be traded.');
  return s;
}
async function busy(tx: Tx, shiftId: string) { return !!(await tx.one(`SELECT 1 FROM shift_swaps WHERE tenant_id = :t AND status = ANY($2::text[]) AND (requester_shift_id = $1 OR partner_shift_id = $1)`, [shiftId, ACTIVE])); }

swapsMe.get('/', requires('self:use'), async (req, res) => {
  const p = me(req);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    await expire(tx);
    const rows = (await tx.q<any>(`${SQL} AND (sw.requester_id = $1 OR sw.partner_id = $1) ORDER BY sw.created_at DESC LIMIT 60`, [w.employeeId])).map(dto);
    const board = (await tx.q<any>(
      `${SQL} AND sw.status = 'OPEN' AND sw.requester_id <> $1 AND (sw.expires_at IS NULL OR sw.expires_at > now()) AND re.primary_group_id IS NOT DISTINCT FROM $2 AND rs.day >= $3::date ORDER BY rs.day, rs.start_slot LIMIT 60`, [w.employeeId, w.emp.primaryGroupId, w.today])).map(dto);
    return { mine: rows.filter((r) => r.requesterId === w.employeeId), incoming: rows.filter((r) => r.partnerId === w.employeeId && r.status === 'PENDING_PARTNER'), board };
  }));
});

/** Colleagues whose shift could be swapped for this one, each already checked against the rules. */
swapsMe.get('/candidates', requires('self:use'), async (req, res) => {
  const p = me(req), q = parse(z.object({ shiftId: uuid, includeBlocked: z.enum(['0', '1']).default('0') }), req.query);
  const { w, mine, pol } = await withTenant(p.tenantId, async (tx) => { const w = await whoAmI(tx, p); return { w, mine: await ownShift(tx, w, q.shiftId), pol: await loadSelfPolicy(tx) }; });
  if (mine.employeeId !== w.employeeId) throw bad('That is not your shift.');
  const { live } = await liveFor(p.tenantId, mine.versionId);
  const today = w.today;
  const out = live.shifts.filter((s) => s.employeeId !== w.employeeId && s.day >= today && Math.abs(Date.parse(s.day) - Date.parse(mine.day)) <= 7 * 864e5).slice(0, 400).map((s) => ({ s, v: evaluate(live, pol, [{ shiftId: mine.id, toEmployeeId: s.employeeId }, { shiftId: s.id!, toEmployeeId: w.employeeId }]) }))
    .filter((c) => q.includeBlocked === '1' || c.v.ok).sort((a, b) => Number(b.v.ok) - Number(a.v.ok) || Number(b.v.auto) - Number(a.v.auto) || Number(b.s.day === mine.day) - Number(a.s.day === mine.day) || (a.s.day < b.s.day ? -1 : 1)).slice(0, 40);
  const names = new Map(live.ctx.employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  res.json(out.map(({ s, v }) => ({ shiftId: s.id, employeeId: s.employeeId, name: names.get(s.employeeId) ?? 'Colleague', day: s.day, startTime: hhmm(s.startSlot), endTime: hhmm(s.startSlot + s.lengthSlots), verdict: v })));
});

swapsMe.post('/', requires('self:use'), async (req, res) => {
  const p = me(req), b = parse(z.object({ kind: z.enum(['SWAP', 'GIVEAWAY']), shiftId: uuid, partnerShiftId: uuid.optional(), note: z.string().max(300).default('') }), req.body);
  const created = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p), pol = await loadSelfPolicy(tx);
    const mine = await ownShift(tx, w, b.shiftId);
    if (mine.employeeId !== w.employeeId) throw bad('That is not your shift.');
    if (await busy(tx, mine.id)) throw conflict('That shift is already part of a request.');
    let partnerId: string | null = null;
    if (b.kind === 'SWAP') {
      if (!b.partnerShiftId) throw bad('Choose the shift you would like in exchange.');
      const theirs = await ownShift(tx, w, b.partnerShiftId);
      if (theirs.versionId !== mine.versionId) throw bad('The two shifts belong to different schedules.');
      if (theirs.employeeId === w.employeeId) throw bad('Choose a colleague\'s shift.');
      if (await busy(tx, theirs.id)) throw conflict('That shift is already part of another request.');
      partnerId = theirs.employeeId;
    }
    const id = (await tx.one<{ id: string }>(
      `INSERT INTO shift_swaps (tenant_id, version_id, kind, requester_id, requester_shift_id, partner_id, partner_shift_id, status, note, expires_at)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' hours')::interval) RETURNING id`,
      [mine.versionId, b.kind, w.employeeId, mine.id, partnerId, b.partnerShiftId ?? null, b.kind === 'SWAP' ? 'PENDING_PARTNER' : 'OPEN', b.note, String(pol.swapBoardHours)]))!.id;
    return { id, w, mine, pol, partnerId, versionId: mine.versionId };
  });
  // try it first, so a request that could never work is refused now with the reason
  const s = await withTenant(p.tenantId, (tx) => load(tx, created.id));
  const { live } = await liveFor(p.tenantId, created.versionId);
  const probe: Move[] = b.kind === 'SWAP' ? movesOf(s) : [];
  const v = b.kind === 'SWAP' ? evaluate(live, created.pol, probe) : null;
  if (v && !v.ok) { await withTenant(p.tenantId, (tx) => tx.exec('DELETE FROM shift_swaps WHERE tenant_id = :t AND id = $1', [created.id])); throw bad(`This swap cannot be made: ${v.blockers.join(' ')}`); }
  await withTenant(p.tenantId, async (tx) => {
    await tx.exec('UPDATE shift_swaps SET checks = $2 WHERE tenant_id = :t AND id = $1', [created.id, JSON.stringify(v ?? {})]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SHIFT_SWAP', entityId: created.id, entityName: `${s.requesterName} ${s.rDay}`, diffSummary: b.kind === 'SWAP' ? `swap offered to ${s.partnerName}` : 'shift offered on the board' });
    if (created.partnerId) await notify(tx, await usersOf(tx, [created.partnerId]), { kind: 'SWAP', title: 'Swap proposed', body: `${s.requesterName} would like to swap ${s.rDay} for your ${s.pDay} shift.`, data: { screen: 'swap', id: created.id } });
  });
  res.status(201).json(dto(await withTenant(p.tenantId, (tx) => load(tx, created.id))));
});

async function respond(req: any, res: any, action: 'accept' | 'decline' | 'take' | 'cancel') {
  const p = me(req), id = parse(uuid, req.params.id);
  const { w, s, pol } = await withTenant(p.tenantId, async (tx) => { const w = await whoAmI(tx, p); await expire(tx); return { w, s: await load(tx, id), pol: await loadSelfPolicy(tx) }; });
  if (action === 'cancel') {
    if (s.requesterId !== w.employeeId) throw bad('Only the person who asked can cancel.');
    if (!ACTIVE.includes(s.status)) throw conflict(`This request is already ${s.status.toLowerCase().replace('_', ' ')}.`);
    await withTenant(p.tenantId, async (tx) => { await tx.exec(`UPDATE shift_swaps SET status = 'CANCELLED', updated_at = now() WHERE tenant_id = :t AND id = $1`, [id]); await notify(tx, await usersOf(tx, [s.partnerId]), { kind: 'SWAP', title: 'Swap cancelled', body: `${s.requesterName} withdrew the request for ${s.rDay}.`, data: { screen: 'swap', id } }); });
    return res.json(dto(await withTenant(p.tenantId, (tx) => load(tx, id))));
  }
  if (action === 'take') {
    if (s.kind !== 'GIVEAWAY' || s.status !== 'OPEN') throw conflict('This shift is no longer on the board.');
    if (s.requesterId === w.employeeId) throw bad('You offered this shift yourself.');
    await withTenant(p.tenantId, (tx) => tx.exec('UPDATE shift_swaps SET partner_id = $2, updated_at = now() WHERE tenant_id = :t AND id = $1', [id, w.employeeId]));
  } else {
    if (s.partnerId !== w.employeeId || s.status !== 'PENDING_PARTNER') throw conflict('There is nothing here for you to answer.');
    if (action === 'decline') {
      await withTenant(p.tenantId, async (tx) => { await tx.exec(`UPDATE shift_swaps SET status = 'REJECTED', decision_reason = 'Declined by the colleague', updated_at = now() WHERE tenant_id = :t AND id = $1`, [id]); await notify(tx, await usersOf(tx, [s.requesterId]), { kind: 'SWAP', title: 'Swap declined', body: `${s.partnerName} declined the swap for ${s.rDay}.`, data: { screen: 'swap', id } }); });
      return res.json(dto(await withTenant(p.tenantId, (tx) => load(tx, id))));
    }
  }
  const out = await settle(p, id, pol);
  const fresh = dto(await withTenant(p.tenantId, (tx) => load(tx, id)));
  if (out.status === 'FAILED') return res.status(409).json({ error: { code: 'NOT_POSSIBLE', message: out.verdict.blockers.join(' ') }, swap: fresh });
  res.json(fresh);
}
swapsMe.post('/:id/accept', requires('self:use'), (req, res) => respond(req, res, 'accept'));
swapsMe.post('/:id/decline', requires('self:use'), (req, res) => respond(req, res, 'decline'));
swapsMe.post('/:id/take', requires('self:use'), (req, res) => respond(req, res, 'take'));
swapsMe.post('/:id/cancel', requires('self:use'), (req, res) => respond(req, res, 'cancel'));

// ---------------------------------------------------------------- the manager's side

swapsAdmin.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ status: z.string().optional() }), req.query);
  const out = await withTenant(p.tenantId, async (tx) => { await expire(tx); return (await tx.q<any>(`${SQL} AND ($1::text IS NULL OR sw.status = $1) ORDER BY (sw.status = 'PENDING_APPROVAL') DESC, sw.updated_at DESC LIMIT 200`, [q.status ?? null])).map(dto); });
  res.json(out);
});

swapsAdmin.post('/:id/decide', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({ approve: z.boolean(), reason: z.string().trim().max(300).default('') }), req.body);
  if (!b.approve && b.reason.length < 3) throw bad('Give a reason when declining.');
  const { s, pol } = await withTenant(p.tenantId, async (tx) => ({ s: await load(tx, id), pol: await loadSelfPolicy(tx) }));
  if (s.status !== 'PENDING_APPROVAL') throw conflict(`This request is ${s.status.toLowerCase().replace('_', ' ')}, not waiting for approval.`);
  if (!b.approve) {
    await withTenant(p.tenantId, async (tx) => {
      await tx.exec(`UPDATE shift_swaps SET status = 'REJECTED', decided_by = $2, decided_at = now(), decision_reason = $3, updated_at = now() WHERE tenant_id = :t AND id = $1`, [id, p.name, b.reason]);
      await audit(tx, p, req, { action: 'REJECT', entityType: 'SHIFT_SWAP', entityId: id, entityName: `${s.requesterName} ${s.rDay}`, reason: b.reason });
      await notify(tx, await usersOf(tx, [s.requesterId, s.partnerId]), { kind: 'SWAP', title: 'Shift change declined', body: b.reason, data: { screen: 'swap', id } });
    });
    return res.json(dto(await withTenant(p.tenantId, (tx) => load(tx, id))));
  }
  const { live } = await liveFor(p.tenantId, s.versionId);
  const v = evaluate(live, pol, movesOf(s));
  if (!v.ok) throw conflict(`This can no longer be approved: ${v.blockers.join(' ')}`);
  await apply(p.tenantId, s, p, 'manager', b.reason || null);
  res.json(dto(await withTenant(p.tenantId, (tx) => load(tx, id))));
});
