import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../../db.ts';
import { me, requires, requiresAny } from '../../auth.ts';
import { audit } from '../../audit.ts';
import { HttpError, bad, conflict, isoDay, notFound, parse } from '../../http.ts';
import { dropCache, engine, publish } from '../../infra.ts';
import {
  MODELS, SLOT_H, addDays, aggregateStaff, bucketRecords, capacityFor, createVersion, dayRange, erlangFactor, holdout, loadGroup, loadVersion, num, realised, rollup,
  runStaffing, scenarioResult, shortLabel, todayIn, versionDto, versionRecords, versionRows, type Daily, type Group, type Overrides, type QRow, type Rec,
} from './service.ts';
import { LEARNING, evaluate, learn } from './learning.ts';
import { normalise, parseCsv, type DateFormat } from '../csv.ts';
import { planRows, summarisePlan, withPlainVolumeHeader } from './planningImport.ts';

export const forecast = Router();
const r2 = (v: number) => Math.round(v * 100) / 100;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const uuid = z.string().uuid();

// ---------------------------------------------------------------- versions

forecast.get('/versions', requires('forecast:read'), async (req, res) => {
  const groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  const rows = await withTenant(me(req).tenantId, (tx) => tx.q<any>(
    `SELECT * FROM forecast_versions WHERE tenant_id = :t AND ($1::uuid IS NULL OR wfm_group_id = $1) ORDER BY kind, seq DESC LIMIT 300`, [groupId]));
  // the list also carries the model that won and its typical daily miss, read from the saved summary
  res.json(rows.map((v) => {
    const series: any[] = v.summary?.series ?? [];
    const picks = series.map((x) => ({ model: x.model as string, wape: (x.scores ?? []).find((c: any) => c.selected)?.wape as number | undefined }));
    const models = [...new Set(picks.map((x) => x.model).filter(Boolean))];
    const wapes = picks.map((x) => x.wape).filter((w): w is number => typeof w === 'number');
    return { ...versionDto(v), model: models.length === 1 ? models[0] : models.length > 1 ? 'mixed' : null, wape: wapes.length ? sum(wapes) / wapes.length : null };
  }));
});

// ---------------------------------------------------------------- preview before creating: a typical day from recent history

forecast.get('/preview', requires('forecast:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({
    groupId: uuid, dow: z.coerce.number().int().min(0).max(6).optional(),
    // what-if values for the preview only (the forecast itself always uses the group's saved targets)
    sl: z.coerce.number().gt(0).lt(100).optional(), answer: z.coerce.number().int().min(1).max(600).optional(), occ: z.coerce.number().gt(30).lte(100).optional(),
    shrink: z.coerce.number().min(0).max(90).optional(), aht: z.coerce.number().min(1).max(7200).optional(),
  }), req.query);
  const data = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, q.groupId);
    const ids = group.queues.map((x) => x.id);
    if (!ids.length) return { group, last: null as string | null, first: '', rows: [] as any[], days: [] as any[] };
    const last = (await tx.one<{ d: string | null }>('SELECT max(day)::text AS d FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($1::uuid[])', [ids]))?.d ?? null;
    if (!last) return { group, last, first: '', rows: [], days: [] };
    const rows = await tx.q<any>(
      `SELECT queue_id, (extract(isodow FROM day)::int - 1) AS dow, slot, sum(volume)::float8 AS tot, sum(volume * aht_sec)::float8 AS work
       FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day > ($2::date - 56) GROUP BY queue_id, dow, slot`, [ids, last]);
    const days = await tx.q<any>(
      `SELECT (extract(isodow FROM day)::int - 1) AS dow, count(DISTINCT day)::int AS n, min(day)::text AS first FROM interval_history
       WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day > ($2::date - 56) GROUP BY dow`, [ids, last]);
    return { group, last, first: days.map((d) => d.first).sort()[0] as string, rows, days };
  });
  if (!data.last) return res.json({ ready: false, reason: data.group.queues.length ? 'There is no interval history for this group yet. Import it under Data Management first.' : 'This WFM group has no queues yet.' });

  const nDays = new Map<number, number>(data.days.map((d) => [d.dow, d.n]));
  const base = '2000-01-03';                                    // any Monday: only the weekday matters here
  const over: Overrides = {};
  if (q.sl !== undefined) over.serviceLevel = q.sl / 100;
  if (q.answer !== undefined) over.answerSec = q.answer;
  if (q.occ !== undefined) over.occupancyCap = q.occ / 100;
  if (q.shrink !== undefined) over.shrinkage = q.shrink / 100;
  const totAll = data.rows.reduce((x: number, r: any) => x + r.tot, 0);
  const ahtBase = totAll > 0 ? data.rows.reduce((x: number, r: any) => x + r.work, 0) / totAll : 0;
  const ahtFactor = q.aht !== undefined && ahtBase > 0 ? q.aht / ahtBase : 1;
  const qrows = data.rows.filter((r) => nDays.get(r.dow)).map((r) => ({ queueId: r.queueId, day: addDays(base, r.dow), slot: r.slot, vol: r.tot / nDays.get(r.dow)!, aht: (r.tot > 0 ? r.work / r.tot : 300) * ahtFactor }));
  const staff = aggregateStaff(await runStaffing(data.group, qrows, over));
  const vol = new Map<string, number>();
  for (const r of qrows) vol.set(`${r.day}|${r.slot}`, (vol.get(`${r.day}|${r.slot}`) ?? 0) + r.vol);

  const tomorrow = addDays(todayIn(data.group.timezone), 1);
  const dow = q.dow ?? ((new Date(`${tomorrow}T00:00:00Z`).getUTCDay() + 6) % 7);
  const day = addDays(base, dow);
  const slots = Array.from({ length: 96 }, (_, s) => { const a = staff.get(`${day}|${s}`); return { slot: s, volume: r2(vol.get(`${day}|${s}`) ?? 0), required: a?.required ?? 0, onPhones: a?.base ?? 0 }; });
  const weekHours = [...staff.values()].reduce((t, a) => t + a.required * SLOT_H, 0);
  res.json({
    ready: true, dow, aht: ahtBase > 0 ? Math.round(ahtBase * ahtFactor) : null, ahtHistory: ahtBase > 0 ? Math.round(ahtBase) : null, basis: { from: data.first, to: data.last, weeks: Math.round((Math.max(...[...nDays.values()], 1))) }, slots,
    day: { volume: Math.round(sum(slots.map((x) => x.volume))), peakRequired: Math.max(0, ...slots.map((x) => x.required)), agentHours: r2(sum(slots.map((x) => x.required)) * SLOT_H) },
    week: { volume: Math.round(sum([...vol.values()])), agentHours: r2(weekHours), fte: r2(weekHours / (data.group.fteHoursWeek || 40)) },
    targets: { serviceLevel: over.serviceLevel ?? data.group.serviceLevel, answerSec: over.answerSec ?? data.group.answerSec, occupancyCap: over.occupancyCap ?? data.group.occupancyCap, shrinkage: over.shrinkage ?? data.group.shrinkage, method: data.group.method, fteHoursWeek: data.group.fteHoursWeek },
  });
});

const CreateBody = z.object({
  groupId: uuid, kind: z.enum(['SHORT', 'LONG']).default('SHORT'), weeks: z.number().int().min(1).max(18).optional(), days: z.number().int().min(30).max(730).optional(),
  model: z.enum(MODELS).optional(), name: z.string().min(1).max(120).optional(), fromDay: z.string().regex(isoDay).optional(),
});
forecast.post('/versions', requires('forecast:create'), async (req, res) => {
  const p = me(req), b = parse(CreateBody, req.body);
  const v = await createVersion(p, req, b);
  publish(p.tenantId, ['forecast', 'created'], { id: v.id, name: v.name, by: p.name });
  res.status(201).json({ ...versionDto(v), summary: v.summary });
});

// ---------------------------------------------------------------- a planning forecast from a file

/**
 * A forecast for the days ahead supplied as a file (queue, date, interval, forecast volume, handle time), for the planner who already has the
 * numbers. `dryRun` reads and checks the file and says what is in it without saving anything. Saving creates a draft version of type Imported
 * that goes through submit, approve and publish like any other, so the schedule generator then uses it.
 */
const PlanBody = z.object({
  groupId: uuid, csv: z.string().min(1), fileName: z.string().trim().max(200).optional(), name: z.string().trim().max(100).optional(),
  intervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).optional(), dateFormat: z.enum(['iso', 'mdy', 'dmy']).default('iso'),
  dryRun: z.boolean().default(false), allowGaps: z.boolean().default(false), allowPast: z.boolean().default(false),
});
forecast.post('/versions/import', requires('forecast:create'), async (req, res) => {
  const p = me(req), b = parse(PlanBody, req.body);
  if (Buffer.byteLength(b.csv) > 10 * 1024 * 1024) throw new HttpError(413, 'TOO_LARGE', 'File exceeds 10MB; split it into several files');
  const matrix = parseCsv(b.csv);
  if (matrix.length < 2) throw bad('The file has a header but no data rows');
  const { matrix: m, renamedFrom } = withPlainVolumeHeader(matrix);
  const out = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, b.groupId);
    if (!group.queues.length) throw bad('This WFM group has no queues. Add queues under Configuration first.');
    const queues = group.queues.map((q) => ({ id: q.id, name: q.name, code: q.name, ahtDefault: q.ahtDefault }));
    const read = normalise(m, { intervalMin: b.intervalMinutes, dateFormat: b.dateFormat as DateFormat, queues });
    const names = new Map(group.queues.map((q) => [q.id, q.name]));
    const summary = summarisePlan(read.records, names, todayIn(group.timezone));
    const problems: string[] = [];
    if (read.errors.length) problems.push(`${read.errors.length} row${read.errors.length === 1 ? '' : 's'} could not be read: ${read.errors.slice(0, 5).map((e) => `line ${e.line}: ${e.message}`).join('; ')}${read.errors.length > 5 ? '…' : ''}`);
    if (!read.records.length && !read.errors.length) problems.push('The file has no usable rows');
    if (summary.pastDays.length && !b.allowPast) problems.push(`${summary.pastDays.length} day${summary.pastDays.length === 1 ? ' is' : 's are'} in the past (${summary.pastDays[0]}${summary.pastDays.length > 1 ? ` to ${summary.pastDays.at(-1)}` : ''}). A planning forecast is for days ahead; history belongs under Data Management`);
    if (summary.gaps.length && !b.allowGaps) problems.push(`${summary.gaps.length} queue-day${summary.gaps.length === 1 ? '' : 's'} do not have all 96 quarter-hours (for example ${summary.gaps[0].queue} on ${summary.gaps[0].day} has ${summary.gaps[0].have}); missing intervals would count as no calls`);
    const report = { rowsRead: read.rowsRead, rowsOk: read.rowsOk, volumeColumn: renamedFrom ?? read.columns.find((c) => c.field === 'volume')?.source ?? null, ...summary, errors: read.errors.slice(0, 50) };
    if (b.dryRun || problems.length) return { saved: false as const, problems, report };

    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`fv:${group.id}:SHORT`]);
    const seq = (await tx.one<{ n: number }>("SELECT coalesce(max(seq), 0) + 1 AS n FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT'", [group.id]))!.n;
    const name = b.name?.trim() || `Imported v${seq} · ${summary.days} day${summary.days === 1 ? '' : 's'} from ${summary.from}`;
    const series = summary.queues.map((q) => ({ queueId: q.id, name: q.name, model: 'Imported', scores: [], backtest: [], cleanedDays: 0, sigmaRel: 0, notes: [`Imported from ${b.fileName ?? 'a planning file'}: ${summary.totalVolume.toLocaleString('en-US')} contacts over ${summary.days} days. No model was run and there is no likely range.`] }));
    const v = await tx.one<any>(
      `INSERT INTO forecast_versions (tenant_id, wfm_group_id, seq, name, kind, type, from_day, to_day, slots_per_day, model_req, summary, created_by)
       VALUES (:t, $1, $2, $3, 'SHORT', 'IMPORTED', $4, $5, 96, 'imported', $6, $7) RETURNING *`,
      [group.id, seq, name, summary.from, summary.to, JSON.stringify({ series, imported: { fileName: b.fileName ?? null, rows: read.rowsOk, totalVolume: summary.totalVolume, volumeColumn: report.volumeColumn } }), p.name]);
    const rows = planRows(read.records);
    for (let i = 0; i < rows.length; i += 8000) {
      const c = rows.slice(i, i + 8000);
      await tx.exec(
        `INSERT INTO forecast_intervals (tenant_id, version_id, queue_id, day, slot, volume, aht_sec, p10, p90)
         SELECT :t, $1::uuid, x.q, x.d, x.s, x.v, x.a, x.v, x.v FROM unnest($2::uuid[], $3::date[], $4::smallint[], $5::real[], $6::real[]) AS x(q, d, s, v, a)`,
        [v!.id, c.map((r) => r.queueId), c.map((r) => r.day), c.map((r) => r.slot), c.map((r) => r.volume), c.map((r) => r.aht)]);
    }
    await audit(tx, p, req, { action: 'CREATE', entityType: 'FORECAST_VERSION', entityId: v!.id, entityName: name, after: { type: 'IMPORTED', days: summary.days, volume: summary.totalVolume, fileName: b.fileName ?? null } });
    return { saved: true as const, problems, report, version: v };
  });
  if (!out.saved) {
    if (b.dryRun) return void res.json({ ok: out.problems.length === 0, problems: out.problems, ...out.report });
    throw bad(out.problems.join(' | '));
  }
  publish(p.tenantId, ['forecast', 'created'], { id: out.version.id, name: out.version.name, by: p.name });
  res.status(201).json({ ...versionDto(out.version), summary: out.version.summary, report: out.report });
});

forecast.get('/versions/:id', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    const trail = await tx.q<any>(
      `SELECT at, actor_name, actor_role, action, reason, diff_summary, after FROM audit_log WHERE tenant_id = :t AND entity_type = 'FORECAST_VERSION' AND entity_id = $1 ORDER BY id DESC LIMIT 100`, [id]);
    return { ...versionDto(v), summary: v.summary, audit: trail.map((a) => ({ at: a.at, by: a.actorName, role: a.actorRole, action: a.action, reason: a.reason, detail: a.diffSummary ?? a.after })) };
  });
  res.json(out);
});

forecast.delete('/versions/:id', requires('forecast:delete'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    if (v.status === 'PUBLISHED') throw conflict('A published forecast cannot be deleted. Publish a newer one first; this one is then archived.');
    await tx.exec('DELETE FROM forecast_versions WHERE tenant_id = :t AND id = $1', [id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'FORECAST_VERSION', entityId: id, entityName: v.name, before: versionDto(v) });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- data views

/**
 * Time-of-day view of a long-term (daily) forecast: each day's volume is shared out over its 15-minute slots using the usual
 * pattern for that weekday and queue in the last 8 weeks of history, then staffed like any other interval. The daily total is unchanged.
 */
async function splitDaysByTime(tenantId: string, group: Group, daily: Daily[], queueId: string | null): Promise<Rec[]> {
  const ids = queueId ? [queueId] : group.queues.map((x) => x.id);
  const prof = await withTenant(tenantId, async (tx) => {
    const last = (await tx.one<{ d: string | null }>('SELECT max(day)::text AS d FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($1::uuid[])', [ids]))?.d;
    if (!last) return [] as any[];
    return tx.q<any>(
      `SELECT queue_id, (extract(isodow FROM day)::int - 1) AS dow, slot, sum(volume)::float8 AS tot FROM interval_history
       WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day > ($2::date - 56) GROUP BY queue_id, dow, slot`, [ids, last]);
  });
  if (!prof.length) throw bad('There is no interval history to split this long-term forecast by time of day. Import it under Data Management first.');
  const dowTotal = new Map<number, number>();
  for (const r of prof) dowTotal.set(r.dow, (dowTotal.get(r.dow) ?? 0) + r.tot);
  const dowOf = (day: string) => (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const rows: QRow[] = [];
  for (const d of daily) {
    const dw = dowOf(d.day), tot = dowTotal.get(dw);
    if (!tot) continue;
    for (const r of prof) if (r.dow === dw && r.tot > 0) rows.push({ queueId: r.queueId, day: d.day, slot: r.slot, vol: (d.volume * r.tot) / tot, aht: d.aht });
  }
  const staff = aggregateStaff(await runStaffing(group, rows));
  const acc = new Map<string, { day: string; slot: number; vol: number }>();
  for (const r of rows) { const k = `${r.day}|${r.slot}`; const a = acc.get(k) ?? { day: r.day, slot: r.slot, vol: 0 }; a.vol += r.vol; acc.set(k, a); }
  return [...acc.entries()].map(([k, a]): Rec => {
    const d = byDay.get(a.day)!, share = d.volume > 0 ? a.vol / d.volume : 0, st = staff.get(k);
    return { day: a.day, slot: a.slot, volume: r2(a.vol), aht: d.aht, p10: r2(d.p10 * share), p90: r2(d.p90 * share), edited: d.edited, required: st?.required ?? 0, base: st?.base ?? 0, sl: st?.sl ?? 1, occ: st?.occ ?? 0, warn: st?.warn ?? false };
  }).sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : x.slot - y.slot));
}

forecast.get('/versions/:id/data', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const q = parse(z.object({
    grain: z.enum(['15', '30', '60', 'day', 'week', 'month']).optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional(), queueId: uuid.optional(),
  }), req.query);
  const { v, group } = await withTenant(p.tenantId, async (tx) => { const v = await loadVersion(tx, id); return { v, group: await loadGroup(tx, v.wfmGroupId) }; });
  const grain = q.grain ?? (v.kind === 'LONG' ? 'day' : '60');
  const { records, daily } = await versionRecords(p.tenantId, v, q.queueId ?? null);
  const from = q.from ?? v.fromDay, to = q.to ?? v.toDay;
  const inRange = (d: string) => d >= from && d <= to;
  let buckets: any[];
  if (v.kind === 'LONG' && ['15', '30', '60'].includes(grain)) {
    // a long-term forecast is one number per day: split it over the day the way this weekday usually runs in the history
    if (dayRange(from, to).length > 31) throw bad('A long-term forecast can be split by time of day for up to 31 days at a time');
    buckets = bucketRecords(await splitDaysByTime(p.tenantId, group, daily.filter((x) => inRange(x.day)), q.queueId ?? null), grain as '15' | '30' | '60');
  } else if (v.kind === 'LONG' || ['day', 'week', 'month'].includes(grain)) {
    const d = daily.filter((x) => inRange(x.day));
    buckets = grain === 'week' || grain === 'month' ? rollup(d, grain) : d;
  } else {
    if (dayRange(from, to).length > 14 && grain === '15') throw bad('The 15-minute view is limited to 14 days per request');
    buckets = bucketRecords(records.filter((x) => inRange(x.day)), grain as '15' | '30' | '60');
  }
  // intervals (and the days of a long-term forecast) also carry what really happened, the same weekday a week earlier, and the people on the published schedule
  if (['15', '30', '60', 'day'].includes(grain) && buckets.every((b) => b.day)) {
    const { act, sch } = await withTenant(p.tenantId, async (tx) => ({
      act: await tx.q<any>(
        `SELECT h.day::text AS day, h.slot, sum(h.volume)::int AS vol FROM interval_history h JOIN queues qu ON qu.id = h.queue_id
         WHERE h.tenant_id = :t AND qu.wfm_group_id = $1 AND ($2::uuid IS NULL OR h.queue_id = $2) AND h.day BETWEEN ($3::date - 7) AND $4 GROUP BY h.day, h.slot`, [v.wfmGroupId, q.queueId ?? null, from, to]),
      sch: await tx.q<any>(
        `SELECT s.day::text AS day, s.start_slot, s.length_slots FROM schedule_shifts s JOIN schedule_versions sv ON sv.id = s.version_id
         WHERE s.tenant_id = :t AND sv.wfm_group_id = $1 AND sv.status = 'PUBLISHED' AND s.day BETWEEN $2 AND $3`, [v.wfmGroupId, from, to]),
    }));
    const vol = new Map<string, number>(act.map((x: any) => [`${x.day}|${x.slot}`, x.vol]));
    const staffed = new Map<string, number>(); const schedDays = new Set<string>();
    for (const x of sch) { schedDays.add(x.day); for (let g = x.startSlot; g < Math.min(96, x.startSlot + x.lengthSlots); g++) staffed.set(`${x.day}|${g}`, (staffed.get(`${x.day}|${g}`) ?? 0) + 1); }
    const step = grain === '15' ? 1 : grain === '30' ? 2 : grain === '60' ? 4 : 96;
    const total = (day: string, first: number) => { let t = 0, n = 0; for (let g = first; g < first + step; g++) { const k = `${day}|${g}`; if (vol.has(k)) { t += vol.get(k)!; n++; } } return { t, n }; };
    buckets = buckets.map((b: any) => {
      const first = grain === 'day' ? 0 : b.slot;
      const a = total(b.day, first), h = total(addDays(b.day, -7), first);
      const need = grain === 'day' ? 80 : step;              // a bucket only counts as "actual" once every interval in it has arrived
      let sched: number | null = null;
      if (schedDays.has(b.day)) { sched = 0; for (let g = first; g < first + step; g++) sched = Math.max(sched, staffed.get(`${b.day}|${g}`) ?? 0); }
      return { ...b, actual: a.n >= need ? a.t : null, lastWeek: h.n >= need ? h.t : null, scheduled: sched };
    });
  }
  res.json({
    version: versionDto(v), grain, from, to, queueId: q.queueId ?? null, buckets,
    group: { id: group.id, name: group.name, serviceLevel: group.serviceLevel, answerSec: group.answerSec, shrinkage: group.shrinkage, occupancyCap: group.occupancyCap, method: group.method },
    queues: group.queues.map((x) => ({ id: x.id, name: x.name, channel: x.channel })),
  });
});

// ---------------------------------------------------------------- leaderboard (backtest results stored with the version)

const STAB: Record<string, string> = { HIGH: 'Steady', MEDIUM: 'Some swings', VARIABLE: 'Swings a lot' };
const MODEL_NAME: Record<string, string> = {
  snaive: 'Seasonal naive (same as last week)', wavg: 'Weighted weekly average', ets: 'Holt-Winters (ETS)', gbm: 'Gradient boosting (multi-feature)', combo: 'Ensemble (ETS + weekly average + boosting)', croston: 'Croston (sparse queues)', sarima: 'Seasonal ARIMA (weekly cycle, 12+ weeks of history)', arima: 'ARIMA with weekday effects (12+ weeks of history)',
};
forecast.get('/versions/:id/leaderboard', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id), queueId = req.query.queueId ? parse(uuid, req.query.queueId) : null;
  const v = await withTenant(p.tenantId, (tx) => loadVersion(tx, id));
  const series: any[] = v.summary?.series ?? [];
  const s = series.find((x) => (queueId ? x.queueId === queueId : x.queueId === null)) ?? series[0];
  if (!s) throw notFound('Backtest results');
  const ranked = [...s.scores].sort((a: any, b: any) => a.mase - b.mase);
  const naive = s.scores.find((x: any) => x.model === 'snaive');
  // MASE is scaled by in-sample naive error, so the baseline's own MASE is not 1: compare each model with the baseline's score
  const vsBase = (m: any) => (naive?.mase ? 1 - m.mase / naive.mase : 0);
  const rows = ranked.map((m: any, i: number) => {
    const gain = vsBase(m);
    const better = gain >= 0 ? `${Math.round(gain * 100)}% better than the baseline` : `${Math.round(-gain * 100)}% worse than the baseline`;
    return {
      modelId: m.model, modelName: MODEL_NAME[m.model] ?? m.model, rank: i + 1, isRecommended: !!m.selected,
      wapePercent: r2(m.wape * 100), mapePercent: r2(m.mape * 100), mae: m.mae, rmse: m.rmse, biasPercent: r2(m.bias * 100), stabilityScore: m.stability, stability: STAB[m.stability] ?? m.stability,
      vsBaselinePercent: r2(gain * 100),
      recommendationReason: m.model === 'snaive' ? 'The simple baseline: "same as last week". Every other model has to beat it.'
        : m.selected ? `Chosen: ${r2(m.wape * 100)}% average miss, ${better}.` : i === 0 ? `Most accurate, but not the one in use. ${better}.` : `${better}; ${m.stability === 'HIGH' ? 'steady from week to week' : 'error moves around between weeks'}.`,
      backtestPeriod: 'Last 4 weeks (rolling 7-day-ahead forecasts)',
    };
  });
  res.json({ versionId: id, queueId: s.queueId, queueName: s.name, baselineWapePercent: naive ? r2(naive.wape * 100) : null, cleanedDays: s.cleanedDays, sigmaRel: s.sigmaRel, notes: s.notes, rows, series: series.map((x) => ({ queueId: x.queueId, name: x.name })) });
});

// ---------------------------------------------------------------- adjustments (draft only, reason mandatory)

const Adjust = z.object({
  mode: z.enum(['pct', 'add', 'total', 'reset']), value: z.number().optional(), from: z.string().regex(isoDay).optional(), to: z.string().regex(isoDay).optional(),
  slotFrom: z.number().int().min(0).max(95).optional(), slotTo: z.number().int().min(0).max(95).optional(), queueId: uuid.nullable().optional(),
  reason: z.string().trim().min(3, 'is required: say why the forecast is being changed'),
});
forecast.patch('/versions/:id/adjustments', requires('forecast:adjust'), async (req, res) => {
  const p = me(req), id = String(req.params.id), b = parse(Adjust, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    if (v.status !== 'DRAFT') throw conflict(`Only a draft can be adjusted (this one is ${v.status.toLowerCase()}). Return it to draft, or clone it, to make changes.`);
    const from = b.from ?? v.fromDay, to = b.to ?? b.from ?? v.toDay;
    const long = v.kind === 'LONG';
    const sf = long ? -1 : b.slotFrom ?? 0, st = long ? -1 : b.slotTo ?? 95;
    if (b.mode !== 'reset' && b.value === undefined) throw bad('value is required');
    if (b.mode === 'total' && b.value! < 0) throw bad('The total must be zero or more');
    if (b.mode === 'pct' && b.value! <= -100) throw bad('A percentage change must be above -100');
    const where = 'tenant_id = :t AND version_id = $1 AND day BETWEEN $2 AND $3 AND slot BETWEEN $4 AND $5 AND ($6::uuid IS NULL OR queue_id = $6)';
    const args = [id, from, to, sf, st, b.queueId ?? null];
    const totals = async () => (await tx.one<{ t: number; n: number }>(`SELECT coalesce(sum(coalesce(manual, volume)), 0)::float8 AS t, count(*)::int AS n FROM forecast_intervals WHERE ${where}`, args))!;
    const before = await totals();
    if (!before.n) throw bad('Nothing to adjust in that range');
    let changed = 0;
    if (b.mode === 'reset') changed = await tx.exec(`UPDATE forecast_intervals SET manual = NULL WHERE ${where} AND manual IS NOT NULL`, args);
    else if (b.mode === 'pct') changed = await tx.exec(`UPDATE forecast_intervals SET manual = greatest(0, coalesce(manual, volume) * (1 + $7::float8 / 100)) WHERE ${where}`, [...args, b.value]);
    else if (b.mode === 'add') changed = await tx.exec(`UPDATE forecast_intervals SET manual = greatest(0, coalesce(manual, volume) + CASE WHEN $8::float8 > 0 THEN $7::float8 * coalesce(manual, volume) / $8::float8 ELSE $7::float8 / $9::float8 END) WHERE ${where}`, [...args, b.value, before.t, before.n]);
    else changed = await tx.exec(`UPDATE forecast_intervals SET manual = greatest(0, CASE WHEN $8::float8 > 0 THEN coalesce(manual, volume) * $7::float8 / $8::float8 ELSE $7::float8 / $9::float8 END) WHERE ${where}`, [...args, b.value, before.t, before.n]);
    const after = await totals();
    await tx.exec(`UPDATE forecast_versions SET rev = rev + 1, type = 'ADJUSTED' WHERE tenant_id = :t AND id = $1`, [id]);
    const what = b.mode === 'pct' ? `${b.value! > 0 ? '+' : ''}${b.value}%` : b.mode === 'add' ? `${b.value! > 0 ? '+' : ''}${b.value} contacts` : b.mode === 'total' ? `set to ${b.value} contacts` : 'adjustments removed';
    await audit(tx, p, req, {
      action: 'ADJUST', entityType: 'FORECAST_VERSION', entityId: id, entityName: v.name, reason: b.reason,
      before: { volume: r2(before.t) }, after: { volume: r2(after.t), mode: b.mode, value: b.value ?? null, from, to, slotFrom: sf, slotTo: st, queueId: b.queueId ?? null, rows: changed },
      diffSummary: `${what} on ${changed} rows (${from}${to !== from ? ` to ${to}` : ''}): ${Math.round(before.t)} -> ${Math.round(after.t)} contacts`,
    });
    return { ok: true, rows: changed, beforeVolume: r2(before.t), afterVolume: r2(after.t) };
  });
  res.json(out);
});

// ---------------------------------------------------------------- lifecycle: Draft -> Submitted -> Approved -> Published (-> Archived)

type Status = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
async function move(req: any, res: any, from: Status[], to: Status, action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'PUBLISH', reasonRequired = false) {
  const p = me(req), id = String(req.params.id);
  const reason = String(req.body?.reason ?? '').trim();
  if (reasonRequired && reason.length < 3) throw bad('A reason is required');
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await tx.one<any>('SELECT * FROM forecast_versions WHERE tenant_id = :t AND id = $1 FOR UPDATE', [id]);
    if (!v) throw notFound('Forecast version');
    if (!from.includes(v.status)) throw conflict(`Cannot ${action.toLowerCase()} a ${v.status.toLowerCase()} forecast (allowed from: ${from.join(', ').toLowerCase()}).`);
    if (action === 'APPROVE') {
      const t = await tx.one<{ fourEyes: boolean }>('SELECT four_eyes FROM tenants WHERE id = :t');
      if (t?.fourEyes && v.submittedById === p.userId) throw new HttpError(403, 'FOUR_EYES', 'Four-eyes rule: the person who submitted a forecast cannot approve it.');
    }
    if (action === 'PUBLISH') await tx.exec(`UPDATE forecast_versions SET status = 'ARCHIVED' WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status = 'PUBLISHED' AND id <> $3`, [v.wfmGroupId, v.kind, id]);
    const upd: Record<typeof action, { set: string; params: unknown[] }> = {
      SUBMIT: { set: 'submitted_by = $2, submitted_by_id = $3, submitted_at = now()', params: [p.name, p.userId] },
      APPROVE: { set: 'approved_by = $2, approved_at = now()', params: [p.name] },
      REJECT: { set: 'submitted_by = NULL, submitted_by_id = NULL, submitted_at = NULL, approved_by = NULL, approved_at = NULL', params: [] },
      PUBLISH: { set: 'published_by = $2, published_at = now()', params: [p.name] },
    };
    await tx.exec(`UPDATE forecast_versions SET status = '${to}', ${upd[action].set} WHERE tenant_id = :t AND id = $1`, [id, ...upd[action].params]);
    await audit(tx, p, req, { action, entityType: 'FORECAST_VERSION', entityId: id, entityName: v.name, reason: reason || undefined, before: { status: v.status }, after: { status: to } });
    return tx.one<any>('SELECT * FROM forecast_versions WHERE tenant_id = :t AND id = $1', [id]);
  });
  if (action === 'PUBLISH') { await dropCache(p.tenantId, 'sched:*'); }
  publish(p.tenantId, ['forecast', action.toLowerCase()], { id, name: out.name, status: out.status, by: p.name });
  res.json(versionDto(out));
}
forecast.post('/versions/:id/submit', requires('forecast:submit'), (req, res) => move(req, res, ['DRAFT'], 'SUBMITTED', 'SUBMIT'));
forecast.post('/versions/:id/approve', requires('forecast:approve'), (req, res) => move(req, res, ['SUBMITTED'], 'APPROVED', 'APPROVE'));
forecast.post('/versions/:id/reject', requiresAny('forecast:approve', 'forecast:submit'), (req, res) => move(req, res, ['SUBMITTED', 'APPROVED'], 'DRAFT', 'REJECT', true));
forecast.post('/versions/:id/publish', requires('forecast:publish'), (req, res) => move(req, res, ['APPROVED'], 'PUBLISHED', 'PUBLISH'));

forecast.post('/versions/:id/clone', requires('forecast:create'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const out = await withTenant(p.tenantId, async (tx) => {
    const v = await loadVersion(tx, id);
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`fv:${v.wfmGroupId}:${v.kind}`]);
    const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2', [v.wfmGroupId, v.kind]))!.n;
    const name = `${shortLabel(v.kind)} v${seq} (copy of v${v.seq})`;
    const c = await tx.one<any>(
      `INSERT INTO forecast_versions (tenant_id, wfm_group_id, seq, name, kind, type, from_day, to_day, slots_per_day, model_req, summary, created_by, parent_version_id)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [v.wfmGroupId, seq, name, v.kind, v.type, v.fromDay, v.toDay, v.slotsPerDay, v.modelReq, JSON.stringify(v.summary), p.name, id]);
    await tx.exec(`INSERT INTO forecast_intervals SELECT tenant_id, $2, queue_id, day, slot, volume, aht_sec, p10, p90, manual FROM forecast_intervals WHERE tenant_id = :t AND version_id = $1`, [id, c!.id]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'FORECAST_VERSION', entityId: c!.id, entityName: name, after: { clonedFrom: id, fromVersion: v.seq } });
    return c;
  });
  res.status(201).json({ ...versionDto(out), summary: out.summary });
});

forecast.get('/versions/:id/export.csv', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const { v, rows } = await withTenant(p.tenantId, async (tx) => ({
    v: await loadVersion(tx, id),
    rows: await tx.q<any>(`SELECT q.name AS queue, f.day::text AS day, f.slot, f.volume, f.manual, f.aht_sec, f.p10, f.p90 FROM forecast_intervals f JOIN queues q ON q.id = f.queue_id
                           WHERE f.tenant_id = :t AND f.version_id = $1 ORDER BY f.day, f.slot, q.name`, [id]),
  }));
  const lines = ['queue,date,interval,forecast_contacts,adjusted_contacts,effective_contacts,aht_sec,low_estimate,high_estimate'];
  for (const r of rows) {
    const t = r.slot < 0 ? 'day' : `${String(Math.floor(r.slot / 4)).padStart(2, '0')}:${String((r.slot % 4) * 15).padStart(2, '0')}`;
    lines.push([`"${String(r.queue).replace(/"/g, '""')}"`, r.day, t, r.volume.toFixed(2), r.manual === null ? '' : r.manual.toFixed(2), (r.manual ?? r.volume).toFixed(2), r.ahtSec.toFixed(1), r.p10.toFixed(2), r.p90.toFixed(2)].join(','));
  }
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="forecast-v${v.seq}.csv"`);
  res.send(lines.join('\n'));
});

// ---------------------------------------------------------------- scenarios (what-if)

const Params = z.object({
  volumePct: z.number().min(-90).max(500).optional(), ahtPct: z.number().min(-90).max(500).optional(), serviceLevel: z.number().gt(0).lt(1).optional(), answerSec: z.number().int().positive().max(600).optional(),
  shrinkage: z.number().min(0).max(0.9).optional(), occupancyCap: z.number().gt(0.3).lte(1).optional(), method: z.enum(['erlang_c', 'erlang_a']).optional(), blended: z.boolean().optional(),
});
forecast.get('/versions/:id/scenarios', requires('forecast:read'), async (req, res) => {
  res.json(await withTenant(me(req).tenantId, (tx) => tx.q('SELECT id, name, description, params, created_by, created_at FROM forecast_scenarios WHERE tenant_id = :t AND version_id = $1 ORDER BY created_at', [String(req.params.id)])));
});
forecast.post('/versions/:id/scenarios', requires('forecast:create'), async (req, res) => {
  const p = me(req), b = parse(z.object({ name: z.string().min(1).max(80), description: z.string().max(300).optional(), params: Params }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    await loadVersion(tx, String(req.params.id));
    const s = await tx.one<any>(`INSERT INTO forecast_scenarios (tenant_id, version_id, name, description, params, created_by) VALUES (:t, $1, $2, $3, $4, $5) RETURNING id, name, description, params`,
      [String(req.params.id), b.name, b.description ?? '', JSON.stringify(b.params), p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'FORECAST_SCENARIO', entityId: s!.id, entityName: b.name, after: b.params });
    return s;
  });
  res.status(201).json(out);
});
forecast.delete('/scenarios/:id', requires('forecast:create'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const s = await tx.one<any>('SELECT * FROM forecast_scenarios WHERE tenant_id = :t AND id = $1', [String(req.params.id)]);
    if (!s) throw notFound('Scenario');
    await tx.exec('DELETE FROM forecast_scenarios WHERE tenant_id = :t AND id = $1', [s.id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'FORECAST_SCENARIO', entityId: s.id, entityName: s.name, before: s.params });
  });
  res.json({ ok: true });
});

forecast.post('/versions/:id/scenarios/compare', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const list = parse(z.object({ scenarios: z.array(z.object({ name: z.string().min(1).max(80), params: Params })).max(5) }), req.body).scenarios;
  const { v, group } = await withTenant(p.tenantId, async (tx) => { const v = await loadVersion(tx, id); return { v, group: await loadGroup(tx, v.wfmGroupId) }; });
  const cap4 = addDays(v.fromDay, 27);                                 // short-term what-if covers up to four weeks
  const to = v.kind === 'LONG' || v.toDay <= cap4 ? v.toDay : cap4;
  const data = v.kind === 'LONG' ? (await versionRecords(p.tenantId, v)).daily : await withTenant(p.tenantId, (tx) => versionRows(tx, id, { from: v.fromDay, to }));
  const factor = v.kind === 'LONG' ? await erlangFactor(p.tenantId, group) : 1;
  const results: any[] = [];
  for (const s of [{ name: 'Baseline', params: {} as Overrides }, ...list]) results.push(await scenarioResult(v, group, data, s.name, s.params, factor, to));
  const base = results[0];
  for (const r of results) { r.impactRequiredFteDelta = r2(r.fte - base.fte); r.impactServiceLevelDelta = r.serviceLevel !== null && base.serviceLevel !== null ? r2((r.serviceLevel - base.serviceLevel) * 100) : null; }
  res.json({ version: versionDto(v), window: { from: v.fromDay, to }, results });
});

// ---------------------------------------------------------------- capacity plan (long-term)

forecast.get('/versions/:id/capacity', requires('forecast:read'), async (req, res) => {
  const p = me(req), id = String(req.params.id);
  const { v, group } = await withTenant(p.tenantId, async (tx) => { const v = await loadVersion(tx, id); return { v, group: await loadGroup(tx, v.wfmGroupId) }; });
  const { daily } = await versionRecords(p.tenantId, v);
  const factor = await erlangFactor(p.tenantId, group);
  const cap = capacityFor(group, daily, factor);
  const grain = req.query.grain === 'week' ? 'week' : 'month';
  const by = new Map<string, any>();
  const keyOf = (d: string) => rollup([{ day: d, volume: 0, aht: 0, p10: 0, p90: 0, edited: false }], grain)[0].period;
  for (const d of cap) {
    const k = keyOf(d.day);
    const c = by.get(k) ?? { period: k, days: 0, volume: 0, workloadHours: 0, agentHours: 0, peakDayHours: 0 };
    c.days++; c.volume += d.volume; c.workloadHours += d.workloadHours; c.agentHours += d.agentHours; c.peakDayHours = Math.max(c.peakDayHours, d.agentHours); by.set(k, c);
  }
  res.json({
    version: versionDto(v), factor: r2(factor), fteHoursWeek: group.fteHoursWeek, shrinkage: group.shrinkage,
    periods: [...by.values()].map((c) => ({ period: c.period, days: c.days, volume: Math.round(c.volume), workloadHours: r2(c.workloadHours), agentHours: r2(c.agentHours),
      fte: r2(c.agentHours / (group.fteHoursWeek * (c.days / 7))), peakFte: r2(c.peakDayHours / (group.fteHoursWeek / 7)) })),
  });
});

// ---------------------------------------------------------------- accuracy (hold-out + realised)

forecast.get('/accuracy', requires('forecast:read'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ groupId: uuid, days: z.coerce.number().int().min(7).max(28).default(14) }), req.query);
  const ho = await holdout(p, q.groupId, q.days);
  const real = await withTenant(p.tenantId, async (tx) => realised(tx, q.groupId, todayIn((await loadGroup(tx, q.groupId)).timezone)));
  res.json({ ...ho, realised: real });
});

// ---------------------------------------------------------------- staffing traceability

forecast.post('/trace-staffing', requires('forecast:read'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({
    groupId: uuid, volume: z.number().min(0), ahtSec: z.number().positive(), channel: z.enum(['voice', 'chat']).default('voice'),
    serviceLevel: z.number().gt(0).lt(1).optional(), answerSec: z.number().positive().optional(), occupancyCap: z.number().gt(0.3).lte(1).optional(), shrinkage: z.number().min(0).max(0.9).optional(), method: z.enum(['erlang_c', 'erlang_a']).optional(),
  }), req.body);
  const group = await withTenant(p.tenantId, (tx) => loadGroup(tx, b.groupId));
  const chat = group.queues.filter((q) => q.channel === 'chat');
  const base = {
    channel: b.channel, service_level: b.serviceLevel ?? group.serviceLevel, answer_sec: b.answerSec ?? group.answerSec, occupancy_cap: b.occupancyCap ?? group.occupancyCap,
    method: b.method ?? group.method, patience_sec: group.patienceSec, concurrency: b.channel === 'chat' ? (chat.length ? sum(chat.map((q) => q.concurrency)) / chat.length : 2) : 1, open_slot: 0, close_slot: 96,
  };
  const shrink = b.shrinkage ?? group.shrinkage;
  const run = async (vol: number, over: object = {}) => (await engine.staffing({ inputs: [{ channel: b.channel, day: '2000-01-03', slot: 40, volume: vol, aht_sec: b.ahtSec }], params: [{ ...base, ...over }], interval_min: 15, shrinkage: shrink })).out[0];
  const r = await run(b.volume), raw = await run(b.volume, { occupancy_cap: 1 });
  const conc = base.concurrency > 1 ? base.concurrency * 0.85 : 1;
  const traffic = (b.volume * b.ahtSec) / conc / 900;
  const sens = [];
  for (const pct of [-20, -10, 0, 10, 20]) { const o = await run(b.volume * (1 + pct / 100)); sens.push({ changePct: pct, volume: r2(b.volume * (1 + pct / 100)), agents: o.base, onSchedule: o.required }); }
  const d1 = (v: number) => (Math.round(v * 10) / 10).toString();
  res.json({
    channel: b.channel, method: base.method, volume: b.volume, ahtSec: b.ahtSec, trafficErlangs: r2(traffic), slaTarget: base.service_level, answerSec: base.answer_sec, occupancyCap: base.occupancy_cap, shrinkage: shrink,
    rawAgents: raw.base, agents: r.base, onSchedule: r.required, serviceLevel: r.service_level, occupancy: r.occupancy, asaSec: r.asa_sec, abandon: r.abandon, warn: r.warn, sensitivity: sens,
    steps: [
      `Forecast: ${d1(b.volume)} contacts in 15 minutes at ${Math.round(b.ahtSec)}s average handle time.`,
      `Workload (offered traffic) = contacts × AHT ÷ interval seconds = ${d1(b.volume)} × ${Math.round(b.ahtSec)} ÷ 900 = ${d1(traffic * conc)} Erlangs` + (conc > 1 ? `, ÷ ${d1(conc)} effective chats at once = ${d1(traffic)} Erlangs.` : '.'),
      `${base.method === 'erlang_a' ? 'Erlang A (with abandonment)' : 'Erlang C'}: fewest agents that answer ${Math.round(base.service_level * 100)}% within ${base.answer_sec}s → ${raw.base} agents (achieves ${Math.round(raw.service_level * 1000) / 10}%).`,
      r.base > raw.base ? `Occupancy cap ${Math.round(base.occupancy_cap * 100)}%: ${raw.base} agents would be busy ${Math.round(raw.occupancy * 100)}% of the time, so the cap raises it to ${r.base} agents.` : `Occupancy check: ${r.base} agents are busy ${Math.round(r.occupancy * 100)}% of the time, within the ${Math.round(base.occupancy_cap * 100)}% cap.`,
      `Shrinkage ${Math.round(shrink * 100)}% (breaks, training, absence): ${r.base} ÷ (1 − ${shrink}) = ${d1(r.base / (1 - shrink))} → ${r.required} agents on the schedule.`,
    ],
  });
});

// ---------------------------------------------------------------- special events (holidays, campaigns, outages)

forecast.get('/events', requires('forecast:read'), async (req, res) => {
  const groupId = req.query.groupId ? parse(uuid, req.query.groupId) : null;
  res.json(await withTenant(me(req).tenantId, (tx) => tx.q(
    `SELECT e.id, e.wfm_group_id, e.queue_id, g.name AS group_name, q.name AS queue_name, e.name, e.kind, e.start_day::text AS start_day, e.end_day::text AS end_day, e.uplift_pct, e.lead_days, e.lag_days
     FROM special_events e LEFT JOIN wfm_groups g ON g.id = e.wfm_group_id LEFT JOIN queues q ON q.id = e.queue_id
     WHERE e.tenant_id = :t AND ($1::uuid IS NULL OR e.wfm_group_id IS NULL OR e.wfm_group_id = $1) ORDER BY e.start_day DESC`, [groupId])));
});
forecast.post('/events', requires('forecast:create'), async (req, res) => {
  const p = me(req);
  const b = parse(z.object({
    groupId: uuid.nullable().optional(), queueId: uuid.nullable().optional(), name: z.string().min(1).max(100), kind: z.enum(['holiday', 'campaign', 'outage', 'other']).default('campaign'),
    startDay: z.string().regex(isoDay), endDay: z.string().regex(isoDay).optional(), upliftPct: z.number().min(-95).max(500).default(0),
    leadDays: z.number().int().min(0).max(60).default(0), lagDays: z.number().int().min(0).max(60).default(0),
  }), req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<any>(
      `INSERT INTO special_events (tenant_id, wfm_group_id, queue_id, name, kind, start_day, end_day, uplift_pct, lead_days, lag_days) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [b.groupId ?? null, b.queueId ?? null, b.name, b.kind, b.startDay, b.endDay ?? b.startDay, b.upliftPct, b.leadDays, b.lagDays]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'SPECIAL_EVENT', entityId: e!.id, entityName: b.name, after: b });
    return e;
  });
  res.status(201).json(out);
});
forecast.delete('/events/:id', requires('forecast:create'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const e = await tx.one<any>('SELECT * FROM special_events WHERE tenant_id = :t AND id = $1', [String(req.params.id)]);
    if (!e) throw notFound('Event');
    await tx.exec('DELETE FROM special_events WHERE tenant_id = :t AND id = $1', [e.id]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'SPECIAL_EVENT', entityId: e.id, entityName: e.name, before: e });
  });
  res.json({ ok: true });
});

// keep helpers referenced by other modules
export { SLOT_H, aggregateStaff, runStaffing, num };
export type { Group };

// ---------------------------------------------------------------- self-learning

const groupQ = z.object({ groupId: uuid });
const LearningQ = groupQ.extend({ days: z.coerce.number().int().min(7).max(730).default(60) });

forecast.get('/learning', requires('forecast:read'), async (req, res) => {
  const p = me(req), q = parse(LearningQ, req.query);
  const data = await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<any>('SELECT auto_learn FROM wfm_groups WHERE tenant_id = :t AND id = $1', [q.groupId]);
    if (!g) throw notFound('WFM group');
    const factors = await tx.q<any>(
      `SELECT f.queue_id, qu.name AS queue_name, f.dow, f.factor::float8 AS factor, f.samples, f.updated_at FROM forecast_feedback f JOIN queues qu ON qu.id = f.queue_id
       WHERE f.tenant_id = :t AND f.wfm_group_id = $1 ORDER BY qu.name, f.dow`, [q.groupId]);
    // a time window, not a row count, so a burst of same-day imports does not crowd out the trend: the chart wants an even spread over the period asked for
    const runs = await tx.q<any>(
      `SELECT id, at, trigger, days, wape::float8 AS wape, bias::float8 AS bias, drift, action, version_id, note FROM learning_runs
       WHERE tenant_id = :t AND wfm_group_id = $1 AND at >= now() - ($2 || ' days')::interval ORDER BY id DESC LIMIT 500`, [q.groupId, q.days]);
    return { enabled: g.autoLearn as boolean, factors, runs };
  });
  const evaluation = await evaluate(p.tenantId, q.groupId);
  res.json({
    enabled: data.enabled, limits: { wape: LEARNING.wapeLimit, bias: LEARNING.biasLimit, minDays: LEARNING.minDays, windowDays: LEARNING.windowDays, minSamples: LEARNING.minSamples },
    evaluation, runsWindowDays: q.days, factors: data.factors.map((f) => ({ queueId: f.queueId, queueName: f.queueName, dow: f.dow, factor: f.factor, samples: f.samples, updatedAt: f.updatedAt })),
    runs: data.runs.map((r) => ({ id: Number(r.id), at: r.at, trigger: r.trigger, days: r.days, wape: r.wape, bias: r.bias, drift: r.drift, action: r.action, versionId: r.versionId, note: r.note })),
  });
});

/** "Learn now": compare recent real volume with the published forecast, update corrections, and prepare a draft if it has drifted. */
forecast.post('/learning/run', requires('forecast:create'), async (req, res) => {
  const p = me(req), q = parse(groupQ, req.body);
  res.json(await learn(p.tenantId, q.groupId, 'MANUAL', p));
});

forecast.put('/learning/settings', requires('forecast:create'), async (req, res) => {
  const p = me(req), b = parse(z.object({ groupId: uuid, enabled: z.boolean() }), req.body);
  await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<any>('UPDATE wfm_groups SET auto_learn = $2 WHERE tenant_id = :t AND id = $1 RETURNING name', [b.groupId, b.enabled]);
    if (!g) throw notFound('WFM group');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'WFM_GROUP', entityId: b.groupId, entityName: g.name, after: { forecastLearning: b.enabled }, diffSummary: `Forecast learning ${b.enabled ? 'switched on' : 'switched off'}` });
  });
  res.json({ enabled: b.enabled });
});

/** Forget what was learned (for example after a lasting change in the business). New forecasts go back to the plain model output. */
forecast.delete('/learning/factors', requires('forecast:create'), async (req, res) => {
  const p = me(req), q = parse(groupQ, req.query);
  const n = await withTenant(p.tenantId, async (tx) => {
    const c = (await tx.one<{ n: number }>('SELECT count(*)::int AS n FROM forecast_feedback WHERE tenant_id = :t AND wfm_group_id = $1', [q.groupId]))!.n;
    await tx.exec('DELETE FROM forecast_feedback WHERE tenant_id = :t AND wfm_group_id = $1', [q.groupId]);
    await audit(tx, p, req, { action: 'DELETE', entityType: 'FORECAST_LEARNING', entityId: q.groupId, entityName: 'Learned corrections', diffSummary: `${c} learned correction(s) cleared` });
    return c;
  });
  res.json({ cleared: n });
});
