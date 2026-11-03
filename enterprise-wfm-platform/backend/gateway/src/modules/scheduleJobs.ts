/**
 * Long schedules: built in the background, window by window, and published a window at a time.
 *
 *  - A job (schedule_jobs) is a durable queue entry. Any gateway instance claims it (FOR UPDATE SKIP LOCKED), reports progress as it goes, can be
 *    cancelled (the solve stops inside the engine), and goes back in the queue if its worker disappears.
 *  - A PLAN job solves the first weeks window by window (each window starts from what the one before it left: rest, days in a row, weekend
 *    counts), then repeats the last solved cycle for the weeks after them ("rotation lines", source PATTERN) so a year has a shape long before
 *    its demand is known. Time off and availability are applied to the repeated shifts first.
 *  - A RESOLVE job re-solves the weeks that are not locked on today's forecast and keeps everything locked, manual or already worked untouched.
 *  - Publishing can stop at a date (publish_through): the weeks up to it are locked and live, the rest stay planned.
 */
import os from 'node:os';
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../db.ts';
import { me, requires, type Principal } from '../auth.ts';
import { audit } from '../audit.ts';
import { HttpError, bad, conflict, isoDay, notFound, parse } from '../http.ts';
import { dropCache, engine, publish } from '../infra.ts';
import { addDays, dayRange, loadGroup, todayIn, versionRecords } from './forecast/service.ts';
import {
  GenBody, VER_SQL, invalidateLive, blockedReason, saveGenerated, computeStats, dowOf, insertGenerated, liveStats, loadCtx, loadVersion, mondayOf, publishChecks, requirementFor, requirementForManual, revision, runGenerate, settingsOf, shiftsOf, verDto,
  type GenInput, type Generated,
} from './scheduleRoutes.ts';
import { paidSlots } from './templateRules.ts';
import { matchWeeks } from './weekMatch.ts';
export { matchWeeks } from './weekMatch.ts';

const uuid = z.string().uuid();
const SPD = 96;
const WORKER = `${os.hostname()}:${process.pid}`;
const MAX_WEEKS = 52;

// ---------------------------------------------------------------- what a plan asks for

export const PlanBody = GenBody.extend({
  weeks: z.number().int().min(1).max(MAX_WEEKS),
  windowWeeks: z.number().int().min(1).max(4).default(4),              // weeks solved together; each window starts from the one before it
  solveWeeks: z.number().int().min(1).max(MAX_WEEKS).optional(),        // weeks the solver builds; the rest repeat the last solved cycle. Default: up to 13 weeks.
});
export type PlanInput = z.infer<typeof PlanBody>;

/** The windows the solver builds, in order. */
export function windowsOf(from: string, solveWeeks: number, windowWeeks: number) {
  const out: { from: string; to: string; weeks: number }[] = [];
  for (let w = 0; w < solveWeeks; w += windowWeeks) {
    const n = Math.min(windowWeeks, solveWeeks - w);
    out.push({ from: addDays(from, w * 7), to: addDays(from, (w + n) * 7 - 1), weeks: n });
  }
  return out;
}
export const solveWeeksOf = (b: { weeks: number; solveWeeks?: number }) => Math.min(b.weeks, b.solveWeeks ?? Math.min(b.weeks, 13));

/** Seconds a plan is expected to take: each window's search time plus the time to prepare its model, which grows with the crew. A rough guide, not a promise. */
export function estimateSeconds(people: number, b: { weeks: number; windowWeeks: number; timeLimitSec: number; solveWeeks?: number }) {
  const solve = solveWeeksOf(b);
  let sec = 0;
  for (const w of windowsOf('2000-01-03', solve, b.windowWeeks)) sec += b.timeLimitSec * 1.1 + 0.02 * people * w.weeks * 7 / 7 * w.weeks + 3;
  return Math.round(sec + (b.weeks > solve ? 5 + people * 0.01 : 0) + 10);
}

// ---------------------------------------------------------------- jobs table

interface Job { id: string; orgId: string; wfmGroupId: string; kind: 'PLAN' | 'RESOLVE'; status: string; params: any; actor: Principal; progress: any; versionId: string | null; error: string | null; cancelRequested: boolean; attempts: number; createdAt: string; startedAt: string | null; finishedAt: string | null }
const jobDto = (j: Job) => ({ id: j.id, groupId: j.wfmGroupId, kind: j.kind, status: j.status, progress: j.progress, versionId: j.versionId, error: j.error, cancelRequested: j.cancelRequested, createdAt: j.createdAt, startedAt: j.startedAt, finishedAt: j.finishedAt, createdBy: j.actor?.name ?? null, params: { from: j.params?.from ?? null, weeks: j.params?.weeks ?? null, versionId: j.params?.versionId ?? null } });

const running = new Map<string, AbortController>();

/** A running job whose heartbeat is older than this is taken to have died. Long enough to ride out a laptop sleeping or a busy stretch; the process running a job is never judged by it. */
const STALE_SECONDS = Math.max(30, Number(process.env.SCHEDULE_JOB_STALE_SECONDS || 120));
/** Jobs another worker has taken over while this one was still running them: they stop and write nothing more. */
const lost = new Set<string>();

async function setProgress(jobId: string, patch: Record<string, unknown>): Promise<boolean> {
  const r = await raw<{ cancelRequested: boolean }>(`UPDATE schedule_jobs SET progress = progress || $2::jsonb, heartbeat_at = now() WHERE id = $1 AND worker = $3 AND status = 'RUNNING' RETURNING cancel_requested`, [jobId, JSON.stringify(patch), WORKER]);
  if (!r[0]) { lost.add(jobId); running.get(jobId)?.abort(); return false; }       // no longer ours (or cancelled outright): stop working on it
  return !!r[0].cancelRequested;
}
const cancelled = (e: any) => e?.code === 'CANCELLED' || e?.name === 'AbortError';

// ---------------------------------------------------------------- building

interface Win { from: string; to: string; kind: 'SOLVED' | 'PATTERN'; coverage: number | null; backend: string | null; status: string; shifts: number; note?: string }

/** Weekend shifts each person has worked so far in a schedule, so fairness carries from one window to the next. */
async function weekendCounts(tx: Tx, versionId: string, before: string) {
  const rows = await tx.q<{ employeeId: string; n: number }>(`SELECT employee_id, count(*)::int AS n FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day < $2::date AND extract(isodow FROM day) >= 6 GROUP BY employee_id`, [versionId, before]);
  return new Map(rows.map((r) => [r.employeeId, r.n]));
}

/**
 * Repeat a solved cycle over `fillFrom..fillTo`: day D takes the shifts of the matching day of the cycle. A repeated shift is dropped when the person
 * has time off or is unavailable that day, or when it would break their rest, days in a row or weekly hours next to what is already there.
 */
async function fillPattern(p: Principal, versionId: string, groupId: string, cycleFrom: string, cycleTo: string, fillFrom: string, fillTo: string, weekStart: number, match?: { source: 'FORECAST' | 'MANUAL'; confidence: number }) {
  if (fillFrom > fillTo) return { shifts: 0, dropped: 0, matched: 0, weeks: 0, lowFit: [] as string[] };
  const { ctx, cycle, around } = await withTenant(p.tenantId, async (tx) => ({
    ctx: { ...(await loadCtx(tx, groupId, fillFrom, fillTo)), weekStart },
    cycle: await tx.q<any>(`SELECT employee_id, day::text AS day, template_id, start_slot, length_slots, activities FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day >= $2::date AND day <= $3::date AND source <> 'MANUAL'`, [versionId, cycleFrom, cycleTo]),
    around: await tx.q<any>(`SELECT employee_id, day::text AS day, start_slot, length_slots, template_id FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day >= $2::date - 8 AND day <= $3::date`, [versionId, fillFrom, fillTo]),
  }));
  const cycleDays = dayRange(cycleFrom, cycleTo);
  // each repeated week copies the solved week whose demand looks most like it (when the cycle is whole weeks and a forecast can say what demand is)
  const fillDays = dayRange(fillFrom, fillTo);
  let weekOf: number[] | null = null, matched = 0, lowFit: string[] = [];
  if (match && cycleDays.length % 7 === 0 && cycleDays.length >= 14) {
    const [cd, td] = await Promise.all([demandByDay(p.tenantId, groupId, cycleDays, match.source, match.confidence), demandByDay(p.tenantId, groupId, fillDays, match.source, match.confidence)]);
    const chunk = (a: number[], n: number) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
    const cw = chunk(cd, 7), tw = chunk(td, 7);
    if (cd.some((x) => x > 0) && td.some((x) => x > 0)) {
      const m = matchWeeks(cw, tw.map((w) => [...w, ...new Array(7 - w.length).fill(0)]));
      weekOf = m.source; matched = m.changed;
      lowFit = m.distance.map((d, k) => (d > 0.2 ? addDays(fillFrom, k * 7) : '')).filter(Boolean);   // weeks whose demand no solved week resembles: worth solving properly
    }
  }
  const byDay = new Map<string, any[]>();
  for (const s of cycle) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  const emp = new Map(ctx.employees.map((e) => [e.id, e]));
  const tpl = new Map(ctx.templates.map((t) => [t.id, t]));
  const placed = new Map<string, Map<string, { start: number; len: number }>>();     // employee -> day -> shift, what is already there and what this adds
  for (const s of around) { const m = placed.get(s.employeeId) ?? new Map(); m.set(s.day, { start: s.startSlot, len: s.lengthSlots }); placed.set(s.employeeId, m); }
  const weekPaid = new Map<string, number>();
  for (const s of around) if (s.day >= mondayOf(fillFrom, weekStart)) weekPaid.set(`${s.employeeId}|${mondayOf(s.day, weekStart)}`, (weekPaid.get(`${s.employeeId}|${mondayOf(s.day, weekStart)}`) ?? 0) + paidSlots(tpl.get(s.templateId), s.lengthSlots));
  const out: { e: string; d: string; tp: string | null; s: number; l: number; a: string }[] = [];
  let dropped = 0;
  for (const D of dayRange(fillFrom, fillTo)) {
    const off = dayRange(cycleFrom, D).length - 1, rel = off - cycleDays.length;
    const src = weekOf && rel >= 0 ? cycleDays[weekOf[Math.floor(rel / 7)] * 7 + (rel % 7)] : cycleDays[((off % cycleDays.length) + cycleDays.length) % cycleDays.length];
    for (const sh of byDay.get(src) ?? []) {
      const e = emp.get(sh.employeeId);
      const mine = placed.get(sh.employeeId) ?? new Map();
      if (!e || e.status !== 'ACTIVE' || mine.has(D)) { if (!mine.has(D)) dropped++; continue; }
      if (blockedReason(ctx, e, D, sh.startSlot, sh.lengthSlots)) { dropped++; continue; }
      const prev = mine.get(addDays(D, -1));
      if (prev && SPD + sh.startSlot - (prev.start + prev.len) < Math.round(Number(e.minRestHours) * 4)) { dropped++; continue; }
      const next = mine.get(addDays(D, 1));
      if (next && SPD + next.start - (sh.startSlot + sh.lengthSlots) < Math.round(Number(e.minRestHours) * 4)) { dropped++; continue; }
      let run = 1;
      for (let k = 1; mine.has(addDays(D, -k)); k++) run++;
      for (let k = 1; mine.has(addDays(D, k)); k++) run++;
      if (run > e.maxConsecutiveDays) { dropped++; continue; }
      const wk = `${sh.employeeId}|${mondayOf(D, weekStart)}`, paid = paidSlots(tpl.get(sh.templateId), sh.lengthSlots);
      if ((weekPaid.get(wk) ?? 0) + paid > Number(e.maxWeeklyHours) * 4) { dropped++; continue; }
      weekPaid.set(wk, (weekPaid.get(wk) ?? 0) + paid);
      mine.set(D, { start: sh.startSlot, len: sh.lengthSlots });
      placed.set(sh.employeeId, mine);
      out.push({ e: sh.employeeId, d: D, tp: sh.templateId, s: sh.startSlot, l: sh.lengthSlots, a: JSON.stringify(sh.activities ?? []) });
    }
  }
  if (out.length) await withTenant(p.tenantId, (tx) => tx.exec(
    `INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source)
     SELECT :t, $1, x.e, x.d, x.tp, x.s, x.l, x.a::jsonb, 'PATTERN' FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::int[], $6::int[], $7::text[]) AS x(e, d, tp, s, l, a)`,
    [versionId, out.map((x) => x.e), out.map((x) => x.d), out.map((x) => x.tp), out.map((x) => x.s), out.map((x) => x.l), out.map((x) => x.a)]));
  return { shifts: out.length, dropped, matched, weeks: weekOf ? weekOf.length : 0, lowFit };
}

/** Calls-worth of work expected on each day (the staffing requirement summed over the day), for matching a week to a solved week. */
async function demandByDay(tenantId: string, groupId: string, days: string[], source: 'FORECAST' | 'MANUAL', confidence = 50): Promise<number[]> {
  try {
    const r = source === 'MANUAL' ? await requirementForManual(tenantId, groupId, days) : await requirementFor(tenantId, groupId, days, undefined, confidence);
    return days.map((_, i) => { let t = 0; for (let g = i * SPD; g < (i + 1) * SPD; g++) t += r.required[g] ?? 0; return t; });
  } catch { return days.map(() => 0); }
}

const noForecast = (e: any) => /does not cover|no published short-term or long-term forecast/i.test(String(e?.message ?? ''));

async function runPlan(job: Job, ctl: AbortController) {
  const p = job.actor, b = PlanBody.parse(job.params);
  const solve = solveWeeksOf(b), wins = windowsOf(b.from, solve, b.windowWeeks), to = addDays(b.from, b.weeks * 7 - 1);
  const t0 = Date.now(), summary: Win[] = [];
  let firstGen: Generated | null = null, lastGen: Generated | null = null, vid: string | null = null, stop = false;
  const total = wins.length + 1;
  const step = async (done: number, note: string, extra: Record<string, unknown> = {}) => {
    const eta = done > 0 ? Math.round(((Date.now() - t0) / done) * (total - done) / 1000) : null;
    if (await setProgress(job.id, { done, total, note, etaSec: eta, windows: summary, ...extra })) ctl.abort();
  };
  try {
    await step(0, 'Preparing');
    for (let k = 0; k < wins.length; k++) {
      if (ctl.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      const w = wins[k];
      let g: Generated;
      try {
        const prior = k > 0 ? await withTenant(p.tenantId, (tx) => weekendCounts(tx, vid!, w.from)) : undefined;
        g = await runGenerate(p, { ...b, from: w.from, weeks: w.weeks, name: undefined, assumeRepeat: b.weeks === 1 ? b.assumeRepeat : false, useHistory: k > 0 ? true : b.useHistory },
          { historyVersionId: k > 0 ? vid! : undefined, priorWeekend: prior, signal: ctl.signal, onProgress: (d, t, note) => { void step(k + (t ? d / t : 0), `Window ${k + 1} of ${wins.length}: ${note}`); } });
      } catch (e: any) {
        if (cancelled(e)) throw e;
        if (k > 0 && noForecast(e)) { summary.push({ from: w.from, to, kind: 'PATTERN', coverage: null, backend: null, status: 'NO_FORECAST', shifts: 0, note: 'No forecast reaches this far; the last solved cycle is repeated instead.' }); stop = true; break; }
        throw e;
      }
      if (!vid) {                                                  // the schedule exists from the first window on, so a refresh or a crash never loses it
        vid = await withTenant(p.tenantId, async (tx) => {
          await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`sv:${b.groupId}`]);
          const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1', [b.groupId]))!.n;
          const name = b.name || `Plan v${seq} · ${b.weeks} wk from ${b.from}`;
          const v = await tx.one<any>(
            `INSERT INTO schedule_versions (tenant_id, wfm_group_id, seq, name, period_start, period_end, forecast_version_id, coverage_source, settings, stats, created_by)
             VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, '{}', $9) RETURNING id`,
            [b.groupId, seq, name, b.from, to, g.fv?.id ?? null, b.coverageSource, JSON.stringify({ ...settingsOf(g), plan: { status: 'BUILDING' } }), p.name]);
          await tx.exec('UPDATE schedule_jobs SET version_id = $2 WHERE id = $1', [job.id, v!.id]);
          return v!.id as string;
        });
        firstGen = g;
      }
      await withTenant(p.tenantId, (tx) => insertGenerated(tx, vid!, g));
      lastGen = g;
      summary.push({ from: w.from, to: w.to, kind: 'SOLVED', coverage: g.stats.coverage.percent, backend: g.solver.backend, status: g.solver.status, shifts: g.chosen.length, note: g.solver.attempts?.length > 1 ? g.solver.attempts.join('; ') : undefined });
      await step(k + 1, `Window ${k + 1} of ${wins.length} done`);
    }
    if (!vid || !lastGen || !firstGen) throw bad('Nothing could be built.');
    const solvedThrough = summary.filter((s) => s.kind === 'SOLVED').at(-1)!.to;
    let patternFrom: string | null = null, cycleDays = 0, dropped = 0;
    if (solvedThrough < to) {
      const lastWin = summary.filter((s) => s.kind === 'SOLVED').at(-1)!;
      await step(wins.length, 'Repeating the last solved cycle for the remaining weeks');
      patternFrom = addDays(solvedThrough, 1);
      cycleDays = dayRange(lastWin.from, lastWin.to).length;
      const r = await fillPattern(p, vid, b.groupId, lastWin.from, lastWin.to, patternFrom, to, lastGen.weekStart, { source: b.coverageSource, confidence: b.confidence });
      dropped = r.dropped;
      summary.push({ from: patternFrom, to, kind: 'PATTERN', coverage: null, backend: null, status: 'REPEATED', shifts: r.shifts,
        note: `${r.dropped} repeated shifts were left out because of time off, availability or rest rules.${r.matched ? ` ${r.matched} of ${r.weeks} weeks copy a different solved week because its demand fits better.` : ''}${r.lowFit.length ? ` ${r.lowFit.length} week${r.lowFit.length === 1 ? '' : 's'} (first: ${r.lowFit[0]}) look unlike any solved week and should be solved properly.` : ''}` });
    }
    const v0 = await withTenant(p.tenantId, (tx) => loadVersion(tx, vid!));
    const live = await liveStats(p.tenantId, v0, true);
    await withTenant(p.tenantId, async (tx) => {
      await tx.exec('UPDATE schedule_versions SET stats = $2, settings = settings || $3::jsonb WHERE tenant_id = :t AND id = $1',
        [vid, JSON.stringify({ ...live.stats, solver: lastGen!.solver }), JSON.stringify({ report: lastGen!.report, plan: { status: 'READY', windowWeeks: b.windowWeeks, solveWeeks: solve, weeks: b.weeks, windows: summary, solvedThrough, patternFrom, cycleDays, dropped, lastGenerated: new Date().toISOString() } })]);
      await audit(tx, p, null, { action: 'GENERATE', entityType: 'SCHEDULE_VERSION', entityId: vid!, entityName: v0.name, after: { weeks: b.weeks, solvedWeeks: solve, coverage: live.stats.coverage.percent, shifts: live.stats.shifts } });
      await revision(tx, p, vid!, 'GENERATE', `Plan built: ${b.weeks} weeks (${solve} solved${patternFrom ? `, the rest repeated from the last cycle` : ''})`, null, live.stats);
    });
    await raw(`UPDATE schedule_jobs SET status = $2, finished_at = now(), version_id = $3, progress = progress || $4::jsonb WHERE id = $1 AND worker = $5 AND status = 'RUNNING'`, [job.id, 'DONE', vid, JSON.stringify({ done: total, total, note: 'Done', etaSec: 0, windows: summary }), WORKER]);
    publish(p.tenantId, ['schedule', 'generated'], { id: vid, name: v0.name, by: p.name });
  } catch (e) {
    if (vid) await withTenant(p.tenantId, (tx) => tx.exec('DELETE FROM schedule_versions WHERE tenant_id = :t AND id = $1', [vid])).catch(() => {});   // a half-built plan is not kept
    throw e;
  }
}

// ---------------------------------------------------------------- rolling re-solve

const ResolveBody = z.object({
  versionId: uuid, from: z.string().regex(isoDay).optional(), weeks: z.number().int().min(1).max(MAX_WEEKS).default(4),
  windowWeeks: z.number().int().min(1).max(4).default(4), timeLimitSec: z.number().int().min(3).max(120).optional(), solver: GenBody.shape.solver.optional(),
  repattern: z.boolean().default(true),                    // repeat the new last cycle over the weeks after the re-solved ones
});

async function runResolve(job: Job, ctl: AbortController) {
  const p = job.actor, r = ResolveBody.parse(job.params);
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, r.versionId));
  if (v.kind !== 'DEMAND') throw bad('Only a demand-based schedule can be re-solved. Rotation schedules follow their pattern.');
  if (v.status === 'ARCHIVED') throw conflict('An archived schedule cannot be changed.');
  if (v.status === 'PUBLISHED' && !v.publishThrough) throw conflict('This schedule is published in full. Publish it up to a date first, then the weeks after that date can be re-solved.');
  const tz = (await withTenant(p.tenantId, (tx) => tx.one<{ timezone: string }>('SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1', [v.wfmGroupId])))?.timezone ?? 'UTC';
  const weekStart = v.settings?.weekStart ?? 0, today = todayIn(tz);
  let start = [r.from, v.periodStart, addDays(today, 1), v.publishThrough ? addDays(v.publishThrough, 1) : null].filter(Boolean).sort().at(-1) as string;
  const aligned = mondayOf(start, weekStart);
  if (aligned < start) start = addDays(aligned, 7);
  if (start > v.periodEnd) throw bad('Nothing is left to re-solve: every remaining week is locked or already over.');
  const end = addDays(start, r.weeks * 7 - 1) > v.periodEnd ? v.periodEnd : addDays(start, r.weeks * 7 - 1);
  const solveWeeks = Math.ceil((dayRange(start, end).length) / 7);
  const wins = windowsOf(start, solveWeeks, r.windowWeeks).map((w) => ({ ...w, to: w.to > end ? end : w.to }));
  const s = v.settings ?? {};
  const base: GenInput = GenBody.parse({
    groupId: v.wfmGroupId, from: start, weeks: 1, coverageSource: v.coverageSource ?? 'FORECAST', templateIds: s.templateIds, weights: s.weights, consistentTimes: s.consistentTimes,
    timeLimitSec: r.timeLimitSec ?? s.timeLimitSec ?? 30, confidence: s.confidence ?? 50, weekStart, solver: r.solver ?? s.solverChoice ?? 'AUTO', useHistory: true,
  });
  const t0 = Date.now(), summary: Win[] = [], total = wins.length + 1;
  const step = async (done: number, note: string) => {
    const eta = done > 0 ? Math.round(((Date.now() - t0) / done) * (total - done) / 1000) : null;
    if (await setProgress(job.id, { done, total, note, etaSec: eta, windows: summary })) ctl.abort();
  };
  await step(0, `Re-solving ${start} to ${end}`);
  let last: Generated | null = null, fvId: string | null = null, fvRev: number | null = null;
  for (let k = 0; k < wins.length; k++) {
    if (ctl.signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
    const w = wins[k], n = Math.ceil(dayRange(w.from, w.to).length / 7);
    const pinned = await withTenant(p.tenantId, (tx) => tx.q<any>(`SELECT employee_id, day::text AS day, start_slot, length_slots FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day >= $2::date AND day <= $3::date AND source = 'MANUAL'`, [v.id, w.from, w.to]));
    const prior = await withTenant(p.tenantId, (tx) => weekendCounts(tx, v.id, w.from));
    const g = await runGenerate(p, { ...base, from: w.from, weeks: n }, {
      historyVersionId: v.id, priorWeekend: prior, signal: ctl.signal, pinned: pinned.map((x) => ({ employeeId: x.employeeId, day: x.day, startSlot: x.startSlot, lengthSlots: x.lengthSlots })),
      onProgress: (d, t, note) => { void step(k + (t ? d / t : 0), `Window ${k + 1} of ${wins.length}: ${note}`); },
    });
    await withTenant(p.tenantId, async (tx) => {                     // swap this window's planned shifts for the new ones in one step
      await tx.exec(`DELETE FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day >= $2::date AND day <= $3::date AND source IN ('SOLVER', 'PATTERN')`, [v.id, w.from, w.to]);
      await insertGenerated(tx, v.id, g);
    });
    last = g; fvId = g.fv?.id ?? fvId; fvRev = g.fv?.rev ?? fvRev;
    summary.push({ from: w.from, to: w.to, kind: 'SOLVED', coverage: g.stats.coverage.percent, backend: g.solver.backend, status: g.solver.status, shifts: g.chosen.length });
    await step(k + 1, `Window ${k + 1} of ${wins.length} done`);
  }
  let patternNote = '';
  if (r.repattern && end < v.periodEnd && last) {
    await step(wins.length, 'Repeating the new cycle for the weeks after');
    await withTenant(p.tenantId, (tx) => tx.exec(`DELETE FROM schedule_shifts WHERE tenant_id = :t AND version_id = $1 AND day > $2::date AND source = 'PATTERN'`, [v.id, end]));
    const lastWin = wins.at(-1)!;
    const f = await fillPattern(p, v.id, v.wfmGroupId, lastWin.from, lastWin.to, addDays(end, 1), v.periodEnd, weekStart, { source: v.coverageSource ?? 'FORECAST', confidence: s.confidence ?? 50 });
    summary.push({ from: addDays(end, 1), to: v.periodEnd, kind: 'PATTERN', coverage: null, backend: null, status: 'REPEATED', shifts: f.shifts, note: f.matched ? `${f.matched} of ${f.weeks} weeks copy a different solved week because its demand fits better.` : undefined });
    patternNote = ` and repeated the new cycle to ${v.periodEnd}`;
  }
  const v1 = await withTenant(p.tenantId, (tx) => loadVersion(tx, v.id));
  const live = await liveStats(p.tenantId, v1, true);
  const prevPlan = v.settings?.plan ?? {};
  await withTenant(p.tenantId, async (tx) => {
    // a re-solve changes only planned weeks, so a published schedule is not marked as having unpublished changes (rev stays)
    await tx.exec('UPDATE schedule_versions SET stats = $2, settings = settings || $3::jsonb, forecast_version_id = coalesce($4::uuid, forecast_version_id) WHERE tenant_id = :t AND id = $1',
      [v.id, JSON.stringify(live.stats), JSON.stringify({ forecastRev: fvRev ?? s.forecastRev ?? null, plan: { ...prevPlan, status: 'READY', solvedThrough: end, lastResolved: { at: new Date().toISOString(), from: start, to: end, by: p.name } } }), fvId]);
    await audit(tx, p, null, { action: 'GENERATE', entityType: 'SCHEDULE_VERSION', entityId: v.id, entityName: v.name, diffSummary: `Re-solved ${start} to ${end}${patternNote}` });
    await revision(tx, p, v.id, 'GENERATE', `Re-solved ${start} to ${end} on the current forecast${patternNote}`, null, live.stats);
  });
  await raw(`UPDATE schedule_jobs SET status = $2, finished_at = now(), version_id = $3, progress = progress || $4::jsonb WHERE id = $1 AND worker = $5 AND status = 'RUNNING'`, [job.id, 'DONE', v.id, JSON.stringify({ done: total, total, note: 'Done', etaSec: 0, windows: summary }), WORKER]);
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'generated'], { id: v.id, name: v.name, by: p.name });
}

// ---------------------------------------------------------------- the worker

async function execute(job: Job) {
  const ctl = new AbortController();
  running.set(job.id, ctl);
  const beat = setInterval(() => { setProgress(job.id, {}).then((c) => { if (c) ctl.abort(); }).catch(() => {}); }, 2000);
  try {
    if (job.versionId) await raw(`DELETE FROM schedule_versions WHERE id = $1 AND settings->'plan'->>'status' = 'BUILDING'`, [job.versionId]);   // a half-built plan from an interrupted run
    if (job.kind === 'PLAN') await runPlan(job, ctl); else await runResolve(job, ctl);
  } catch (e: any) {
    if (lost.has(job.id)) console.warn('[schedule-job]', job.id, 'was taken over by another worker; this run stops without recording a result');
    else if (cancelled(e) || ctl.signal.aborted) await raw(`UPDATE schedule_jobs SET status = 'CANCELLED', finished_at = now(), version_id = NULL, progress = progress || '{"note":"Cancelled"}'::jsonb WHERE id = $1 AND worker = $2 AND status = 'RUNNING'`, [job.id, WORKER]);
    else if ((e?.code === 'ENGINE_CRASHED' || e?.code === 'ENGINE_UNAVAILABLE' || e?.code === 'ENGINE_BUSY') && job.attempts < 3) {
      // the engine died or was restarting: put the job back (it starts again from the beginning) instead of failing the person's request
      console.warn('[schedule-job]', job.id, `${e.code}; trying again (attempt ${job.attempts} of 3)`);
      await raw(`UPDATE schedule_jobs SET status = 'QUEUED', worker = NULL, progress = progress || $2::jsonb WHERE id = $1 AND worker = $3 AND status = 'RUNNING'`, [job.id, JSON.stringify({ note: 'The engine restarted; starting this build again' }), WORKER]);
    }
    else { console.error('[schedule-job]', job.id, e?.message); await raw(`UPDATE schedule_jobs SET status = 'FAILED', error = $2, finished_at = now() WHERE id = $1 AND worker = $3 AND status = 'RUNNING'`, [job.id, String(e?.message ?? e).slice(0, 600), WORKER]); }
  } finally { clearInterval(beat); running.delete(job.id); lost.delete(job.id); invalidateLive(); }
}

const CONCURRENCY = Math.max(1, Number(process.env.SCHEDULE_JOB_CONCURRENCY || 2));
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;
async function tick() {
  // one claim round at a time in this process: overlapping rounds (the timer plus every new request) each saw a free slot and started a build apiece
  if (ticking) return;
  ticking = true;
  try {
    // This process vouches for the jobs it is running before anyone is judged. After a laptop sleeps or a long computing stretch every timer is late, and the
    // check below used to hand this process's own, still-running job back to the queue (so it ran twice) or fail it.
    const mine = [...running.keys()];
    if (mine.length) await raw(`UPDATE schedule_jobs SET heartbeat_at = now() WHERE id = ANY($1::uuid[]) AND worker = $2 AND status = 'RUNNING'`, [mine, WORKER]);
    // a job whose worker stopped heartbeating goes back in the queue (once), then is given up on; never one this process is running
    await raw(`UPDATE schedule_jobs SET status = CASE WHEN attempts >= 2 THEN 'FAILED' ELSE 'QUEUED' END, error = CASE WHEN attempts >= 2 THEN 'The server restarted twice while this was running.' ELSE error END, worker = NULL
               WHERE status = 'RUNNING' AND heartbeat_at < now() - make_interval(secs => $1) AND NOT (id = ANY($2::uuid[]))`, [STALE_SECONDS, mine]);
    while (running.size < CONCURRENCY) {
      // the limit also counts what other gateways are running, so the engine is never asked for more than CONCURRENCY builds in total
      const claimed = await raw<Job>(
        `UPDATE schedule_jobs SET status = 'RUNNING', worker = $1, started_at = coalesce(started_at, now()), heartbeat_at = now(), attempts = attempts + 1
          WHERE id = (SELECT id FROM schedule_jobs WHERE status = 'QUEUED' AND (SELECT count(*) FROM schedule_jobs WHERE status = 'RUNNING' AND heartbeat_at > now() - make_interval(secs => $3)) < $2 ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [WORKER, CONCURRENCY, STALE_SECONDS]);
      if (!claimed[0]) break;
      void execute(claimed[0]);
    }
  } catch (e) { console.error('[schedule-jobs]', (e as Error).message); }
  finally { ticking = false; }
}
/** Start pulling jobs. Several gateways can run this at once; each job runs on exactly one of them. */
export function startScheduleWorker() {
  if (timer) return;
  timer = setInterval(tick, 2000);
  timer.unref();
  void tick();
}
/** Stop picking up work and let running jobs be handed back (their heartbeat stops, so another worker takes them). */
export function stopScheduleWorker() { if (timer) clearInterval(timer); timer = null; for (const c of running.values()) c.abort(); }

// ---------------------------------------------------------------- routes

export const planRoutes = Router();
const mineJobs = (tenantId: string, where: string, params: unknown[]) => raw<Job>(`SELECT * FROM schedule_jobs WHERE org_id = $1 ${where}`, [tenantId, ...params]);

async function enqueue(p: Principal, kind: 'PLAN' | 'RESOLVE', groupId: string, params: unknown) {
  const busy = await mineJobs(p.tenantId, `AND wfm_group_id = $2 AND status IN ('QUEUED', 'RUNNING')`, [groupId]);
  if (busy.length) throw conflict(`A schedule is already being built for this group (${busy[0].kind === 'PLAN' ? 'a plan' : 'a re-solve'}, ${busy[0].status.toLowerCase()}). Wait for it to finish or cancel it.`);
  const [job] = await raw<Job>(`INSERT INTO schedule_jobs (org_id, wfm_group_id, kind, params, actor) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [p.tenantId, groupId, kind, JSON.stringify(params), JSON.stringify(p)]);
  void tick();
  return job;
}

planRoutes.post('/jobs', requires('schedule:generate'), async (req, res) => {
  const p = me(req), b = parse(PlanBody, req.body);
  if (b.assumeRepeat && b.weeks !== 1) throw bad('"Assume the week repeats" works for one-week schedules');
  res.status(202).json(jobDto(await enqueue(p, 'PLAN', b.groupId, b)));
});

/** Build a fresh draft from the same settings as this schedule, on the forecast that is published now. The schedule itself is not touched, so nothing is lost and the two can be compared. */
planRoutes.post('/versions/:id/regenerate', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const { v, tz, tplIds } = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    return { v, tz: (await loadGroup(tx, v.wfmGroupId)).timezone ?? 'UTC', tplIds: new Set((await tx.q<{ id: string }>('SELECT id FROM shift_templates WHERE tenant_id = :t')).map((t) => t.id)) };
  });
  if (v.kind === 'ROTATION') throw bad('A rotation roster is not built from a forecast. Change the rotation instead.');
  const s = v.settings ?? {}, today = todayIn(tz);
  const from = v.periodStart < today ? today : v.periodStart;                       // days already gone are not rebuilt
  if (from > v.periodEnd) throw bad('This schedule is already over, so there is nothing left to rebuild.');
  const weeks = Math.ceil((Date.parse(v.periodEnd) - Date.parse(from)) / 86_400_000 / 7 + 1 / 7);
  const templateIds = ((s.templateIds ?? []) as string[]).filter((t) => tplIds.has(t));
  const b = parse(PlanBody, {
    groupId: v.wfmGroupId, from, weeks, coverageSource: v.coverageSource ?? 'FORECAST', ...(templateIds.length ? { templateIds } : {}),
    ...(s.weights ? { weights: s.weights } : {}), ...(s.consistentTimes ? { consistentTimes: s.consistentTimes } : {}), optimizeBreaks: s.breaks != null,
    ...(s.breakSlackMin != null ? { breakSlackMin: s.breakSlackMin } : {}), timeLimitSec: s.timeLimitSec ?? 30, assumeRepeat: weeks === 1 && !!s.assumeRepeat,
    ...(s.weekStart != null ? { weekStart: s.weekStart } : {}), confidence: s.confidence ?? 50, solver: s.request?.solver ?? 'AUTO',
    ...(s.request?.employeeIds ? { employeeIds: s.request.employeeIds } : {}), ...(s.request?.excludeEmployeeIds ? { excludeEmployeeIds: s.request.excludeEmployeeIds } : {}), ...(s.request?.teamIds ? { teamIds: s.request.teamIds } : {}),
  });
  const note = from !== v.periodStart ? `The first ${Math.round((Date.parse(from) - Date.parse(v.periodStart)) / 86_400_000)} days have already passed, so the new schedule starts on ${from}.` : null;
  if (b.weeks > 4) return void res.status(202).json({ kind: 'JOB', job: jobDto(await enqueue(p, 'PLAN', b.groupId, b)), note });
  res.status(201).json({ kind: 'VERSION', version: verDto(await saveGenerated(p, req, await runGenerate(p, b))), note });
});

planRoutes.post('/versions/:id/resolve', requires('schedule:generate'), async (req, res) => {
  const p = me(req), b = parse(ResolveBody, { ...req.body, versionId: req.params.id });
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, b.versionId));
  res.status(202).json(jobDto(await enqueue(p, 'RESOLVE', v.wfmGroupId, b)));
});

planRoutes.get('/jobs', requires('schedule:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid.optional(), active: z.enum(['true', 'false']).optional() }), req.query);
  const rows = await mineJobs(p.tenantId, `AND ($2::uuid IS NULL OR wfm_group_id = $2) AND ($3::boolean IS NOT TRUE OR status IN ('QUEUED', 'RUNNING')) ORDER BY created_at DESC LIMIT 30`, [q.groupId ?? null, q.active === 'true' ? true : null]);
  res.json(rows.map(jobDto));
});

planRoutes.get('/jobs/:id', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const j = (await mineJobs(p.tenantId, 'AND id = $2', [id]))[0];
  if (!j) throw notFound('Job');
  res.json(jobDto(j));
});

planRoutes.post('/jobs/:id/cancel', requires('schedule:generate'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const j = (await mineJobs(p.tenantId, 'AND id = $2', [id]))[0];
  if (!j) throw notFound('Job');
  if (j.status === 'QUEUED') await raw(`UPDATE schedule_jobs SET status = 'CANCELLED', finished_at = now() WHERE id = $1 AND status = 'QUEUED'`, [id]);
  else if (j.status === 'RUNNING') { await raw('UPDATE schedule_jobs SET cancel_requested = true WHERE id = $1', [id]); running.get(id)?.abort(); }
  else throw conflict(`This job already ${j.status.toLowerCase()}.`);
  res.json(jobDto((await mineJobs(p.tenantId, 'AND id = $2', [id]))[0]));
});

// ---------------------------------------------------------------- publish a window

planRoutes.post('/versions/:id/publish-window', requires('schedule:publish'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id), b = parse(z.object({ through: z.string().regex(isoDay), acknowledgeReason: z.string().optional() }), req.body);
  const v0 = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (v0.kind !== 'DEMAND') throw bad('Rotation schedules are published whole.');
  if (v0.status === 'ARCHIVED') throw conflict('An archived schedule cannot be published.');
  if (b.through < v0.periodStart || b.through > v0.periodEnd) throw bad(`Publish up to a day inside the schedule (${v0.periodStart} to ${v0.periodEnd}).`);
  const already = v0.status === 'PUBLISHED' ? (v0.publishThrough ?? v0.periodEnd) : null;
  if (already && b.through <= already) throw conflict(`Already published up to ${already}.`);
  const live = await liveStats(p.tenantId, v0, true);
  const from = already ? addDays(already, 1) : v0.periodStart;
  const blocking = live.violations.filter((x: any) => x.severity !== 'WARN' && (!x.day || (x.day >= from && x.day <= b.through)));
  if (blocking.length) throw new HttpError(409, 'RULE_VIOLATIONS', `${blocking.length} rule violations in ${from} to ${b.through} must be fixed before publishing. First: ${blocking[0].message}`, blocking.slice(0, 20));
  const checks = await publishChecks(p, v0, live, b.acknowledgeReason);
  const whole = b.through >= v0.periodEnd;
  const out = await withTenant(p.tenantId, async (tx) => {
    await tx.exec(`UPDATE schedule_versions SET status = 'ARCHIVED' WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND id <> $2 AND kind = 'DEMAND' AND period_start <= $4 AND period_end >= $3`, [v0.wfmGroupId, id, v0.periodStart, b.through]);
    await tx.exec(`UPDATE schedule_versions SET status = 'PUBLISHED', publish_through = $5, published_by = $2, published_at = now(), published_rev = rev, stats = $3, ack = coalesce($4::jsonb, ack) WHERE tenant_id = :t AND id = $1`,
      [id, p.name, JSON.stringify(live.stats), checks.ack ? JSON.stringify(checks.ack) : null, whole ? null : b.through]);
    await audit(tx, p, req, { action: 'PUBLISH', entityType: 'SCHEDULE_VERSION', entityId: id, entityName: v0.name, diffSummary: whole ? 'Published in full' : `Published ${from} to ${b.through}; later weeks stay planned` });
    await revision(tx, p, id, 'PUBLISH', whole ? 'Published: the whole schedule is live' : `Published up to ${b.through}: those weeks are locked and live, later weeks stay planned`, null, live.stats);
    return loadVersion(tx, id);
  });
  await dropCache(p.tenantId, 'sched:*');
  publish(p.tenantId, ['schedule', 'publish'], { id, name: out.name, by: p.name, through: whole ? null : b.through });
  res.json({ ...verDto(out), checks: checks.issues });
});

// ---------------------------------------------------------------- the year view

const planCache = new Map<string, { at: number; value: any }>();
const confidenceOf = (weeksAhead: number, source: string) => (source === 'NONE' ? 'NONE' : source === 'LONG' ? 'LOW' : weeksAhead <= 6 ? 'HIGH' : weeksAhead <= 18 ? 'MEDIUM' : 'LOW');

export async function planView(tenantId: string, id: string) {
  const v = await withTenant(tenantId, (tx) => loadVersion(tx, id));
  const key = `${id}|${v.rev}|${v.publishThrough ?? ''}|${v.settings?.plan?.lastGenerated ?? ''}|${v.settings?.plan?.lastResolved?.at ?? ''}`;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const live = await liveStats(tenantId, v);
  const weekStart = v.settings?.weekStart ?? 0, days: string[] = live.days;
  const di = new Map(days.map((d, i) => [d, i]));
  const sched = new Array(days.length * SPD).fill(0);
  const bySource = new Map<string, Record<string, number>>();
  const people = new Map<string, Set<string>>();
  for (const s of live.shifts as any[]) {
    const i = di.get(s.day); if (i === undefined) continue;
    for (let g = i * SPD + s.startSlot; g < Math.min(sched.length, i * SPD + s.startSlot + s.lengthSlots); g++) sched[g]++;
    const wk = mondayOf(s.day, weekStart), m = bySource.get(wk) ?? {};
    m[s.source] = (m[s.source] ?? 0) + 1; bySource.set(wk, m);
    const set = people.get(wk) ?? new Set<string>(); set.add(s.employeeId); people.set(wk, set);
  }
  const projected = new Set<string>(live.stats.projectedDays ?? []), uncovered = new Set<string>(live.stats.uncoveredDays ?? []);
  const tz = (await withTenant(tenantId, (tx) => tx.one<{ timezone: string }>('SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1', [v.wfmGroupId])))?.timezone ?? 'UTC';
  const today = todayIn(tz), through: string | null = v.status === 'PUBLISHED' ? (v.publishThrough ?? v.periodEnd) : null;
  const weeks: any[] = [];
  const first = mondayOf(v.periodStart, weekStart);
  for (let ws = first; ws <= v.periodEnd; ws = addDays(ws, 7)) {
    let need = 0, under = 0, over = 0, hasLong = 0, hasNone = 0, n = 0;
    for (let d = 0; d < 7; d++) {
      const day = addDays(ws, d), i = di.get(day);
      if (i === undefined) continue;
      n++; if (projected.has(day)) hasLong++; if (uncovered.has(day)) hasNone++;
      for (let g = i * SPD; g < (i + 1) * SPD; g++) { const r = live.required[g]; need += r; if (sched[g] < r) under += r - sched[g]; else over += sched[g] - r; }
    }
    if (!n) continue;
    const src = bySource.get(ws) ?? {};
    const total = Object.values(src).reduce((a, b) => a + b, 0);
    const kind = !total ? 'EMPTY' : (src.PATTERN ?? 0) / total > 0.5 ? 'PATTERN' : (src.PATTERN ?? 0) ? 'MIXED' : 'SOLVED';
    const wsEnd = addDays(ws, 6) > v.periodEnd ? v.periodEnd : addDays(ws, 6);
    const forecast = hasNone === n ? 'NONE' : hasLong === n ? 'LONG' : hasLong ? 'MIXED' : 'SHORT';
    const ahead = Math.max(0, Math.floor((new Date(ws).getTime() - new Date(today).getTime()) / 604_800_000));
    weeks.push({
      weekStart: ws, weekEnd: wsEnd, coveragePercent: need ? Math.round((1 - under / need) * 1000) / 10 : null, needSlots: need, underSlots: under, overSlots: over, shifts: total, people: people.get(ws)?.size ?? 0,
      shiftSource: kind, forecast, confidence: confidenceOf(ahead, forecast), weeksAhead: ahead,
      state: through && wsEnd <= through ? 'LOCKED' : through && ws <= through ? 'PARTLY_LOCKED' : wsEnd < today ? 'PAST' : 'PLANNED',
    });
  }
  const value = { versionId: id, name: v.name, status: v.status, periodStart: v.periodStart, periodEnd: v.periodEnd, publishThrough: v.publishThrough ?? null, today, plan: v.settings?.plan ?? null, weeks,
    summary: { coverage: live.stats.coverage.percent, shifts: live.stats.shifts, people: live.stats.people, violations: live.stats.violations } };
  planCache.set(key, { at: Date.now(), value });
  if (planCache.size > 50) planCache.delete(planCache.keys().next().value!);
  return value;
}

planRoutes.get('/versions/:id/plan', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  res.json(await planView(p.tenantId, parse(uuid, req.params.id)));
});

// ---------------------------------------------------------------- rotation lines

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const clock = (slot: number) => `${String(Math.floor((slot % SPD) / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;

/**
 * The repeating lines in a schedule: people who work the same days and times in each week of the cycle are on the same line. Read from the weeks
 * after `from` (default: the repeated part, else the last cycle) so months far ahead are described by lines, not by names of shifts.
 */
planRoutes.get('/versions/:id/lines', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const q = parse(z.object({ from: z.string().regex(isoDay).optional(), weeks: z.coerce.number().int().min(1).max(8).optional() }), req.query);
  const { v, shifts, names } = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    return { v, shifts: await shiftsOf(tx, id), names: await tx.q<any>(`SELECT id, first_name || ' ' || last_name AS name, employee_number FROM employees WHERE tenant_id = :t`) };
  });
  const weekStart = v.settings?.weekStart ?? 0, plan = v.settings?.plan ?? {};
  const cycleWeeks = q.weeks ?? Math.max(1, Math.round((plan.cycleDays ?? 28) / 7));
  const from = mondayOf(q.from ?? plan.patternFrom ?? addDays(v.periodEnd, -cycleWeeks * 7 + 1), weekStart);
  const to = addDays(from, cycleWeeks * 7 - 1);
  const who = new Map(names.map((n: any) => [n.id, n]));
  const sig = new Map<string, string[]>();                 // employee -> cycleWeeks*7 cells
  for (const s of shifts as any[]) {
    if (s.day < from || s.day > to) continue;
    const cells = sig.get(s.employeeId) ?? new Array(cycleWeeks * 7).fill('Off');
    cells[dayRange(from, s.day).length - 1] = `${clock(s.startSlot)}–${clock(s.startSlot + s.lengthSlots)}`;
    sig.set(s.employeeId, cells);
  }
  const lines = new Map<string, { cells: string[]; people: string[] }>();
  for (const [e, cells] of sig) { const k = cells.join('|'); const l = lines.get(k) ?? { cells, people: [] }; l.people.push(e); lines.set(k, l); }
  const describe = (cells: string[]) => {
    const wk = Array.from({ length: cycleWeeks }, (_, w) => cells.slice(w * 7, w * 7 + 7));
    const text = wk.map((days) => {
      const runs: string[] = []; let i = 0;
      while (i < 7) {
        if (days[i] === 'Off') { i++; continue; }
        let j = i; while (j + 1 < 7 && days[j + 1] === days[i]) j++;
        const dowI = (weekStart + i) % 7, dowJ = (weekStart + j) % 7;
        runs.push(`${i === j ? DAYS[dowI] : `${DAYS[dowI]}–${DAYS[dowJ]}`} ${days[i]}`); i = j + 1;
      }
      return runs.join(', ') || 'Off all week';
    });
    return { weeks: wk.map((days, w) => ({ week: w + 1, days: days.map((c, d) => ({ day: DAYS[(weekStart + d) % 7], shift: c })), text: text[w] })), summary: new Set(text).size === 1 ? `${text[0]} (every week)` : `Rotates over ${cycleWeeks} weeks` };
  };
  const out = [...lines.values()].sort((a, b) => b.people.length - a.people.length).map((l, i) => ({
    id: `L${i + 1}`, name: `Line ${i + 1}`, size: l.people.length, ...describe(l.cells),
    people: l.people.map((e) => ({ id: e, name: (who.get(e) as any)?.name ?? '', number: (who.get(e) as any)?.employeeNumber ?? '' })).sort((a, b) => a.name.localeCompare(b.name)),
  }));
  res.json({ versionId: id, from, to, cycleWeeks, lines: out, peopleOnLines: sig.size });
});


// ---------------------------------------------------------------- stress test

/**
 * Play random call arrivals against a schedule: the forecast's volume and handling time for each interval, the people actually on the phones (everyone
 * on shift less those on a meal or break, less an allowance for absence), a random forecast error, and callers who give up. The answer is how often each
 * day would meet its service level, and how a poor day looks, not just the average.
 */
/** What a stress test or a what-if needs: the schedule, the forecast volume per interval and the people on the phones in each. */
async function simSetup(p: Principal, id: string, fromDay: string | undefined, nDays: number) {
  const b = { from: fromDay, days: nDays };
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  if (!v.forecastVersionId) throw bad('This schedule was not built from a forecast, so there is no call volume to simulate. Set coverage from a forecast to use the stress test.');
  const fvRow = await withTenant(p.tenantId, (tx) => tx.one<any>('SELECT * FROM forecast_versions WHERE tenant_id = :t AND id = $1', [v.forecastVersionId]));
  if (!fvRow) throw notFound('Forecast');
  const from = b.from ?? (v.periodStart);
  if (from < v.periodStart || from > v.periodEnd) throw bad(`Choose a day inside the schedule (${v.periodStart} to ${v.periodEnd}).`);
  const last = addDays(from, b.days - 1) > v.periodEnd ? v.periodEnd : addDays(from, b.days - 1);
  const want = dayRange(from, last);
  const [{ records }, group, live] = await Promise.all([versionRecords(p.tenantId, fvRow), withTenant(p.tenantId, (tx) => loadGroup(tx, v.wfmGroupId)), liveStats(p.tenantId, v)]);
  const rec = new Map(records.map((r) => [`${r.day}|${r.slot}`, r]));
  const missing = want.filter((d) => !records.some((r) => r.day === d));
  if (missing.length) throw bad(`The forecast "${fvRow.name}" has no call volume for ${missing[0]}${missing.length > 1 ? ` and ${missing.length - 1} more day${missing.length > 2 ? 's' : ''}` : ''}, so those days cannot be simulated. Choose days the short-term forecast covers.`);
  // people on the phones in every quarter-hour of the schedule: on shift, less anyone on a meal or break at that moment
  const di = new Map<string, number>((live.days as string[]).map((d, i) => [d, i]));
  const onShift = new Array(live.days.length * SPD).fill(0);
  for (const s of live.shifts as any[]) {
    const i = di.get(s.day); if (i === undefined) continue;
    const off = new Set<number>();
    for (const a of s.activities ?? []) for (let k = 0; k < a.slots; k++) off.add(a.startSlot + k);
    for (let k = 0; k < s.lengthSlots; k++) { const g = i * SPD + s.startSlot + k; if (g < onShift.length && !off.has(s.startSlot + k)) onShift[g]++; }
  }
  return { v, group, want, di, onShift, rec, live, target: (group.serviceLevel > 1 ? group.serviceLevel / 100 : group.serviceLevel) as number };
}
const intervalsOf = (s: Awaited<ReturnType<typeof simSetup>>, f: { volumePct?: number; ahtPct?: number; absencePercent?: number; staffPct?: number }) => {
  const out: { volume: number; aht_sec: number; agents: number }[] = [];
  for (const day of s.want) {
    const i = s.di.get(day)!;
    for (let slot = 0; slot < SPD; slot++) {
      const r = s.rec.get(`${day}|${slot}`);
      out.push({ volume: (r?.volume ?? 0) * (1 + (f.volumePct ?? 0) / 100), aht_sec: (r?.aht || 300) * (1 + (f.ahtPct ?? 0) / 100), agents: s.onShift[i * SPD + slot] * (1 - (f.absencePercent ?? 0) / 100) * (1 + (f.staffPct ?? 0) / 100) });
    }
  }
  return out;
};

planRoutes.post('/versions/:id/simulate', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({
    from: z.string().regex(isoDay).optional(), days: z.number().int().min(1).max(14).default(1), replications: z.number().int().min(5).max(200).default(40),
    volumeCv: z.number().min(0).max(0.5).default(0.08), absencePercent: z.number().min(0).max(40).default(0), seed: z.number().int().optional(),
  }), req.body ?? {});
  const setup = await simSetup(p, id, b.from, b.days);
  const { group, want, di, onShift, live, target } = setup;
  const from = want[0], last = want.at(-1)!;
  const intervals = intervalsOf(setup, { absencePercent: b.absencePercent });
  const sim = await engine.simulate({ intervals, answer_sec: group.answerSec, patience_sec: group.patienceSec || 120, replications: b.replications, volume_cv: b.volumeCv, seed: b.seed ?? 20260101, slots_per_day: SPD }, 5 * 60_000);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  // what the planning formula promised for the same people, for comparison
  const planned = want.map((day) => {
    const i = di.get(day)!; let need = 0, have = 0;
    for (let g = i * SPD; g < (i + 1) * SPD; g++) { need += live.required[g]; have += Math.min(onShift[g], live.required[g]); }
    return need ? have / need : 1;
  });
  res.json({
    versionId: id, from, to: last, target, answerSec: group.answerSec, patienceSec: group.patienceSec || 120, replications: sim.replications, volumeCv: b.volumeCv, absencePercent: b.absencePercent,
    overall: { serviceLevel: r3(sim.sl_mean), abandon: r3(sim.abandon), occupancy: r3(sim.occupancy), offered: Math.round(sim.offered), chanceOfMeetingTarget: r3((sim.sl_by_rep as number[]).filter((x) => x >= target).length / Math.max(1, sim.sl_by_rep.length)) },
    days: want.map((day, k) => ({ day, serviceLevel: r3(sim.days[k].sl_mean), badDayServiceLevel: r3(sim.days[k].sl_low), abandon: r3(sim.days[k].abandon), occupancy: r3(sim.days[k].occupancy), offered: Math.round(sim.days[k].offered), coverageOfRequirement: r3(planned[k]), meetsTarget: sim.days[k].sl_mean >= target })),
    intervals: sim.intervals.map((x: any, k: number) => ({ day: want[Math.floor(k / SPD)], slot: k % SPD, serviceLevel: r3(x.sl_mean), badServiceLevel: r3(x.sl_low), asaSec: Math.round(x.asa_sec * 10) / 10, abandon: r3(x.abandon), occupancy: r3(x.occupancy), offered: Math.round(x.offered * 10) / 10, agents: Math.round(intervals[k].agents * 10) / 10, belowTarget: x.sl_mean < target && x.offered > 0 })),
    wallSec: sim.wall_sec,
    notes: [
      'Calls arrive at random around the forecast, and the whole stretch is scaled by a random forecast error. Handling times and patience vary.',
      `People on the phones = everyone on shift less meals and breaks${b.absencePercent ? ` and ${b.absencePercent}% absence` : ' (everyone is assumed to turn up)'}.`,
    ],
  });
});


// ---------------------------------------------------------------- what if

/**
 * Compare "what if" versions of a schedule on the same days: more calls, longer calls, more people off, fewer or more people on shift. Each runs through the
 * stress test. For each one it also finds, by trying, about how many more (or fewer) people on the phones would just meet the service target, and says what that is
 * as a share of the people scheduled and as full-time equivalents. The headcount figure is an approximation: it scales everyone on shift together.
 */
planRoutes.post('/versions/:id/what-if', requires('schedule:read'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  const b = parse(z.object({
    from: z.string().regex(isoDay).optional(), days: z.number().int().min(1).max(7).default(3), replications: z.number().int().min(5).max(60).default(20), volumeCv: z.number().min(0).max(0.5).default(0.08),
    scenarios: z.array(z.object({ name: z.string().trim().min(1).max(60), volumePct: z.number().min(-60).max(300).default(0), ahtPct: z.number().min(-60).max(300).default(0), absencePercent: z.number().min(0).max(60).default(0), staffPct: z.number().min(-90).max(300).default(0) })).min(1).max(6),
  }), req.body ?? {});
  const setup = await simSetup(p, id, b.from, b.days);
  const { group, target, v } = setup;
  const run = async (f: { volumePct?: number; ahtPct?: number; absencePercent?: number; staffPct?: number }, reps = b.replications) =>
    engine.simulate({ intervals: intervalsOf(setup, f), answer_sec: group.answerSec, patience_sec: group.patienceSec || 120, replications: reps, volume_cv: b.volumeCv, seed: 20260101, slots_per_day: SPD }, 5 * 60_000);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const brief = (sim: any) => ({ serviceLevel: r3(sim.sl_mean), abandon: r3(sim.abandon), occupancy: r3(sim.occupancy), chanceOfMeetingTarget: r3((sim.sl_by_rep as number[]).filter((x) => x >= target).length / Math.max(1, sim.sl_by_rep.length)), meetsTarget: sim.sl_mean >= target });
  const scheduledPeople = v.stats?.people ?? 0;
  // the smallest change in people on the phones that meets the target: halve the search range a few times (service level only rises with people)
  const needed = async (f: Parameters<typeof run>[0]) => {
    let lo = -60, hi = 150, best: number | null = null;
    if ((await run({ ...f, staffPct: hi }, 8)).sl_mean < target) return null;                 // even 2.5 times the people would not do it
    for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2; if ((await run({ ...f, staffPct: mid }, 8)).sl_mean >= target) { best = mid; hi = mid; } else lo = mid; }
    return best === null ? null : Math.round(best);
  };
  const base = await run({});
  const scenarios = [{ name: 'As scheduled', input: { volumePct: 0, ahtPct: 0, absencePercent: 0, staffPct: 0 } }, ...b.scenarios.map((s) => ({ name: s.name, input: { volumePct: s.volumePct, ahtPct: s.ahtPct, absencePercent: s.absencePercent, staffPct: s.staffPct } }))];
  const out: any[] = [];
  for (const [k, sc] of scenarios.entries()) {
    const sim = k === 0 ? base : await run(sc.input);
    const base0 = { volumePct: sc.input.volumePct, ahtPct: sc.input.ahtPct, absencePercent: sc.input.absencePercent };     // what the world looks like; people on the phones is what we solve for
    const pct = await needed(base0);
    out.push({ name: sc.name, ...sc.input, ...brief(sim), peopleNeededChangePercent: pct, peopleNeededChangeFte: pct === null ? null : Math.round((scheduledPeople * pct) / 100 * 10) / 10,
      verdict: pct === null ? 'More than 2.5 times the people on the phones would be needed.' : pct <= 0 ? `The people scheduled are enough${pct < -5 ? `; about ${-pct}% fewer would still meet the target` : ''}.` : `About ${pct}% more people on the phones are needed to meet the target.` });
  }
  res.json({ versionId: id, from: setup.want[0], to: setup.want.at(-1), target, answerSec: group.answerSec, scheduledPeople, replications: b.replications, scenarios: out,
    notes: ['Each row is played through the stress test on the same days. "People needed" scales everyone on shift together until the service target is just met; it is an estimate, not a roster.', 'A longer handling time, more calls or more absence all push the number up; the stress test already allows for the forecast being wrong by a random amount.'] });
});
