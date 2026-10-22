/**
 * Shift bidding: a manager opens a round with weekly patterns and a capacity for each, people rank the patterns they want in the app,
 * the round closes, and awarding it decides who gets what (seniority, lottery, or the best overall outcome) and builds a draft schedule
 * from the winning patterns. The draft goes through the normal review, validation and publish steps.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../../db.ts';
import { me, requires } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { bad, conflict, isoDay, notFound, parse } from '../../http.ts';
import { notify, usersOf } from '../../notify.ts';
import { addDays, dayRange } from '../forecast/service.ts';
import { loadCtx, placeActivities, refreshStats, requirementFor, revision, validateShifts, type PlacedShift, type ShiftRow } from '../scheduleRoutes.ts';
import { whoAmI } from '../selfService.ts';
import { hhmm } from '../workforceRoutes.ts';
import { METHODS, allocate, summarise, type Award, type Method } from './logic.ts';

export const bidsAdmin = Router();    // mounted at /scheduling/bids
export const bidsMe = Router();       // mounted at /me/bids
const uuid = z.string().uuid();
const SPD = 96;
const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const slotOf = (t: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t); return m ? Math.min(95, Math.floor((+m[1] * 60 + +m[2]) / 15)) : NaN; };
const isMonday = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd)).getUTCDay() === 1; };

// ---------------------------------------------------------------- what a pattern means

interface PatternRow { id: string; name: string; templateId: string; startSlot: number; workDays: number[]; capacity: number; position: number }
interface Tpl { id: string; name: string; lengthSlots: number; mealSlots: number }

const weeksOf = (r: any) => { const from = r.periodStart as string, to = addDays(from, r.weeks * 7 - 1); return { from, to, days: dayRange(from, to, 400) }; };
function shiftsOf(pattern: PatternRow, tpl: Tpl, employeeId: string, from: string, weeks: number): (ShiftRow & { dayIdx: number })[] {
  const out: (ShiftRow & { dayIdx: number })[] = [];
  for (let w = 0; w < weeks; w++) for (const d of pattern.workDays) { const i = w * 7 + d; out.push({ employeeId, day: addDays(from, i), dayIdx: i, startSlot: pattern.startSlot, lengthSlots: tpl.lengthSlots, templateId: tpl.id }); }
  return out;
}
const describe = (p: PatternRow, t: Tpl) => ({
  id: p.id, name: p.name, days: p.workDays.map((d) => DAY[d]), startTime: hhmm(p.startSlot), endTime: hhmm(p.startSlot + t.lengthSlots), overnight: p.startSlot + t.lengthSlots > SPD,
  paidHours: (t.lengthSlots - t.mealSlots) / 4, capacity: p.capacity, templateName: t.name,
});

async function load(tx: Tx, id: string) {
  const r = await tx.one<any>(`SELECT r.*, r.period_start::text AS period_start, g.name AS group_name FROM bid_rounds r JOIN wfm_groups g ON g.id = r.wfm_group_id WHERE r.tenant_id = :t AND r.id = $1`, [id]);
  if (!r) throw notFound('Bid round');
  const patterns = await tx.q<PatternRow>('SELECT id, name, template_id, start_slot, work_days, capacity, position FROM bid_patterns WHERE tenant_id = :t AND round_id = $1 ORDER BY position, name', [id]);
  const tpls = new Map((await tx.q<any>('SELECT * FROM shift_templates WHERE tenant_id = :t')).map((t) => [t.id, t as Tpl]));
  return { r, patterns, tpls };
}
const roundDto = (r: any, extra: Record<string, unknown> = {}) => ({
  id: r.id, groupId: r.wfmGroupId, groupName: r.groupName, name: r.name, status: r.status, method: r.method, periodStart: r.periodStart, weeks: r.weeks, fillUnranked: r.fillUnranked,
  closesAt: r.closesAt, awardedVersionId: r.awardedVersionId, createdBy: r.createdBy, createdAt: r.createdAt, ...extra,
});

/** Which patterns each person may hold: everything the scheduler would check, on the pattern's weeks, including the labour-law pack. */
async function fitsFor(tenantId: string, r: any, patterns: PatternRow[], tpls: Map<string, Tpl>) {
  const { from, to } = weeksOf(r);
  const ctx = await withTenant(tenantId, (tx) => loadCtx(tx, r.wfmGroupId, from, to));
  const people = (ctx.employees as any[]).filter((e) => e.status === 'ACTIVE');
  const fits = new Map<string, { ok: boolean; why: string }>();
  for (const e of people) for (const p of patterns) {
    const rows = shiftsOf(p, tpls.get(p.templateId)!, e.id, from, r.weeks);
    const bad1 = validateShifts(ctx, rows).find((v) => v.employeeId === e.id && v.severity !== 'WARN');
    fits.set(`${e.id}|${p.id}`, { ok: !bad1, why: bad1?.message ?? '' });
  }
  return { people, fits, ctx };
}

// ---------------------------------------------------------------- creating and running a round

const Body = z.object({
  groupId: uuid, name: z.string().trim().min(2).max(120), method: z.enum(METHODS as [Method, ...Method[]]).default('SENIORITY'), periodStart: z.string().regex(isoDay), weeks: z.number().int().min(1).max(26),
  fillUnranked: z.boolean().default(true), closesAt: z.string().datetime({ offset: true }).nullable().optional(),
  patterns: z.array(z.object({ name: z.string().trim().min(1).max(80), templateId: uuid, startTime: z.string(), workDays: z.array(z.number().int().min(0).max(6)).min(1).max(7), capacity: z.number().int().min(1).max(1000) })).min(1).max(40),
});

async function writePatterns(tx: Tx, roundId: string, b: z.infer<typeof Body>) {
  await tx.exec('DELETE FROM bid_patterns WHERE tenant_id = :t AND round_id = $1', [roundId]);
  let pos = 0;
  for (const p of b.patterns) {
    const s = slotOf(p.startTime);
    if (Number.isNaN(s)) throw bad(`Pattern "${p.name}": the start time must look like 08:30.`);
    if (!(await tx.one('SELECT 1 FROM shift_templates WHERE tenant_id = :t AND id = $1', [p.templateId]))) throw notFound('Shift template');
    await tx.exec('INSERT INTO bid_patterns (tenant_id, round_id, name, template_id, start_slot, work_days, capacity, position) VALUES (:t, $1, $2, $3, $4, $5, $6, $7)', [roundId, p.name, p.templateId, s, [...new Set(p.workDays)].sort(), p.capacity, pos++]);
  }
}
function checkRound(b: z.infer<typeof Body>) {
  if (!isMonday(b.periodStart)) throw bad('A bid covers whole weeks, so it must start on a Monday.');
}

bidsAdmin.post('/', requires('schedule:generate'), async (req, res) => {
  const p = me(req), b = parse(Body, req.body);
  checkRound(b);
  const id = await withTenant(p.tenantId, async (tx) => {
    if (!(await tx.one('SELECT 1 FROM wfm_groups WHERE tenant_id = :t AND id = $1', [b.groupId]))) throw notFound('WFM group');
    const r = (await tx.one<{ id: string }>(
      `INSERT INTO bid_rounds (tenant_id, wfm_group_id, name, method, period_start, weeks, fill_unranked, closes_at, seed, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [b.groupId, b.name, b.method, b.periodStart, b.weeks, b.fillUnranked, b.closesAt ?? null, Math.random().toString(36).slice(2), p.name]))!;
    await writePatterns(tx, r.id, b);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'BID_ROUND', entityId: r.id, entityName: b.name, after: { method: b.method, weeks: b.weeks, patterns: b.patterns.length } });
    return r.id;
  });
  res.status(201).json(await detail(p.tenantId, id));
});

bidsAdmin.put('/:id', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(Body, req.body);
  checkRound(b);
  await withTenant(p.tenantId, async (tx) => {
    const cur = await tx.one<any>('SELECT status FROM bid_rounds WHERE tenant_id = :t AND id = $1', [id]);
    if (!cur) throw notFound('Bid round');
    if (cur.status !== 'DRAFT') throw conflict('Only a round that has not opened can be changed.');
    await tx.exec('UPDATE bid_rounds SET wfm_group_id = $2, name = $3, method = $4, period_start = $5, weeks = $6, fill_unranked = $7, closes_at = $8, updated_at = now() WHERE tenant_id = :t AND id = $1', [id, b.groupId, b.name, b.method, b.periodStart, b.weeks, b.fillUnranked, b.closesAt ?? null]);
    await writePatterns(tx, id, b);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'BID_ROUND', entityId: id, entityName: b.name });
  });
  res.json(await detail(p.tenantId, id));
});

async function detail(tenantId: string, id: string) {
  const { r, patterns, tpls } = await withTenant(tenantId, (tx) => load(tx, id));
  const { people, fits } = await fitsFor(tenantId, r, patterns, tpls);
  return withTenant(tenantId, async (tx) => {
    const entries = await tx.q<any>('SELECT employee_id, pattern_id, rank FROM bid_entries WHERE tenant_id = :t AND round_id = $1', [id]);
    const bidders = new Set(entries.map((e) => e.employeeId));
    const first = new Map<string, number>();
    for (const e of entries) if (e.rank === 1) first.set(e.patternId, (first.get(e.patternId) ?? 0) + 1);
    const awards = await tx.q<any>(`SELECT a.employee_id, a.pattern_id, a.rank, e.first_name || ' ' || e.last_name AS name, e.employee_number FROM bid_awards a JOIN employees e ON e.id = a.employee_id WHERE a.tenant_id = :t AND a.round_id = $1 ORDER BY e.last_name, e.first_name`, [id]);
    const names = new Map(patterns.map((p) => [p.id, p.name]));
    return roundDto(r, {
      eligible: people.length, submitted: bidders.size,
      patterns: patterns.map((p) => ({ ...describe(p, tpls.get(p.templateId)!), firstChoices: first.get(p.id) ?? 0, canHold: people.filter((e) => fits.get(`${e.id}|${p.id}`)?.ok).length, awarded: awards.filter((a) => a.patternId === p.id).length })),
      awards: awards.map((a) => ({ employeeId: a.employeeId, name: a.name, employeeNumber: a.employeeNumber, patternId: a.patternId, patternName: a.patternId ? names.get(a.patternId) ?? null : null, rank: a.rank })),
    });
  });
}

async function setStatus(tenantId: string, id: string, from: string[], to: string) {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.one<any>('SELECT * FROM bid_rounds WHERE tenant_id = :t AND id = $1', [id]);
    if (!r) throw notFound('Bid round');
    if (!from.includes(r.status)) throw conflict(`This round is ${r.status.toLowerCase()}, so that is not possible now.`);
    await tx.exec('UPDATE bid_rounds SET status = $2, updated_at = now() WHERE tenant_id = :t AND id = $1', [id, to]);
    return r;
  });
}

bidsAdmin.post('/:id/open', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const r = await setStatus(p.tenantId, id, ['DRAFT'], 'OPEN');
  await withTenant(p.tenantId, async (tx) => {
    const emps = await tx.q<{ id: string }>(`SELECT id FROM employees WHERE tenant_id = :t AND status = 'ACTIVE' AND (primary_group_id = $1 OR $1 = ANY(eligible_group_ids))`, [r.wfmGroupId]);
    await notify(tx, await usersOf(tx, emps.map((e) => e.id)), { kind: 'BID', title: 'Shift bidding is open', body: `${r.name}: rank the patterns you would like.`, data: { screen: 'bid', id } });
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'BID_ROUND', entityId: id, entityName: r.name, diffSummary: 'opened for bids' });
  });
  res.json(await detail(p.tenantId, id));
});
bidsAdmin.post('/:id/close', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const r = await setStatus(p.tenantId, id, ['OPEN'], 'CLOSED');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'BID_ROUND', entityId: id, entityName: r.name, diffSummary: 'closed to new rankings' }));
  res.json(await detail(p.tenantId, id));
});
bidsAdmin.post('/:id/cancel', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const r = await setStatus(p.tenantId, id, ['DRAFT', 'OPEN', 'CLOSED'], 'CANCELLED');
  await withTenant(p.tenantId, (tx) => audit(tx, p, req, { action: 'UPDATE', entityType: 'BID_ROUND', entityId: id, entityName: r.name, diffSummary: 'cancelled' }));
  res.json(await detail(p.tenantId, id));
});

async function run(tenantId: string, id: string, methodOverride?: Method) {
  const { r, patterns, tpls } = await withTenant(tenantId, (tx) => load(tx, id));
  const { people, fits } = await fitsFor(tenantId, r, patterns, tpls);
  const entries = await withTenant(tenantId, (tx) => tx.q<any>('SELECT employee_id, pattern_id, rank FROM bid_entries WHERE tenant_id = :t AND round_id = $1 ORDER BY rank', [id]));
  const ranks = new Map<string, string[]>();
  for (const e of entries) ranks.set(e.employeeId, [...(ranks.get(e.employeeId) ?? []), e.patternId]);
  const method = methodOverride ?? (r.method as Method);
  const awards = allocate({
    bidders: people.map((e) => ({ id: e.id, employeeNumber: e.employeeNumber, hireDate: e.hireDate ?? null })), patterns: patterns.map((p) => ({ id: p.id, capacity: p.capacity })), ranks,
    fits: (e, p) => !!fits.get(`${e}|${p}`)?.ok, method, seed: r.seed || r.id, fillUnranked: r.fillUnranked,
  });
  return { r, patterns, tpls, people, awards, method };
}

/** What the allocation would give, without saving anything. */
bidsAdmin.get('/:id/preview', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ method: z.enum(METHODS as [Method, ...Method[]]).optional() }), req.query);
  const { patterns, people, awards, method } = await run(p.tenantId, id, q.method);
  const names = new Map(patterns.map((x) => [x.id, x.name])), who = new Map(people.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
  res.json({ method, summary: summarise(awards), awards: awards.map((a) => ({ employeeId: a.employeeId, name: who.get(a.employeeId), patternName: a.patternId ? names.get(a.patternId) : null, rank: a.rank })) });
});

/** Save the result and build a draft schedule from the winning patterns. */
bidsAdmin.post('/:id/award', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ method: z.enum(METHODS as [Method, ...Method[]]).optional() }), req.body ?? {});
  const cur = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT status FROM bid_rounds WHERE tenant_id = :t AND id = $1', [id]));
  if (!cur) throw notFound('Bid round');
  if (cur.status !== 'CLOSED') throw conflict(cur.status === 'OPEN' ? 'Close the round first, so nobody can change their ranking while it is decided.' : `This round is ${cur.status.toLowerCase()}.`);
  const { r, patterns, tpls, awards, method } = await run(p.tenantId, id, q.method);
  const { from, to, days } = weeksOf(r);
  const chosen: PlacedShift[] = [];
  const byPattern = new Map(patterns.map((x) => [x.id, x]));
  for (const a of awards) if (a.patternId) for (const s of shiftsOf(byPattern.get(a.patternId)!, tpls.get(byPattern.get(a.patternId)!.templateId)!, a.employeeId, from, r.weeks)) {
    chosen.push({ employeeId: a.employeeId, day: s.day, dayIdx: s.dayIdx, startSlot: s.startSlot, length: s.lengthSlots, template: raw2(tpls, s.templateId!) });
  }
  const acts = placeActivities(chosen, days.length * SPD);
  const fv = await requirementFor(p.tenantId, r.wfmGroupId, days).then((x) => x.v.id as string).catch(() => null);
  const versionId = await withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`sv:${r.wfmGroupId}`]);
    const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1', [r.wfmGroupId]))!.n;
    const name = `${r.name} · bid result · ${r.weeks} wk from ${from}`;
    const v = (await tx.one<any>(
      `INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, period_start, period_end, forecast_version_id, settings, stats, created_by) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, '{}', $8) RETURNING id`,
      [r.wfmGroupId, seq, name, from, to, fv, JSON.stringify({ bidRoundId: id, method }), p.name]))!;
    if (chosen.length) await tx.exec(
      `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source)
       SELECT :t, $1, x.e, x.d, x.tp, x.s, x.l, x.a::jsonb, 'MANUAL' FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::int[], $6::int[], $7::text[]) AS x(e, d, tp, s, l, a)`,
      [v.id, chosen.map((s) => s.employeeId), chosen.map((s) => s.day), chosen.map((s) => s.template.id), chosen.map((s) => s.startSlot), chosen.map((s) => s.length), chosen.map((s) => JSON.stringify(acts.get(s) ?? []))]);
    await tx.exec('DELETE FROM bid_awards WHERE tenant_id = :t AND round_id = $1', [id]);
    for (const a of awards) await tx.exec('INSERT INTO bid_awards (tenant_id, round_id, employee_id, pattern_id, rank) VALUES (:t, $1, $2, $3, $4)', [id, a.employeeId, a.patternId, a.rank]);
    await tx.exec(`UPDATE bid_rounds SET status = 'AWARDED', method = $2, awarded_version_id = $3, updated_at = now() WHERE tenant_id = :t AND id = $1`, [id, method, v.id]);
    const names = new Map(patterns.map((x) => [x.id, x.name]));
    for (const a of awards) await notify(tx, await usersOf(tx, [a.employeeId]), {
      kind: 'BID', title: a.patternId ? 'Your shift pattern' : 'Shift bidding result',
      body: a.patternId ? `${r.name}: you got "${names.get(a.patternId)}"${a.rank ? ` (choice ${a.rank})` : ''}. It becomes final when the schedule is published.` : `${r.name}: no pattern could be given to you. Your manager will be in touch.`, data: { screen: 'bid', id },
    });
    await audit(tx, p, req, { action: 'GENERATE', entityType: 'SCHEDULE_VERSION', entityId: v.id, entityName: name, diffSummary: `built from bid round "${r.name}" (${method.toLowerCase()})`, after: summarise(awards) });
    return v.id as string;
  });
  const live = await refreshStats(p.tenantId, versionId);
  await withTenant(p.tenantId, (tx) => revision(tx, p, versionId, 'GENERATE', `Built from the result of bid round "${r.name}"`, null, live.stats));
  res.json({ versionId, summary: summarise(awards), round: await detail(p.tenantId, id) });
});
const raw2 = (tpls: Map<string, Tpl>, id: string) => tpls.get(id) as any;

bidsAdmin.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  await closeDueBids(p.tenantId);
  const rows = await withTenant(p.tenantId, (tx) => tx.q<any>(
    `SELECT r.*, r.period_start::text AS period_start, g.name AS group_name, (SELECT count(DISTINCT employee_id)::int FROM bid_entries e WHERE e.round_id = r.id) AS submitted,
            (SELECT count(*)::int FROM bid_patterns bp WHERE bp.round_id = r.id) AS pattern_count FROM bid_rounds r JOIN wfm_groups g ON g.id = r.wfm_group_id WHERE r.tenant_id = :t ORDER BY r.created_at DESC LIMIT 60`));
  res.json(rows.map((r) => roundDto(r, { submitted: r.submitted, patternCount: r.patternCount })));
});
bidsAdmin.get('/:id', requires('schedule:read'), async (req, res) => { const p = me(req), id = parse(uuid, req.params.id); await closeDueBids(p.tenantId); res.json(await detail(p.tenantId, id)); });

/** A round with a closing time closes itself when the time passes. */
export async function closeDueBids(tenantId: string): Promise<void> {
  await withTenant(tenantId, (tx) => tx.exec(`UPDATE bid_rounds SET status = 'CLOSED', updated_at = now() WHERE tenant_id = :t AND status = 'OPEN' AND closes_at IS NOT NULL AND closes_at < now()`));
}
let timer: ReturnType<typeof setInterval> | null = null;
export function startBidTicker() {
  if (timer) return;
  timer = setInterval(async () => { try { for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) await closeDueBids(t.id); } catch (e) { console.error('[bids]', (e as Error).message); } }, 60_000);
  timer.unref();
}

// ---------------------------------------------------------------- the person's side

bidsMe.get('/', requires('self:use'), async (req, res) => {
  const p = me(req);
  await closeDueBids(p.tenantId);
  const rounds = await withTenant(p.tenantId, async (tx) => {
    const w = await whoAmI(tx, p);
    const list = await tx.q<any>(
      `SELECT r.id FROM bid_rounds r WHERE r.tenant_id = :t AND r.status IN ('OPEN', 'CLOSED', 'AWARDED') AND r.created_at > now() - interval '90 days'
         AND ($1::uuid = r.wfm_group_id OR r.wfm_group_id = ANY($2::uuid[])) ORDER BY (r.status = 'OPEN') DESC, r.created_at DESC LIMIT 6`, [w.emp.primaryGroupId, w.emp.eligibleGroupIds ?? []]);
    return { w, ids: list.map((x) => x.id as string) };
  });
  const out = [];
  for (const id of rounds.ids) {
    const { r, patterns, tpls } = await withTenant(p.tenantId, (tx) => load(tx, id));
    const { fits } = await fitsFor(p.tenantId, r, patterns, tpls);
    const mine = await withTenant(p.tenantId, async (tx) => ({
      ranking: (await tx.q<any>('SELECT pattern_id FROM bid_entries WHERE tenant_id = :t AND round_id = $1 AND employee_id = $2 ORDER BY rank', [id, rounds.w.employeeId])).map((e) => e.patternId as string),
      award: await tx.one<any>('SELECT pattern_id, rank FROM bid_awards WHERE tenant_id = :t AND round_id = $1 AND employee_id = $2', [id, rounds.w.employeeId]),
    }));
    out.push(roundDto(r, {
      patterns: patterns.map((x) => ({ ...describe(x, tpls.get(x.templateId)!), fits: fits.get(`${rounds.w.employeeId}|${x.id}`)?.ok ?? false, why: fits.get(`${rounds.w.employeeId}|${x.id}`)?.why ?? '' })),
      myRanking: mine.ranking, myAward: r.status === 'AWARDED' ? { patternId: mine.award?.patternId ?? null, patternName: patterns.find((x) => x.id === mine.award?.patternId)?.name ?? null, rank: mine.award?.rank ?? null } : null,
    }));
  }
  res.json(out);
});

bidsMe.put('/:id/ranking', requires('self:use'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(z.object({ patternIds: z.array(uuid).max(40) }), req.body);
  if (new Set(b.patternIds).size !== b.patternIds.length) throw bad('Each pattern can be ranked once.');
  const { r, patterns, tpls } = await withTenant(p.tenantId, (tx) => load(tx, id));
  if (r.status !== 'OPEN') throw conflict(r.status === 'DRAFT' ? 'Bidding has not opened yet.' : 'Bidding is closed. Your ranking is final.');
  if (r.closesAt && new Date(r.closesAt) < new Date()) throw conflict('Bidding has just closed.');
  const w = await withTenant(p.tenantId, (tx) => whoAmI(tx, p));
  if (!(w.emp.primaryGroupId === r.wfmGroupId || (w.emp.eligibleGroupIds ?? []).includes(r.wfmGroupId))) throw bad('This round is not for your group.');
  const { fits } = await fitsFor(p.tenantId, r, patterns, tpls);
  const known = new Set(patterns.map((x) => x.id));
  for (const pid of b.patternIds) {
    if (!known.has(pid)) throw bad('One of those patterns is not part of this round.');
    const f = fits.get(`${w.employeeId}|${pid}`);
    if (!f?.ok) throw bad(`"${patterns.find((x) => x.id === pid)!.name}" cannot be given to you: ${f?.why || 'it does not fit your rules.'}`);
  }
  await withTenant(p.tenantId, async (tx) => {
    await tx.exec('DELETE FROM bid_entries WHERE tenant_id = :t AND round_id = $1 AND employee_id = $2', [id, w.employeeId]);
    for (let i = 0; i < b.patternIds.length; i++) await tx.exec('INSERT INTO bid_entries (tenant_id, round_id, employee_id, pattern_id, rank) VALUES (:t, $1, $2, $3, $4)', [id, w.employeeId, b.patternIds[i], i + 1]);
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'BID_ROUND', entityId: id, entityName: r.name, diffSummary: `${w.emp.firstName} ${w.emp.lastName} ranked ${b.patternIds.length} pattern(s)` });
  });
  res.json({ ok: true, ranked: b.patternIds.length });
});
