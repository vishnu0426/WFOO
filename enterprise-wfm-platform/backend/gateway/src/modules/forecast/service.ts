/**
 * Forecasting orchestration. The gateway reads history, calls the Python engine over gRPC, stores numbered versions and
 * derives staffing, capacity, scenarios and accuracy from them. No forecasting maths lives here.
 */
import { withTenant, type Tx } from '../../db.ts';
import { cached, dropCache, engine, key } from '../../infra.ts';
import { audit } from '../../audit.ts';
import type { Principal } from '../../auth.ts';
import { bad, conflict, notFound } from '../../http.ts';

export const SLOT_H = 0.25;
export const MODELS = ['auto', 'snaive', 'wavg', 'ets', 'gbm', 'combo', 'croston', 'sarima', 'arima'] as const;
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
const r2 = (v: number) => Math.round(v * 100) / 100;
export const num = (v: unknown, d: number) => (v === null || v === undefined || v === '' || Number.isNaN(+(v as number)) ? d : +(v as number));

// ---------------------------------------------------------------- dates (strings, UTC arithmetic: no DST surprises)

const utc = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtUtc = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
export const addDays = (s: string, n: number) => { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return fmtUtc(d); };
export const dayRange = (from: string, to: string, max = 800) => { const o: string[] = []; for (let d = from; d <= to && o.length < max; d = addDays(d, 1)) o.push(d); return o; };
export const label = (s: string) => utc(s).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Today's calendar date in an IANA zone. */
export const todayIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Weekday with Monday = 0, from a calendar date string. */
export const dowOf = (s: string) => (utc(s).getUTCDay() + 6) % 7;

// ---------------------------------------------------------------- group + queues (engine-shaped)

export interface GQueue { id: string; idx: number; name: string; channel: 'voice' | 'chat' | 'email' | 'backoffice'; ahtDefault: number; concurrency: number; openSlot: number; closeSlot: number; turnaroundHours: number | null }
export interface Group {
  id: string; name: string; timezone: string; serviceLevel: number; answerSec: number; shrinkage: number; occupancyCap: number;
  method: 'erlang_c' | 'erlang_a'; patienceSec: number; blended: boolean; model: string; fteHoursWeek: number; queues: GQueue[];
}
const engCh = (c: string): 'voice' | 'chat' | 'email' | 'backoffice' => (c === 'VOICE' ? 'voice' : c === 'CHAT' ? 'chat' : c === 'BACKOFFICE' ? 'backoffice' : 'email');

export async function loadGroup(tx: Tx, id: string): Promise<Group> {
  const g = await tx.one<any>('SELECT * FROM wfm_groups WHERE tenant_id = :t AND id = $1', [id]);
  if (!g) throw notFound('WFM group');
  const qs = await tx.q<any>('SELECT * FROM queues WHERE tenant_id = :t AND wfm_group_id = $1 ORDER BY name', [id]);
  // named shrinkage categories (breaks, training, absence, ...), if any, replace the flat percentage: their sum is
  // the effective shrinkage used for staffing, so the breakdown drives the number rather than just documenting it.
  const cats = await tx.q<{ pct: number }>('SELECT pct::float8 AS pct FROM shrinkage_categories WHERE tenant_id = :t AND wfm_group_id = $1', [id]);
  const shrinkage = cats.length ? Math.min(0.9, cats.reduce((s, c) => s + c.pct, 0) / 100) : g.shrinkage;
  return {
    id: g.id, name: g.name, timezone: g.timezone, serviceLevel: g.serviceLevel, answerSec: g.answerSec, shrinkage, occupancyCap: g.occupancyCap,
    method: g.method, patienceSec: g.patienceSec, blended: g.blended, model: g.model, fteHoursWeek: g.fteHoursWeek,
    queues: qs.map((q, i) => ({ id: q.id, idx: i + 1, name: q.name, channel: engCh(q.channel), ahtDefault: q.ahtDefault, concurrency: q.concurrency, openSlot: q.openSlot, closeSlot: q.closeSlot, turnaroundHours: q.turnaroundHours ?? null })),
  };
}

export interface Overrides { volumePct?: number; ahtPct?: number; serviceLevel?: number; answerSec?: number; shrinkage?: number; occupancyCap?: number; method?: string; blended?: boolean }

function channelParams(group: Group, over: Overrides = {}) {
  return [...new Set(group.queues.map((q) => q.channel))].map((channel) => {
    const qs = group.queues.filter((q) => q.channel === channel);
    // several back-office queues can share one pool with different turnaround targets; the tightest one governs it,
    // since staffing to a looser average would risk breaching the queue that promised the fastest turnaround.
    const turnarounds = qs.map((q) => q.turnaroundHours).filter((h): h is number => h !== null && h > 0);
    return {
      channel, service_level: num(over.serviceLevel, group.serviceLevel), answer_sec: num(over.answerSec, group.answerSec), occupancy_cap: num(over.occupancyCap, group.occupancyCap),
      method: over.method || group.method, patience_sec: group.patienceSec,
      concurrency: channel === 'chat' ? sum(qs.map((q) => q.concurrency)) / qs.length : 1,
      open_slot: Math.min(...qs.map((q) => q.openSlot)), close_slot: Math.max(...qs.map((q) => q.closeSlot)),
      turnaround_hours: channel === 'backoffice' && turnarounds.length ? Math.min(...turnarounds) : 0,
    };
  });
}

// ---------------------------------------------------------------- staffing via the engine

export interface QRow { queueId: string; day: string; slot: number; vol: number; aht: number }
export interface StaffOut { channel: string; day: string; slot: number; base: number; required: number; occupancy: number; service_level: number; asa_sec: number; abandon: number; warn: boolean }

export async function runStaffing(group: Group, rows: QRow[], over: Overrides = {}): Promise<StaffOut[]> {
  const chan = new Map(group.queues.map((q) => [q.id, q.channel]));
  const inputs = rows.filter((r) => r.vol > 0 && chan.has(r.queueId)).map((r) => ({ channel: chan.get(r.queueId)!, day: r.day, slot: r.slot, volume: r.vol, aht_sec: r.aht }));
  if (!inputs.length) return [];
  const used = new Set(rows.map((r) => r.queueId));
  const g = { ...group, queues: group.queues.filter((q) => used.has(q.id)) };
  const res = await engine.staffing({ inputs, params: channelParams(g, over), interval_min: 15, shrinkage: num(over.shrinkage, group.shrinkage), blend: over.blended ?? group.blended });
  return res.out;
}

export interface StaffAgg { required: number; base: number; occ: number; sl: number; warn: boolean }
export function aggregateStaff(out: StaffOut[]): Map<string, StaffAgg> {
  const m = new Map<string, StaffAgg>();
  for (const o of out) {
    const k = `${o.day}|${o.slot}`;
    const c = m.get(k) ?? { required: 0, base: 0, occ: 0, sl: 1, warn: false };
    c.required += o.required; c.base += o.base; c.occ += o.occupancy * o.base; c.sl = Math.min(c.sl, o.service_level); c.warn = c.warn || o.warn;
    m.set(k, c);
  }
  for (const c of m.values()) c.occ = c.base ? c.occ / c.base : 0;
  return m;
}

// ---------------------------------------------------------------- long-range scheduling: an interval shape synthesized from history

const SHAPE_WEEKS = 12; // how far back to look for a same-weekday intraday shape

/** A queue's own historical intraday shape for one weekday: each 15-minute slot's share of the day's volume,
 * averaged over the last SHAPE_WEEKS same weekdays. Falls back to a flat shape if there is no history yet. */
async function intradayShape(tx: Tx, queueId: string, dow: number): Promise<number[]> {
  const pgDow = (dow + 1) % 7; // our Monday = 0, Postgres EXTRACT(DOW) Sunday = 0
  const rows = await tx.q<{ slot: number; volume: number }>(
    `SELECT slot, volume::float8 AS volume FROM interval_history
     WHERE tenant_id = :t AND queue_id = $1 AND extract(dow FROM day) = $2 AND day >= current_date - ($3 * 7) AND slot >= 0`,
    [queueId, pgDow, SHAPE_WEEKS]);
  const bySlot = new Array(96).fill(0);
  for (const r of rows) bySlot[r.slot] += r.volume;
  const total = bySlot.reduce((a, b) => a + b, 0);
  return total > 0 ? bySlot.map((v) => v / total) : new Array(96).fill(1 / 96);
}

/**
 * Turns a published long-term forecast's daily totals for `days` into a per-slot required-staff array, so
 * scheduling can reach past the short-term forecast's horizon: each day's volume is split across intervals using
 * the queue's own historical intraday shape, then run through the same Erlang staffing calculation a short-term
 * forecast uses. This is a projection, not a real interval forecast -- callers must label it as lower-confidence,
 * the further out a day is the less this shape can be trusted to still match reality.
 */
export async function synthesizeLongRangeRequirement(tenantId: string, groupId: string, longVersionId: string, days: string[]): Promise<{ required: number[]; uncovered: string[] }> {
  const { group, totals } = await withTenant(tenantId, async (tx) => ({
    group: await loadGroup(tx, groupId),
    totals: await tx.q<{ queueId: string; day: string; volume: number; aht: number }>(
      `SELECT queue_id, day::text AS day, volume::float8 AS volume, aht_sec::float8 AS aht FROM forecast_intervals
       WHERE tenant_id = :t AND version_id = $1 AND slot < 0 AND day = ANY($2::date[])`, [longVersionId, days]),
  }));
  const covered = new Set(totals.map((t) => t.day));
  const uncovered = days.filter((d) => !covered.has(d));
  const required = new Array(days.length * 96).fill(0);
  if (!totals.length) return { required, uncovered };

  const rows: QRow[] = await withTenant(tenantId, async (tx) => {
    const shapeCache = new Map<string, number[]>();
    const out: QRow[] = [];
    for (const t of totals) {
      const dow = dowOf(t.day), cacheKey = `${t.queueId}|${dow}`;
      let shape = shapeCache.get(cacheKey);
      if (!shape) { shape = await intradayShape(tx, t.queueId, dow); shapeCache.set(cacheKey, shape); }
      for (let slot = 0; slot < 96; slot++) if (shape[slot] > 0) out.push({ queueId: t.queueId, day: t.day, slot, vol: t.volume * shape[slot], aht: t.aht });
    }
    return out;
  });

  const staff = aggregateStaff(await runStaffing(group, rows));
  const di = new Map(days.map((d, i) => [d, i]));
  for (const [k, v] of staff) {
    const sep = k.lastIndexOf('|'), day = k.slice(0, sep), i = di.get(day);
    if (i !== undefined) required[i * 96 + Number(k.slice(sep + 1))] = v.required;
  }
  return { required, uncovered };
}

// ---------------------------------------------------------------- version rows

export interface VRow { queueId: string; day: string; slot: number; volume: number; aht: number; p10: number; p90: number; manual: number | null; vol: number; edited: boolean }

export async function versionRows(tx: Tx, versionId: string, o: { from?: string; to?: string; queueId?: string | null; slots?: boolean } = {}): Promise<VRow[]> {
  const rows = await tx.q<any>(
    `SELECT queue_id, day::text AS day, slot, volume::float8 AS volume, aht_sec::float8 AS aht, p10::float8 AS p10, p90::float8 AS p90, manual::float8 AS manual
     FROM forecast_intervals WHERE tenant_id = :t AND version_id = $1 AND ($2::date IS NULL OR day >= $2) AND ($3::date IS NULL OR day <= $3)
       AND ($4::uuid IS NULL OR queue_id = $4) AND ${o.slots === false ? 'slot < 0' : 'slot >= 0'} ORDER BY day, slot, queue_id`,
    [versionId, o.from ?? null, o.to ?? null, o.queueId ?? null]);
  return rows.map((r) => ({ ...r, vol: r.manual ?? r.volume, edited: r.manual !== null }));
}

export const versionDto = (v: any) => ({
  id: v.id, seq: v.seq, wfmGroupId: v.wfmGroupId, forecastId: v.wfmGroupId, versionNumber: v.seq, name: v.name, kind: v.kind, type: v.type, status: v.status,
  fromDay: v.fromDay, toDay: v.toDay, slotsPerDay: v.slotsPerDay, modelReq: v.modelReq, rev: v.rev, parentVersionId: v.parentVersionId,
  createdBy: v.createdBy, createdAt: v.createdAt, submittedBy: v.submittedBy, submittedAt: v.submittedAt, approvedBy: v.approvedBy, approvedAt: v.approvedAt,
  publishedBy: v.publishedBy, publishedAt: v.publishedAt,
});

export async function loadVersion(tx: Tx, id: string) {
  const v = await tx.one<any>('SELECT * FROM forecast_versions WHERE tenant_id = :t AND id = $1', [id]);
  if (!v) throw notFound('Forecast version');
  return v;
}

// ---------------------------------------------------------------- group-level view of a version (staffing + bands), cached per revision

export interface Rec { day: string; slot: number; volume: number; aht: number; p10: number; p90: number; edited: boolean; required: number; base: number; sl: number; occ: number; warn: boolean }
export interface Daily { day: string; volume: number; aht: number; p10: number; p90: number; edited: boolean; peakRequired?: number; agentHours?: number; minSl?: number; warnIntervals?: number }

export async function versionRecords(tenantId: string, v: any, queueId: string | null = null): Promise<{ records: Rec[]; daily: Daily[] }> {
  const loaded = await withTenant(tenantId, async (tx) => ({
    group: await loadGroup(tx, v.wfmGroupId), rows: await versionRows(tx, v.id, { queueId }), drows: await versionRows(tx, v.id, { queueId, slots: false }),
  }));
  const { group, rows, drows } = loaded;
  // targets feed the staffing numbers, so they are part of the cache key
  const ck = key(tenantId, 'fv', v.id, v.rev, [group.serviceLevel, group.answerSec, group.shrinkage, group.occupancyCap, group.method, group.patienceSec, group.blended, group.queues.map((q) => `${q.id}${q.concurrency}${q.openSlot}${q.closeSlot}`).join('')].join('-'));
  const compute = async () => {
    const out: { records: Rec[]; daily: Daily[] } = { records: [], daily: [] };
    if (v.kind === 'SHORT') {
      const staff = aggregateStaff(await runStaffing(group, rows));
      const by = new Map<string, any>();
      for (const r of rows) {
        const k = `${r.day}|${r.slot}`;
        const c = by.get(k) ?? { day: r.day, slot: r.slot, volume: 0, work: 0, lo2: 0, hi2: 0, edited: false };
        c.volume += r.vol; c.work += r.vol * r.aht; c.edited = c.edited || r.edited;
        const k80 = r.volume > 0 ? r.vol / r.volume : 1;              // an adjustment scales the band with it
        c.lo2 += ((r.volume - r.p10) * k80) ** 2; c.hi2 += ((r.p90 - r.volume) * k80) ** 2;
        by.set(k, c);
      }
      for (const c of by.values()) {
        const s = staff.get(`${c.day}|${c.slot}`) ?? { required: 0, base: 0, occ: 0, sl: 1, warn: false };
        out.records.push({ day: c.day, slot: c.slot, volume: r2(c.volume), aht: c.volume ? r2(c.work / c.volume) : 0, p10: r2(Math.max(0, c.volume - Math.sqrt(c.lo2))), p90: r2(c.volume + Math.sqrt(c.hi2)),
          edited: c.edited, required: s.required, base: s.base, sl: r2(s.sl), occ: r2(s.occ), warn: s.warn });
      }
      const dd = new Map<string, { auto: number; p10: number; p90: number }>();
      for (const r of drows) { const c = dd.get(r.day) ?? { auto: 0, p10: 0, p90: 0 }; c.auto += r.volume; c.p10 += r.p10; c.p90 += r.p90; dd.set(r.day, c); }
      const sd = new Map<string, any>();
      for (const rec of out.records) {
        const c = sd.get(rec.day) ?? { volume: 0, work: 0, peak: 0, hours: 0, sl: 1, edited: false, warn: 0 };
        c.volume += rec.volume; c.work += rec.volume * rec.aht; c.peak = Math.max(c.peak, rec.required); c.hours += rec.required * SLOT_H;
        c.sl = Math.min(c.sl, rec.volume > 5 ? rec.sl : 1); c.edited = c.edited || rec.edited; c.warn += rec.warn ? 1 : 0;
        sd.set(rec.day, c);
      }
      for (const [day, c] of sd) {
        const d = dd.get(day) ?? { auto: c.volume, p10: c.volume, p90: c.volume };
        const k = d.auto > 0 ? c.volume / d.auto : 1;
        out.daily.push({ day, volume: r2(c.volume), aht: c.volume ? r2(c.work / c.volume) : 0, p10: r2(d.p10 * k), p90: r2(d.p90 * k), edited: c.edited, peakRequired: c.peak, agentHours: r2(c.hours), minSl: r2(c.sl), warnIntervals: c.warn });
      }
      out.daily.sort((a, b) => (a.day < b.day ? -1 : 1));
    } else {
      const dd = new Map<string, any>();
      for (const r of drows) {
        const c = dd.get(r.day) ?? { day: r.day, volume: 0, p10: 0, p90: 0, work: 0, edited: false };
        c.volume += r.vol; c.work += r.vol * r.aht; c.edited = c.edited || r.edited;
        const k = r.volume > 0 ? r.vol / r.volume : 1; c.p10 += r.p10 * k; c.p90 += r.p90 * k;
        dd.set(r.day, c);
      }
      out.daily = [...dd.values()].map((c) => ({ day: c.day, volume: r2(c.volume), aht: c.volume ? r2(c.work / c.volume) : 0, p10: r2(c.p10), p90: r2(c.p90), edited: c.edited }));
      out.daily.sort((a, b) => (a.day < b.day ? -1 : 1));
    }
    return out;
  };
  return queueId ? compute() : cached(ck, 3600, compute);
}

/**
 * Planning to a confidence level instead of the single central forecast. "Confidence" is how sure we want to be of having
 * enough people in an interval: 50 is the central forecast, 90 plans for the forecast's own upper (P90) volume, and levels
 * between are interpolated. The requirement is then worked out again by the same staffing model at that volume, so
 * service-level, shrinkage and occupancy targets all still apply. Returns required people per `day|slot`.
 */
export const confidenceShare = (level: number) => Math.min(1.25, Math.max(0, (level - 50) / 40));

export async function riskRequired(tenantId: string, v: any, level: number): Promise<Map<string, number>> {
  const f = confidenceShare(level);
  const out = new Map<string, number>();
  if (f <= 0 || v.kind !== 'SHORT') return out;
  const loaded = await withTenant(tenantId, async (tx) => ({ group: await loadGroup(tx, v.wfmGroupId), rows: await versionRows(tx, v.id, {}) }));
  const { group, rows } = loaded;
  const ck = key(tenantId, 'fvrisk', v.id, v.rev, [level, group.serviceLevel, group.answerSec, group.shrinkage, group.occupancyCap, group.method, group.patienceSec, group.blended, group.queues.map((q) => `${q.id}${q.concurrency}${q.openSlot}${q.closeSlot}`).join('')].join('-'));
  const entries = await cached(ck, 3600, async () => {
    const lifted = rows.map((r) => {
      const k80 = r.volume > 0 ? r.vol / r.volume : 1;                  // an adjustment scales the band with it
      return { ...r, vol: r.vol + f * Math.max(0, r.p90 - r.volume) * k80 };
    });
    const staff = aggregateStaff(await runStaffing(group, lifted));
    return [...staff].map(([k, s]) => [k, s.required] as [string, number]);
  });
  for (const [k, n] of entries) out.set(k, n);
  return out;
}

export const bucketRecords = (records: Rec[], grain: '15' | '30' | '60'): Rec[] => {
  if (grain === '15') return records.map((r) => ({ ...r }));
  const per = grain === '30' ? 2 : 4;                 // 15-minute slots per bucket
  const m = new Map<string, any>();
  for (const r of records) {
    const k = `${r.day}|${Math.floor(r.slot / per)}`;
    const c = m.get(k) ?? { day: r.day, slot: Math.floor(r.slot / per) * per, volume: 0, work: 0, lo2: 0, hi2: 0, edited: false, required: 0, base: 0, sl: 1, occ: 0, warn: false };
    c.volume += r.volume; c.work += r.volume * r.aht; c.lo2 += (r.volume - r.p10) ** 2; c.hi2 += (r.p90 - r.volume) ** 2; c.edited = c.edited || r.edited;
    c.required = Math.max(c.required, r.required); c.base = Math.max(c.base, r.base); c.sl = Math.min(c.sl, r.volume > 1 ? r.sl : 1); c.occ = Math.max(c.occ, r.occ); c.warn = c.warn || r.warn;
    m.set(k, c);
  }
  return [...m.values()].map((c) => ({ day: c.day, slot: c.slot, volume: r2(c.volume), aht: c.volume ? r2(c.work / c.volume) : 0, p10: r2(Math.max(0, c.volume - Math.sqrt(c.lo2))), p90: r2(c.volume + Math.sqrt(c.hi2)),
    edited: c.edited, required: c.required, base: c.base, sl: r2(c.sl), occ: r2(c.occ), warn: c.warn }));
};

export function rollup(daily: Daily[], grain: 'week' | 'month') {
  const keyOf = (d: string) => (grain === 'month' ? d.slice(0, 7) : (() => { const x = utc(d); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return fmtUtc(x); })());
  const m = new Map<string, any>();
  for (const d of daily) {
    const k = keyOf(d.day);
    const c = m.get(k) ?? { period: k, days: 0, volume: 0, p10: 0, p90: 0, work: 0, edited: false };
    c.days++; c.volume += d.volume; c.p10 += d.p10; c.p90 += d.p90; c.work += d.volume * d.aht; c.edited = c.edited || d.edited;
    m.set(k, c);
  }
  return [...m.values()].map((c) => ({ period: c.period, days: c.days, volume: r2(c.volume), p10: r2(c.p10), p90: r2(c.p90), aht: c.volume ? r2(c.work / c.volume) : 0, edited: c.edited }));
}

// ---------------------------------------------------------------- create a version

export const shortLabel = (kind: string) => (kind === 'SHORT' ? 'Short-term' : 'Long-term');

async function historyFor(tx: Tx, group: Group, cutoff: string) {
  const ids = group.queues.map((q) => q.id);
  const daily = await tx.q<any>(
    `SELECT queue_id, day::text AS day, sum(volume)::float8 AS volume, coalesce(sum(volume::float8 * aht_sec) / nullif(sum(volume), 0), 0) AS aht
     FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day < $2 GROUP BY queue_id, day ORDER BY day`, [ids, cutoff]);
  const slots = await tx.q<any>(
    `SELECT queue_id, day::text AS day, slot, volume::float8 AS volume, aht_sec::float8 AS aht FROM interval_history
     WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day < $2 AND day >= ($2::date - 57) ORDER BY day, slot`, [ids, cutoff]);
  return group.queues.map((q) => ({
    queue_id: q.idx, name: q.name, channel: q.channel,
    daily: daily.filter((r) => r.queueId === q.id).map((r) => ({ day: r.day, slot: -1, volume: r.volume, aht_sec: r.aht })),
    slots: slots.filter((r) => r.queueId === q.id).map((r) => ({ day: r.day, slot: r.slot, volume: r.volume, aht_sec: r.aht })),
  }));
}

async function eventsFor(tx: Tx, group: Group) {
  const rows = await tx.q<any>('SELECT * FROM special_events WHERE tenant_id = :t AND (wfm_group_id IS NULL OR wfm_group_id = $1)', [group.id]);
  return rows.map((e) => ({ name: e.name, kind: e.kind, start_day: e.startDay, end_day: e.endDay, uplift_pct: +e.upliftPct, lead_days: e.leadDays, lag_days: e.lagDays, queue_id: e.queueId ? (group.queues.find((q) => q.id === e.queueId)?.idx ?? -1) : 0 }))
    .filter((e) => e.queue_id !== -1);
}

/** What the models have learned about this group's recent misses: queue id -> a multiplier for each weekday (Monday = 0). Empty when learning is off. */
export type Factors = Map<string, number[]>;
export async function loadFactors(tx: Tx, groupId: string): Promise<Factors> {
  const m: Factors = new Map();
  const g = await tx.one<{ autoLearn: boolean }>('SELECT auto_learn FROM wfm_groups WHERE tenant_id = :t AND id = $1', [groupId]);
  if (!g?.autoLearn) return m;
  for (const r of await tx.q<any>('SELECT queue_id, dow, factor::float8 AS factor FROM forecast_feedback WHERE tenant_id = :t AND wfm_group_id = $1', [groupId])) {
    const f = m.get(r.queueId) ?? new Array(7).fill(1); f[r.dow] = r.factor; m.set(r.queueId, f);
  }
  return m;
}

const WEEKDAY = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

export interface CreateInput { groupId: string; kind: 'SHORT' | 'LONG'; weeks?: number; days?: number; model?: string; name?: string; fromDay?: string; parentVersionId?: string | null }

export async function createVersion(p: Principal, req: any, b: CreateInput) {
  // 1) read what the engine needs (short transaction)
  const prep = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, b.groupId);
    if (!group.queues.length) throw bad('This WFM group has no queues. Add queues under Configuration first.');
    const today = todayIn(group.timezone);
    const queues = await historyFor(tx, group, today);
    if (queues.every((q) => q.daily.length < 7)) throw bad('Not enough history: import at least 7 days of interval data first (Data Management).');
    return { group, today, queues, events: await eventsFor(tx, group), factors: await loadFactors(tx, group.id) };
  });
  const { group, today } = prep;
  const from = b.fromDay ?? today;
  const horizon = b.kind === 'SHORT' ? Math.min(Math.max(Math.round(num(b.weeks, 6)), 1), 18) * 7 : Math.min(Math.max(Math.round(num(b.days, 365)), 30), 730);
  const dates = dayRange(from, addDays(from, horizon - 1));
  const model = (MODELS as readonly string[]).includes(b.model ?? '') ? b.model! : group.model;
  const spd = b.kind === 'SHORT' ? 96 : 0;

  // 2) the engine (can take several seconds; no transaction is held open)
  const resp = await engine.forecastSeries({ queues: prep.queues, dates, slots_per_day: spd, events: prep.events, model, reconcile: true });
  // what the models learned from earlier misses: scale each queue's weekdays by the learned multiplier, and say so
  const applied: Record<string, number[]> = {};
  for (const s of resp.series) {
    const q = group.queues.find((x) => x.idx === s.queue_id), f = q && prep.factors.get(q.id);
    if (!q || !f) continue;
    const scale = (pt: any) => { const k = f[dowOf(pt.day)]; if (Math.abs(k - 1) > 0.005) { pt.volume *= k; pt.p10 *= k; pt.p90 *= k; } };
    s.daily.forEach(scale); s.slots.forEach(scale);
    const moved = f.map((k, d) => ({ k, d })).filter((x) => Math.abs(x.k - 1) > 0.005);
    if (moved.length) { applied[q.id] = f; s.notes.push(`Adjusted for what earlier forecasts got wrong: ${moved.map((x) => `${WEEKDAY[x.d]} ${x.k > 1 ? '+' : ''}${Math.round((x.k - 1) * 100)}%`).join(', ')}.`); }
  }
  const summary = {
    learning: { applied },
    createdFor: { historyTo: prep.queues[0].daily.at(-1)?.day, model },
    series: resp.series.map((s: any) => {
      const q = group.queues.find((x) => x.idx === s.queue_id);
      return { queueId: q?.id ?? null, name: q?.name ?? 'Group total', model: s.model, scores: s.scores, backtest: s.backtest, notes: s.notes, cleanedDays: s.cleaned_days, sigmaRel: s.sigma_rel };
    }),
  };

  // 3) store it
  return withTenant(p.tenantId, async (tx) => {
    await tx.exec('SELECT pg_advisory_xact_lock(hashtext($1))', [`fv:${group.id}:${b.kind}`]);
    const seq = (await tx.one<{ n: number }>('SELECT coalesce(max(seq), 0) + 1 AS n FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2', [group.id, b.kind]))!.n;
    const span = b.kind === 'SHORT' ? `${horizon / 7} wk` : `${horizon} days`;
    const name = b.name?.trim() || `${shortLabel(b.kind)} v${seq} · ${span} from ${label(dates[0])}`;
    const v = await tx.one<any>(
      `INSERT INTO forecast_versions (tenant_id, wfm_group_id, seq, name, kind, from_day, to_day, slots_per_day, model_req, summary, created_by, parent_version_id)
       VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [group.id, seq, name, b.kind, dates[0], dates.at(-1), spd, model, JSON.stringify(summary), p.name, b.parentVersionId ?? null]);
    const rows: any[][] = [];
    for (const s of resp.series) {
      if (s.queue_id === 0) continue;
      const qid = group.queues.find((x) => x.idx === s.queue_id)!.id;
      for (const pt of s.daily) rows.push([qid, pt.day, -1, pt.volume, pt.aht_sec, pt.p10, pt.p90]);
      for (const pt of s.slots) rows.push([qid, pt.day, pt.slot, pt.volume, pt.aht_sec, pt.p10, pt.p90]);
    }
    for (let i = 0; i < rows.length; i += 8000) {
      const c = rows.slice(i, i + 8000);
      await tx.exec(
        `INSERT INTO forecast_intervals (tenant_id, version_id, queue_id, day, slot, volume, aht_sec, p10, p90)
         SELECT :t, $1::uuid, * FROM unnest($2::uuid[], $3::date[], $4::smallint[], $5::real[], $6::real[], $7::real[], $8::real[])`,
        [v!.id, ...[0, 1, 2, 3, 4, 5, 6].map((k) => c.map((r) => r[k]))]);
    }
    await audit(tx, p, req, { action: 'CREATE', entityType: 'FORECAST_VERSION', entityId: v!.id, entityName: name, after: { model, days: dates.length, kind: b.kind } });
    return v;
  });
}

// ---------------------------------------------------------------- capacity (long-term)

/** Ratio of Erlang agent-hours to plain workload-hours, learned from the group's latest short-term forecast. */
export async function erlangFactor(tenantId: string, group: Group): Promise<number> {
  const fallback = 1 / group.occupancyCap;
  const v = await withTenant(tenantId, (tx) => tx.one<any>(
    `SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' ORDER BY (status = 'PUBLISHED') DESC, seq DESC LIMIT 1`, [group.id]));
  if (!v) return fallback;
  const { records } = await versionRecords(tenantId, v);
  const work = sum(records.map((r) => (r.volume * r.aht) / 3600));
  const hours = sum(records.map((r) => r.base * SLOT_H));
  return work > 0 && hours > 0 ? hours / work : fallback;
}

export function capacityFor(group: Group, daily: Daily[], factor: number, over: Overrides = {}) {
  const shrink = num(over.shrinkage, group.shrinkage);
  const vp = 1 + num(over.volumePct, 0) / 100, ap = 1 + num(over.ahtPct, 0) / 100;
  const cap = num(over.occupancyCap, group.occupancyCap);
  const f = factor * (group.occupancyCap / cap);          // a tighter occupancy cap needs proportionally more agents
  return daily.map((d) => {
    const workload = (d.volume * vp * d.aht * ap) / 3600;
    return { day: d.day, volume: d.volume * vp, workloadHours: workload, agentHours: (workload * f) / (1 - shrink) };
  });
}

// ---------------------------------------------------------------- what-if

export async function scenarioResult(v: any, group: Group, data: VRow[] | Daily[], name: string, over: Overrides, factor: number, toDay: string) {
  const vp = 1 + num(over.volumePct, 0) / 100, ap = 1 + num(over.ahtPct, 0) / 100;
  const weeks = Math.max(1, dayRange(v.fromDay, toDay).length / 7);
  if (v.kind === 'LONG') {
    const cap = capacityFor(group, data as Daily[], factor, over);
    const hours = sum(cap.map((d) => d.agentHours));
    return { name, params: over, volume: r2(sum(cap.map((d) => d.volume))), agentHours: r2(hours), fte: r2(hours / (group.fteHoursWeek * weeks)), peakRequired: null, serviceLevel: null, occupancy: null, warnIntervals: 0,
      daily: cap.map((d) => ({ day: d.day, volume: r2(d.volume), agentHours: r2(d.agentHours), fte: r2(d.agentHours / (group.fteHoursWeek / 7)) })) };
  }
  const scaled = (data as VRow[]).map((r) => ({ queueId: r.queueId, day: r.day, slot: r.slot, vol: r.vol * vp, aht: r.aht * ap }));
  const agg = aggregateStaff(await runStaffing(group, scaled, over));
  const volAt = new Map<string, number>();
  for (const r of scaled) volAt.set(`${r.day}|${r.slot}`, (volAt.get(`${r.day}|${r.slot}`) ?? 0) + r.vol);
  const byDay = new Map<string, { day: string; volume: number; agentHours: number; peak: number }>();
  let slW = 0, slN = 0, occW = 0, occN = 0, warn = 0;
  for (const [k, s] of agg) {
    const day = k.split('|')[0], vol = volAt.get(k) ?? 0;
    const d = byDay.get(day) ?? { day, volume: 0, agentHours: 0, peak: 0 };
    d.volume += vol; d.agentHours += s.required * SLOT_H; d.peak = Math.max(d.peak, s.required); byDay.set(day, d);
    slW += s.sl * vol; slN += vol; occW += s.occ * s.base; occN += s.base; warn += s.warn ? 1 : 0;
  }
  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  const hours = sum(days.map((d) => d.agentHours));
  return { name, params: over, volume: r2(sum(days.map((d) => d.volume))), agentHours: r2(hours), fte: r2(hours / (group.fteHoursWeek * weeks)), peakRequired: Math.max(0, ...days.map((d) => d.peak)),
    serviceLevel: slN ? r2(slW / slN) : null, occupancy: occN ? r2(occW / occN) : null, warnIntervals: warn,
    daily: days.map((d) => ({ day: d.day, volume: r2(d.volume), agentHours: r2(d.agentHours), peak: d.peak })) };
}

// ---------------------------------------------------------------- accuracy: hold-out backtest (forecast the last N days from earlier history)

export async function holdout(p: Principal, groupId: string, span: number) {
  const ctx = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, groupId);
    return { group, today: todayIn(group.timezone) };
  });
  const { group, today } = ctx;
  const ck = key(p.tenantId, 'holdout', groupId, span, today);
  return cached(ck, 1800, async () => {
    const cutoff = addDays(today, -span);
    const dates = dayRange(cutoff, addDays(today, -1));
    const prep = await withTenant(p.tenantId, async (tx) => ({ queues: await historyFor(tx, group, cutoff), events: await eventsFor(tx, group),
      act: await tx.q<any>(`SELECT queue_id, day::text AS day, slot, volume::float8 AS volume FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($1::uuid[]) AND day >= $2 AND day < $3`, [group.queues.map((q) => q.id), cutoff, today]) }));
    if (prep.queues.every((q) => q.daily.length < 28)) throw bad('Need at least 4 weeks of history before the hold-out window to run this test.');
    const resp = await engine.forecastSeries({ queues: prep.queues, dates, slots_per_day: 96, events: prep.events, model: group.model, reconcile: true });
    const actual = new Map<string, number>(prep.act.map((a: any) => [`${a.queueId}|${a.day}|${a.slot}`, a.volume]));

    const metric = (pairs: [number, number][]) => {
      const a = sum(pairs.map((x) => x[0])), e = sum(pairs.map((x) => Math.abs(x[0] - x[1]))), f = sum(pairs.map((x) => x[1]));
      return { wape: a ? r2(e / a) : 0, bias: a ? r2((f - a) / a) : 0, actual: Math.round(a), forecast: Math.round(f) };
    };
    const queuesOut: any[] = [];
    const grp = new Map<string, [number, number]>();
    for (const s of resp.series.filter((x: any) => x.queue_id !== 0)) {
      const q = group.queues.find((x) => x.idx === s.queue_id)!;
      const pairs = s.slots.map((pt: any) => ({ a: actual.get(`${q.id}|${pt.day}|${pt.slot}`) ?? 0, f: pt.volume, pt }));
      const hourly = new Map<string, [number, number]>(), dayly = new Map<string, [number, number]>();
      for (const { a, f, pt } of pairs) {
        const k = `${pt.day}|${pt.slot}`; const c = grp.get(k) ?? [0, 0]; c[0] += a; c[1] += f; grp.set(k, c);
        const hk = `${pt.day}|${Math.floor(pt.slot / 4)}`; const h = hourly.get(hk) ?? [0, 0]; h[0] += a; h[1] += f; hourly.set(hk, h);
        const d = dayly.get(pt.day) ?? [0, 0]; d[0] += a; d[1] += f; dayly.set(pt.day, d);
      }
      queuesOut.push({ queueId: q.id, name: q.name, model: s.model, interval: metric(pairs.map((x: any) => [x.a, x.f])), hourly: metric([...hourly.values()]), daily: metric([...dayly.values()]),
        withinBand: r2(pairs.filter((x: any) => x.a >= x.pt.p10 && x.a <= x.pt.p90).length / Math.max(1, pairs.length)) });
    }
    const hourly = new Map<string, [number, number]>(), dayly = new Map<string, [number, number]>(), byHour = Array.from({ length: 24 }, () => [0, 0, 0]);
    for (const [k, [a, f]] of grp) {
      const [day, slot] = k.split('|'); const hk = `${day}|${Math.floor(+slot / 4)}`;
      const h = hourly.get(hk) ?? [0, 0]; h[0] += a; h[1] += f; hourly.set(hk, h);
      const d = dayly.get(day) ?? [0, 0]; d[0] += a; d[1] += f; dayly.set(day, d);
      const bh = byHour[Math.floor(+slot / 4)]; bh[0] += a; bh[1] += Math.abs(a - f); bh[2] += f - a;
    }
    return {
      groupId, window: { from: cutoff, to: addDays(today, -1) }, generatedAt: new Date().toISOString(),
      total: { interval: metric([...grp.values()]), hourly: metric([...hourly.values()]), daily: metric([...dayly.values()]) }, queues: queuesOut,
      byDay: [...dayly].map(([day, [a, f]]) => ({ day, actual: r2(a), forecast: r2(f) })).sort((x, y) => (x.day < y.day ? -1 : 1)),
      byDayHour: [...hourly].map(([k, [a, f]]) => { const [day, hour] = k.split('|'); return { day, hour: +hour, actual: Math.round(a), forecast: Math.round(f * 10) / 10 }; }),
      byHour: byHour.map(([a, e, b], hour) => ({ hour, wape: a ? r2(e / a) : 0, bias: a ? r2(b / a) : 0, actual: Math.round(a) })),
      models: resp.series.map((s: any) => ({ queueId: group.queues.find((q) => q.idx === s.queue_id)?.id ?? null, model: s.model, scores: s.scores })),
    };
  });
}

/** Realised accuracy: published/archived short-term forecasts against the actuals that have arrived since. */
export async function realised(tx: Tx, groupId: string, today: string) {
  const rows = await tx.q<any>(
    `WITH v AS (SELECT id FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND status IN ('PUBLISHED','ARCHIVED')),
          f AS (SELECT DISTINCT ON (fi.queue_id, fi.day, fi.slot) fi.queue_id, fi.day, fi.slot, coalesce(fi.manual, fi.volume)::float8 AS f
                FROM forecast_intervals fi JOIN v ON v.id = fi.version_id WHERE fi.tenant_id = :t AND fi.slot >= 0 AND fi.day <= $2
                ORDER BY fi.queue_id, fi.day, fi.slot, fi.version_id DESC)
     SELECT f.day::text AS day, sum(h.volume)::float8 AS actual, sum(f.f)::float8 AS forecast, sum(abs(h.volume - f.f))::float8 AS abs_err, count(*)::int AS intervals
     FROM f JOIN interval_history h ON h.queue_id = f.queue_id AND h.day = f.day AND h.slot = f.slot GROUP BY f.day ORDER BY f.day`, [groupId, today]);
  return rows.map((r) => ({ day: r.day, actual: r2(r.actual), forecast: r2(r.forecast), wape15: r.actual ? r2(r.absErr / r.actual) : 0, bias: r.actual ? r2((r.forecast - r.actual) / r.actual) : 0, intervals: r.intervals }));
}

export const dropVersionCaches = (tenantId: string) => dropCache(tenantId, 'fv:*');
export { conflict };
