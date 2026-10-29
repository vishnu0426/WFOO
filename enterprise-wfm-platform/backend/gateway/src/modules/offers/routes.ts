/**
 * Voluntary time off (VTO) and overtime offers.
 * A manager opens an offer for a window of a day (or takes a suggestion the forecast makes). Everyone whose shift can take the change
 * without breaking a blocking rule is ranked in the order the organisation chose and invited, all at once or in waves. Each acceptance
 * is checked again on the live schedule and then changes the published shift. The offer closes when its places are filled or its time is up.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../../db.ts';
import { me, requires, type Principal } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { HttpError, bad, conflict, isoDay, notFound, parse } from '../../http.ts';
import { dropCache, publish } from '../../infra.ts';
import { notify, usersOf } from '../../notify.ts';
import { computeStats, liveStats, refreshStats, requirementForManual, revision, shiftsOf, validateShifts, type ShiftRow } from '../scheduleRoutes.ts';
import { paidSlots } from '../templateRules.ts';
import { liveReforecast } from '../intradayRoutes.ts';
import { whoAmI } from '../selfService.ts';
import { hhmm } from '../workforceRoutes.ts';
import { hoursUntil } from '../swaps.ts';
import { ORDERINGS, orderCandidates, overtimeChange, runs, vtoChange, type Candidate, type Change, type Ordering } from './logic.ts';

export const offersAdmin = Router();    // mounted at /scheduling/offers
export const offersMe = Router();       // mounted at /me/offers
export const offerPolicyRoutes = Router();   // mounted at /self-service/offer-policy
const uuid = z.string().uuid();
const SPD = 96;
type Live = Awaited<ReturnType<typeof liveStats>>;
type Row = ShiftRow & { id: string; activities: any[]; source: string };

// ---------------------------------------------------------------- the organisation's choices

export interface OfferPolicy { vtoOrdering: Ordering; overtimeOrdering: Ordering; reverseSeniority: boolean; waveSize: number; waveMinutes: number; offerMinutes: number }
export async function loadOfferPolicy(tx: Tx): Promise<OfferPolicy> {
  await tx.exec('INSERT INTO offer_policy (tenant_id) VALUES (:t) ON CONFLICT (tenant_id) DO NOTHING');
  const r = (await tx.one<any>('SELECT * FROM offer_policy WHERE tenant_id = :t'))!;
  return { vtoOrdering: r.vtoOrdering, overtimeOrdering: r.overtimeOrdering, reverseSeniority: r.reverseSeniority, waveSize: r.waveSize, waveMinutes: r.waveMinutes, offerMinutes: r.offerMinutes };
}
const Ord = z.enum(ORDERINGS as [Ordering, ...Ordering[]]);
offerPolicyRoutes.get('/', requires('config:read'), async (req, res) => { res.json(await withTenant(me(req).tenantId, loadOfferPolicy)); });
offerPolicyRoutes.put('/', requires('config:write'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({ vtoOrdering: Ord, overtimeOrdering: Ord, reverseSeniority: z.boolean(), waveSize: z.number().int().min(0).max(500), waveMinutes: z.number().int().min(1).max(1440), offerMinutes: z.number().int().min(5).max(10080) }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const before = await loadOfferPolicy(tx);
    await tx.exec(
      `UPDATE offer_policy SET vto_ordering = $1, overtime_ordering = $2, reverse_seniority = $3, wave_size = $4, wave_minutes = $5, offer_minutes = $6, updated_at = now() WHERE tenant_id = :t`,
      [b.vtoOrdering, b.overtimeOrdering, b.reverseSeniority, b.waveSize, b.waveMinutes, b.offerMinutes]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'OFFER_POLICY', entityId: 'policy', entityName: 'Offer rules', before, after: b });
    return loadOfferPolicy(tx);
  });
  res.json(out);
});

// ---------------------------------------------------------------- what an offer would do to one person

const slotOf = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? Math.min(SPD, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };
const kindWord = (k: string) => (k === 'VTO' ? 'time off' : 'overtime');

/**
 * The roster in force on a day. Usually one published schedule. A rotation and the schedule that fills its gaps are published side by side
 * and are the real roster together, so their shifts are joined and measured against the full staffing target: an offer must see everyone's
 * shifts (someone on a rotation shift is not "free" just because the fill schedule has nothing for them).
 */
async function liveForDay(tenantId: string, groupId: string, day: string, cache?: Map<string, Promise<{ v: any; live: Live }>>) {
  const vs = await withTenant(tenantId, (tx) => tx.q<any>(
    `SELECT v.*, v.period_start::text AS period_start, v.period_end::text AS period_end, f.name AS forecast_name FROM schedule_versions v LEFT JOIN forecast_versions f ON f.id = v.forecast_version_id
     WHERE v.tenant_id = :t AND v.wfm_group_id = $1 AND v.status = 'PUBLISHED' AND v.period_start <= $2::date AND v.period_end >= $2::date ORDER BY v.seq DESC`, [groupId, day]));
  if (!vs.length) throw bad(`There is no published schedule for this group on ${day}. Publish one first: offers change the published schedule.`);
  const key = vs.map((x) => x.id).join('|');
  const hit = cache?.get(key);
  if (hit) return hit;
  const work = (async () => {
    const v = vs[0];
    let live = await liveStats(tenantId, v);
    // a rotation roster has no forecast of its own: with none to measure against, use the group's coverage windows
    if (v.kind === 'ROTATION' && v.coverageSource !== 'MANUAL' && !live.gross.some((x) => x > 0)) {
      const man = await requirementForManual(tenantId, v.wfmGroupId, live.days).catch(() => null);
      if (man) live = { ...live, gross: man.required, required: man.required, stats: computeStats(live.ctx, live.days, man.required, live.shifts, null, { uncoveredDays: man.uncovered }) };
    }
    if (vs.length === 1) return { v, live };
    const inPeriod = new Set(live.days);
    const others = await withTenant(tenantId, async (tx) => { const out: Awaited<ReturnType<typeof shiftsOf>> = []; for (const o of vs.slice(1)) out.push(...await shiftsOf(tx, o.id)); return out; });
    const shifts = [...live.shifts, ...others.filter((s) => inPeriod.has(s.day))];
    return { v, live: { ...live, shifts, required: live.gross, stats: computeStats(live.ctx, live.days, live.gross, shifts, null), violations: validateShifts(live.ctx, shifts) } as Live };
  })();
  cache?.set(key, work);
  return work;
}

/** People scheduled minus people needed for each quarter hour of one day, counting shifts that run in from the night before and out past midnight. */
function gapForDay(live: Live, day: string): number[] {
  const i = live.days.indexOf(day), total = live.days.length * SPD, cover = new Array(total).fill(0);
  for (const s of live.shifts as Row[]) {
    const di = live.days.indexOf(s.day);
    if (di >= 0) for (let g = di * SPD + s.startSlot; g < Math.min(total, di * SPD + s.startSlot + s.lengthSlots); g++) cover[g]++;
  }
  return Array.from({ length: SPD }, (_, sl) => cover[i * SPD + sl] - live.required[i * SPD + sl]);
}

interface Assessment { ok: boolean; why: string; change: Change | null; shift: Row | null; blockers: string[]; warnings: string[] }
const dropKeys = (live: Live) => new Map(live.violations.map((v) => [`${v.type}|${v.employeeId}|${v.day}`, 1]));

/** Try the offer on one person's shift, on a copy of the schedule, with the scheduler's own rules. */
function assess(live: Live, kind: 'VTO' | 'OVERTIME', employeeId: string, day: string, ws: number, we: number): Assessment {
  const mine = (live.shifts as Row[]).find((s) => s.employeeId === employeeId && s.day === day) ?? null;
  const change = kind === 'VTO'
    ? (mine ? vtoChange({ startSlot: mine.startSlot, lengthSlots: mine.lengthSlots, activities: mine.activities }, ws, we) : null)
    : overtimeChange(mine ? { startSlot: mine.startSlot, lengthSlots: mine.lengthSlots, activities: mine.activities } : null, ws, we);
  if (!change) return { ok: false, why: kind === 'VTO' ? (mine ? 'The window does not reach the start or the end of this shift.' : 'Not working then.') : 'The hours do not join up with this shift and they are not a day off.', change: null, shift: mine, blockers: [], warnings: [] };
  const hyp: ShiftRow[] = (live.shifts as ShiftRow[]).flatMap((s) => {
    if (mine && s === (mine as ShiftRow)) return change.kind === 'DELETE' ? [] : change.kind === 'UPDATE' ? [{ ...s, startSlot: change.startSlot, lengthSlots: change.lengthSlots }] : [s];
    return [s];
  });
  if (change.kind === 'INSERT') hyp.push({ employeeId, day, startSlot: change.startSlot, lengthSlots: change.lengthSlots, templateId: null });
  const before = dropKeys(live);
  const created = validateShifts(live.ctx, hyp).filter((v) => v.employeeId === employeeId && !before.has(`${v.type}|${v.employeeId}|${v.day}`));
  const blockers = [...new Set(created.filter((v) => v.severity !== 'WARN').map((v) => v.message))];
  const warnings = [...new Set(created.filter((v) => v.severity === 'WARN').map((v) => v.message))];
  const after = computeStats(live.ctx, live.days, live.required, hyp, null);
  const extra = after.coverage.underSlots - live.stats.coverage.underSlots;
  if (kind === 'VTO' && extra > 0) warnings.push(`Cover would drop: ${extra} more 15-minute interval${extra === 1 ? '' : 's'} short of the forecast.`);
  return { ok: blockers.length === 0, why: blockers[0] ?? '', change, shift: mine, blockers, warnings };
}

// first day of the pay week `d` is in (Monday unless the schedule was built with another pay week)
const mondayOf = (d: string, weekStart = 0) => { const [y, m, dd] = d.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, dd)); t.setUTCDate(t.getUTCDate() - (((t.getUTCDay() + 6) % 7 - weekStart + 7) % 7)); return t.toISOString().slice(0, 10); };

async function candidatesFor(tx: Tx, live: Live, kind: 'VTO' | 'OVERTIME', day: string, ws: number, we: number, ordering: Ordering, reverse: boolean, seed: string) {
  const tplById = new Map(live.ctx.templates.map((t: any) => [t.id, t]));
  const monday = mondayOf(day, live.ctx.weekStart);
  const hours = new Map<string, number>();
  for (const s of live.shifts as Row[]) if (mondayOf(s.day, live.ctx.weekStart) === monday) hours.set(s.employeeId, (hours.get(s.employeeId) ?? 0) + paidSlots(tplById.get(s.templateId!) as any, s.lengthSlots) / 4);
  const last = new Map((await tx.q<any>(
    `SELECT i.employee_id, max(i.responded_at) AS at FROM offer_invites i JOIN offers o ON o.id = i.offer_id WHERE i.tenant_id = :t AND i.status = 'ACCEPTED' AND o.kind = $1 GROUP BY i.employee_id`, [kind])).map((r) => [r.employeeId, r.at ? new Date(r.at).toISOString() : null]));
  const ok: { c: Candidate; a: Assessment }[] = [];
  for (const e of live.ctx.employees as any[]) {
    if (e.status !== 'ACTIVE') continue;
    const a = assess(live, kind, e.id, day, ws, we);
    if (a.ok) ok.push({ c: { employeeId: e.id, employeeNumber: e.employeeNumber, hireDate: e.hireDate ?? null, weekHours: hours.get(e.id) ?? 0, lastAcceptedAt: last.get(e.id) ?? null }, a });
  }
  const ranked = orderCandidates(ok.map((x) => x.c), ordering, { reverseSeniority: reverse, seed });
  const byId = new Map(ok.map((x) => [x.c.employeeId, x.a]));
  return ranked.map((c, i) => ({ ...c, rank: i + 1, warnings: byId.get(c.employeeId)!.warnings }));
}

// ---------------------------------------------------------------- creating and running an offer

const SUMMARY = `SELECT o.*, o.day::text AS day, g.name AS group_name,
    (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id AND i.status = 'INVITED') AS invited,
    (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id AND i.status = 'QUEUED') AS queued,
    (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id AND i.status = 'DECLINED') AS declined,
    (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id) AS total
  FROM offers o JOIN wfm_groups g ON g.id = o.wfm_group_id WHERE o.tenant_id = :t`;
const offerDto = (o: any) => ({
  id: o.id, groupId: o.wfmGroupId, groupName: o.groupName, kind: o.kind, day: o.day, startTime: hhmm(o.startSlot), endTime: o.endSlot >= SPD ? '24:00' : hhmm(o.endSlot), spots: o.spots, filled: o.filled, status: o.status, note: o.note,
  ordering: o.ordering, waveSize: o.waveSize, waveMinutes: o.waveMinutes, wave: o.wave, closesAt: o.closesAt, createdBy: o.createdBy, createdAt: o.createdAt, invited: o.invited, queued: o.queued, declined: o.declined, total: o.total,
});

async function inviteNext(tx: Tx, o: any, count: number) {
  const next = await tx.q<any>(`SELECT id, employee_id FROM offer_invites WHERE tenant_id = :t AND offer_id = $1 AND status = 'QUEUED' ORDER BY rank LIMIT $2`, [o.id, count]);
  if (!next.length) return 0;
  await tx.exec(`UPDATE offer_invites SET status = 'INVITED', wave = $2, invited_at = now() WHERE tenant_id = :t AND id = ANY($1::uuid[])`, [next.map((n) => n.id), o.wave + 1]);
  await tx.exec('UPDATE offers SET wave = wave + 1, wave_started_at = now(), updated_at = now() WHERE tenant_id = :t AND id = $1', [o.id]);
  await notify(tx, await usersOf(tx, next.map((n) => n.employeeId)), {
    kind: 'OFFER', title: o.kind === 'VTO' ? 'Time off offered' : 'Overtime offered', body: `${o.day} ${hhmm(o.startSlot)} to ${o.endSlot >= SPD ? '24:00' : hhmm(o.endSlot)}${o.note ? `: ${o.note}` : ''}`, data: { screen: 'offer', id: o.id },
  });
  return next.length;
}

/** Close what is over, and invite the next wave of an offer that has been waiting long enough or whose wave has all answered. */
export async function advanceOffers(tenantId: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const late = await tx.q<any>(`UPDATE offers SET status = 'EXPIRED', updated_at = now() WHERE tenant_id = :t AND status = 'OPEN' AND closes_at < now() RETURNING id`);
    if (late.length) await tx.exec(`UPDATE offer_invites SET status = 'EXPIRED' WHERE tenant_id = :t AND offer_id = ANY($1::uuid[]) AND status IN ('QUEUED', 'INVITED')`, [late.map((l) => l.id)]);
    const open = await tx.q<any>(
      `SELECT o.*, o.day::text AS day, (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id AND i.status = 'INVITED') AS invited,
              (SELECT count(*)::int FROM offer_invites i WHERE i.offer_id = o.id AND i.status = 'QUEUED') AS queued FROM offers o WHERE o.tenant_id = :t AND o.status = 'OPEN' AND o.wave_size > 0`);
    for (const o of open) {
      if (!o.queued) continue;
      const waited = o.waveStartedAt ? (Date.now() - new Date(o.waveStartedAt).getTime()) / 60000 : Infinity;
      if (o.invited === 0 || waited >= o.waveMinutes) await inviteNext(tx, o, o.waveSize);
    }
  });
}

let ticker: ReturnType<typeof setInterval> | null = null;
/** Once a minute, move offers along for every organisation (waves and closing times do not wait for anyone to open a screen). */
export function startOfferTicker() {
  if (ticker) return;
  ticker = setInterval(async () => {
    try { for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) await advanceOffers(t.id); } catch (e) { console.error('[offers]', (e as Error).message); }
  }, 60_000);
  ticker.unref();
}

const Create = z.object({
  groupId: uuid, kind: z.enum(['VTO', 'OVERTIME']), day: z.string().regex(isoDay), startTime: z.string(), endTime: z.string(), spots: z.number().int().min(1).max(500), note: z.string().trim().max(200).default(''),
  ordering: Ord.optional(), waveSize: z.number().int().min(0).max(500).optional(), waveMinutes: z.number().int().min(1).max(1440).optional(), offerMinutes: z.number().int().min(1).max(10080).optional(),
});

offersAdmin.post('/', requires('schedule:edit'), async (req, res) => {
  const p = me(req), b = parse(Create, req.body);
  const ws = slotOf(b.startTime), we = b.endTime === '24:00' ? SPD : slotOf(b.endTime);
  if (Number.isNaN(ws) || Number.isNaN(we) || we <= ws) throw bad('The window must look like 14:00 to 16:00, with the end after the start.');
  const { v, live } = await liveForDay(p.tenantId, b.groupId, b.day);
  const tz = live.ctx.tz, minsAway = Math.round(hoursUntil(tz, b.day, ws) * 60);
  if (minsAway <= 0) throw bad('That window has already started. Offers are for time that has not begun.');
  const out = await withTenant(p.tenantId, async (tx) => {
    const pol = await loadOfferPolicy(tx);
    const ordering = b.ordering ?? (b.kind === 'VTO' ? pol.vtoOrdering : pol.overtimeOrdering);
    const waveSize = ordering === 'FIRST_COME' ? 0 : (b.waveSize ?? pol.waveSize);
    const cands = await candidatesFor(tx, live, b.kind, b.day, ws, we, ordering, pol.reverseSeniority, `${b.groupId}${b.day}${ws}${b.kind}`);
    if (!cands.length) throw bad(`Nobody can take this ${kindWord(b.kind)} without breaking a rule or a shift boundary. ${b.kind === 'VTO' ? 'Time off has to reach the start or the end of a shift.' : 'Extra hours have to join up with a shift or fall on a day off.'}`);
    const closes = Math.min(b.offerMinutes ?? pol.offerMinutes, minsAway);
    const o = (await tx.one<any>(
      `INSERT INTO offers (tenant_id, wfm_group_id, version_id, kind, day, start_slot, end_slot, spots, note, ordering, wave_size, wave_minutes, closes_at, created_by)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + ($12 || ' minutes')::interval, $13) RETURNING *`,
      [b.groupId, v.id, b.kind, b.day, ws, we, Math.min(b.spots, cands.length), b.note, ordering, waveSize, b.waveMinutes ?? pol.waveMinutes, String(closes), p.name]))!;
    for (const c of cands) await tx.exec('INSERT INTO offer_invites (tenant_id, offer_id, employee_id, rank, warnings) VALUES (:t, $1, $2, $3, $4)', [o.id, c.employeeId, c.rank, JSON.stringify(c.warnings)]);
    await inviteNext(tx, { ...o, day: b.day, wave: 0 }, waveSize === 0 ? cands.length : waveSize);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'OFFER', entityId: o.id, entityName: `${kindWord(b.kind)} ${b.day} ${b.startTime} to ${b.endTime}`, reason: b.note || undefined, after: { ordering, spots: o.spots, invitees: cands.length, waveSize } });
    return o.id as string;
  });
  res.status(201).json(offerDto((await withTenant(p.tenantId, (tx) => tx.one<any>(`${SUMMARY} AND o.id = $1`, [out])))!));
});

offersAdmin.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ status: z.string().optional() }), req.query);
  await advanceOffers(p.tenantId);
  res.json((await withTenant(p.tenantId, (tx) => tx.q<any>(`${SUMMARY} AND ($1::text IS NULL OR o.status = $1) ORDER BY (o.status = 'OPEN') DESC, o.day DESC, o.created_at DESC LIMIT 100`, [q.status ?? null]))).map(offerDto));
});

/** From the forecast: stretches of a day where more people are scheduled than needed (offer time off) or fewer (offer overtime). */
offersAdmin.get('/suggestions', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid, day: z.string().regex(isoDay) }), req.query);
  const { live } = await liveForDay(p.tenantId, q.groupId, q.day);
  const i = live.days.indexOf(q.day);
  // for today, act on the live reforecast (what is actually arriving) rather than the stale plain forecast
  const reforecast = await liveReforecast(p.tenantId, q.groupId, q.day);
  const gap = gapForDay(live, q.day);
  if (reforecast) for (let s = 0; s < SPD; s++) gap[s] += live.required[i * SPD + s] - (reforecast.required.get(s) ?? live.required[i * SPD + s]);
  const win = (r: { start: number; end: number; spots: number }) => ({ startTime: hhmm(r.start), endTime: r.end >= SPD ? '24:00' : hhmm(r.end), spots: r.spots });
  const basis = reforecast ? ' than what is actually coming in today' : ' than the forecast needs';
  res.json({
    day: q.day, reforecastApplied: !!reforecast,
    vto: runs(gap, 1, 1, 2).map((r) => ({ kind: 'VTO', ...win(r), reason: `${r.spots} more ${r.spots === 1 ? 'person' : 'people'} scheduled${basis}` })),
    overtime: runs(gap, 1, -1, 2).map((r) => ({ kind: 'OVERTIME', ...win(r), reason: `${r.spots} fewer ${r.spots === 1 ? 'person' : 'people'}${basis}` })),
  });
});

/**
 * Gaps left across the next days, whatever the roster is made of: the published schedule(s) against the full staffing target. This is where a rotation
 * plus the schedule that fills its gaps ends up -- what is still short can be offered as overtime, and anyone eligible (crew members on a day off
 * included) is asked, through the same rules as any other offer. Windows that have already begun are left out.
 */
offersAdmin.get('/shortages', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid, from: z.string().regex(isoDay).optional(), days: z.coerce.number().int().min(1).max(14).default(7) }), req.query);
  const cache = new Map<string, Promise<{ v: any; live: Live }>>();
  const from = q.from ?? new Date().toISOString().slice(0, 10);
  const unpublished: string[] = [], gaps: { day: string; startTime: string; endTime: string; spots: number; shortHours: number }[] = [];
  for (let k = 0; k < q.days; k++) {
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);
    let got: { v: any; live: Live };
    try { got = await liveForDay(p.tenantId, q.groupId, day, cache); } catch (e) { if (e instanceof HttpError && e.status === 400) { unpublished.push(day); continue; } throw e; }
    const gap = gapForDay(got.live, day);
    for (const r of runs(gap, 1, -1, 2)) {
      if (hoursUntil(got.live.ctx.tz, day, r.start) <= 0) continue;
      let short = 0; for (let g = r.start; g < r.end; g++) short += Math.max(0, -gap[g]);
      gaps.push({ day, startTime: hhmm(r.start), endTime: r.end >= SPD ? '24:00' : hhmm(r.end), spots: r.spots, shortHours: Math.round(short) / 4 });
    }
  }
  res.json({ from, days: q.days, unpublishedDays: unpublished, gaps, totalShortHours: Math.round(gaps.reduce((a, g) => a + g.shortHours, 0) * 10) / 10 });
});

offersAdmin.get('/:id', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await advanceOffers(p.tenantId);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const o = await tx.one<any>(`${SUMMARY} AND o.id = $1`, [id]);
    if (!o) throw notFound('Offer');
    const inv = await tx.q<any>(
      `SELECT i.*, e.first_name || ' ' || e.last_name AS name, e.employee_number FROM offer_invites i JOIN employees e ON e.id = i.employee_id WHERE i.tenant_id = :t AND i.offer_id = $1 ORDER BY i.rank`, [id]);
    return { ...offerDto(o), invites: inv.map((i) => ({ employeeId: i.employeeId, name: i.name, employeeNumber: i.employeeNumber, rank: i.rank, wave: i.wave, status: i.status, warnings: i.warnings, invitedAt: i.invitedAt, respondedAt: i.respondedAt })) };
  }));
});

offersAdmin.post('/:id/cancel', requires('schedule:edit'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const o = await tx.one<any>('SELECT * FROM offers WHERE tenant_id = :t AND id = $1', [id]);
    if (!o) throw notFound('Offer');
    if (o.status !== 'OPEN') throw conflict(`This offer is already ${o.status.toLowerCase()}.`);
    await tx.exec(`UPDATE offers SET status = 'CANCELLED', updated_at = now() WHERE tenant_id = :t AND id = $1`, [id]);
    await tx.exec(`UPDATE offer_invites SET status = 'EXPIRED' WHERE tenant_id = :t AND offer_id = $1 AND status IN ('QUEUED', 'INVITED')`, [id]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'OFFER', entityId: id, entityName: `${kindWord(o.kind)} offer`, diffSummary: 'cancelled' });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- the person's side

const mineDto = (o: any) => ({ ...offerDto({ ...o, groupName: '' }), spotsLeft: o.spots - o.filled, myStatus: o.myStatus, warnings: o.warnings ?? [], respondedAt: o.respondedAt });
const MINE = `SELECT o.*, o.day::text AS day, i.status AS my_status, i.warnings, i.responded_at, 0 AS invited, 0 AS queued, 0 AS declined, 0 AS total
  FROM offer_invites i JOIN offers o ON o.id = i.offer_id WHERE i.tenant_id = :t AND i.employee_id = $1`;

offersMe.get('/', requires('self:use'), async (req, res) => {
  const p = me(req);
  await advanceOffers(p.tenantId);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const open = await tx.q<any>(`${MINE} AND i.status = 'INVITED' AND o.status = 'OPEN' ORDER BY o.day, o.start_slot`, [w.employeeId]);
    const recent = await tx.q<any>(`${MINE} AND (i.status <> 'INVITED' OR o.status <> 'OPEN') AND i.status <> 'QUEUED' ORDER BY o.created_at DESC LIMIT 15`, [w.employeeId]);
    return { open: open.map(mineDto), recent: recent.map(mineDto) };
  }));
});

async function answer(req: any, res: any, accept: boolean) {
  const p: Principal = me(req), id = parse(uuid, req.params.id);
  const result = await withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`offer:${id}`]);        // two people accepting at once are handled one after the other
    const w = await whoAmI(tx, p);
    const o = await tx.one<any>('SELECT *, day::text AS day FROM offers WHERE tenant_id = :t AND id = $1', [id]);
    if (!o) throw notFound('Offer');
    const inv = await tx.one<any>(`SELECT * FROM offer_invites WHERE tenant_id = :t AND offer_id = $1 AND employee_id = $2`, [id, w.employeeId]);
    if (!inv) throw notFound('Offer');
    if (inv.status !== 'INVITED') throw conflict(inv.status === 'ACCEPTED' ? 'You already took this.' : 'This offer is no longer open to you.');
    if (!accept) {
      await tx.exec(`UPDATE offer_invites SET status = 'DECLINED', responded_at = now() WHERE tenant_id = :t AND id = $1`, [inv.id]);
      return { status: 'DECLINED', apply: null as null | { versionId: string; summary: string } };
    }
    if (o.status !== 'OPEN' || new Date(o.closesAt) < new Date()) throw conflict('This offer has closed.');
    if (o.filled >= o.spots) throw conflict('Someone else took the last place.');
    const { live } = await liveForDay(p.tenantId, o.wfmGroupId, o.day);
    const a = assess(live, o.kind, w.employeeId, o.day, o.startSlot, o.endSlot);
    if (!a.ok || !a.change) {
      await tx.exec(`UPDATE offer_invites SET status = 'SKIPPED', responded_at = now() WHERE tenant_id = :t AND id = $1`, [inv.id]);
      throw new HttpError(409, 'NOT_POSSIBLE', `This can no longer be done: ${a.why || 'the schedule has changed.'}`);
    }
    const c = a.change;
    if (c.kind === 'DELETE') await tx.exec('DELETE FROM schedule_shifts WHERE tenant_id = :t AND id = $1', [a.shift!.id]);
    else if (c.kind === 'UPDATE') await tx.exec(`UPDATE schedule_shifts SET start_slot = $2, length_slots = $3, activities = $4, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [a.shift!.id, c.startSlot, c.lengthSlots, JSON.stringify(c.activities)]);
    else await tx.exec(`INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source) VALUES (:t, $1, $2, $3, NULL, $4, $5, '[]', 'MANUAL')`, [o.versionId, w.employeeId, o.day, c.startSlot, c.lengthSlots]);
    const filled = o.filled + 1;
    await tx.exec(`UPDATE offer_invites SET status = 'ACCEPTED', responded_at = now() WHERE tenant_id = :t AND id = $1`, [inv.id]);
    await tx.exec(`UPDATE offers SET filled = $2, status = $3, updated_at = now() WHERE tenant_id = :t AND id = $1`, [id, filled, filled >= o.spots ? 'FILLED' : 'OPEN']);
    if (filled >= o.spots) await tx.exec(`UPDATE offer_invites SET status = 'EXPIRED' WHERE tenant_id = :t AND offer_id = $1 AND status IN ('QUEUED', 'INVITED')`, [id]);
    const summary = `${o.kind === 'VTO' ? 'Time off taken' : 'Overtime taken'}: ${w.emp.firstName} ${w.emp.lastName}, ${o.day} ${hhmm(o.startSlot)} to ${o.endSlot >= SPD ? '24:00' : hhmm(o.endSlot)}`;
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: o.versionId, entityName: 'Published schedule', diffSummary: summary, reason: o.note || undefined });
    return { status: 'ACCEPTED', apply: { versionId: o.versionId as string, summary } };
  });
  if (result.apply) {
    const st = await refreshStats(p.tenantId, result.apply.versionId);
    await withTenant(p.tenantId, (tx) => revision(tx, p, result.apply!.versionId, 'EDIT', result.apply!.summary, 'Voluntary offer accepted', st.stats));
    await dropCache(p.tenantId, 'sched:*');
    publish(p.tenantId, ['schedule', 'offer'], { id });
  }
  await advanceOffers(p.tenantId);
  res.json({ status: result.status });
}
offersMe.post('/:id/accept', requires('self:use'), (req, res) => answer(req, res, true));
offersMe.post('/:id/decline', requires('self:use'), (req, res) => answer(req, res, false));
