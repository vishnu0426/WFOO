/**
 * Forecast self-learning. Models are refitted on every forecast run, so new history is always used; this adds the feedback loop
 * on top: after real volume arrives, the forecasts that were actually published are compared with what happened, and
 *   1. each queue gets a learned multiplier per weekday (median miss over recent weeks, pulled toward 1 while samples are few),
 *      which new forecasts apply and say so in their notes;
 *   2. if accuracy has drifted (average miss or bias beyond a limit) a draft reforecast is created for review. Nothing is
 *      published without the normal submit / approve / publish steps.
 * The miss is always measured on the forecast with its own earlier correction removed, so corrections never compound.
 */
import { currentScope, raw, withTenant, withWorkspace, type Tx } from '../../db.ts';
import { audit } from '../../audit.ts';
import { publish } from '../../infra.ts';
import type { Principal } from '../../auth.ts';
import { addDays, createVersion, dowOf, loadGroup, todayIn } from './service.ts';

export const LEARNING = { windowDays: 28, minDays: 5, wapeLimit: 0.15, biasLimit: 0.08, minSamples: 2, clamp: [0.8, 1.25] as const, throttleMs: 60_000 };

export interface QueueEval { queueId: string; name: string; days: number; wape: number | null; bias: number | null; factors: number[]; samples: number[] }
export interface Evaluation { from: string; to: string; days: number; wape: number | null; bias: number | null; drift: boolean; queues: QueueEval[] }

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/** Published forecasts against real volume over the last four weeks (today excluded: it is not finished). */
export async function evaluate(tenantId: string, groupId: string): Promise<Evaluation> {
  return withTenant(tenantId, async (tx) => {
    const group = await loadGroup(tx, groupId);
    const to = todayIn(group.timezone), from = addDays(to, -LEARNING.windowDays);
    const rows = await tx.q<any>(
      `SELECT f.queue_id, f.day::text AS day, f.forecast, f.applied, a.actual
       FROM (SELECT DISTINCT ON (fi.queue_id, fi.day) fi.queue_id, fi.day, fi.volume::float8 AS forecast, fv.summary #> ARRAY['learning', 'applied', fi.queue_id::text] AS applied
             FROM forecast_intervals fi JOIN forecast_versions fv ON fv.id = fi.version_id
             WHERE fi.tenant_id = :t AND fv.wfm_group_id = $1 AND fi.slot = -1 AND fi.day >= $2::date AND fi.day < $3::date
               AND fv.status IN ('PUBLISHED', 'ARCHIVED') AND fv.created_at < (fi.day + 1)::timestamptz
             ORDER BY fi.queue_id, fi.day, fv.created_at DESC) f
       JOIN (SELECT queue_id, day, sum(volume)::float8 AS actual FROM interval_history WHERE tenant_id = :t AND queue_id = ANY($4::uuid[]) AND day >= $2::date AND day < $3::date GROUP BY queue_id, day) a
         ON a.queue_id = f.queue_id AND a.day = f.day`, [groupId, from, to, group.queues.map((q) => q.id)]);

    let sumA = 0, sumF = 0, sumErr = 0;
    const queues: QueueEval[] = group.queues.map((q) => {
      const mine = rows.filter((r) => r.queueId === q.id && r.forecast > 0);
      const ratios: number[][] = Array.from({ length: 7 }, () => []);
      let a = 0, f = 0, err = 0;
      for (const r of mine) {
        const k = Array.isArray(r.applied) ? Number(r.applied[dowOf(r.day)]) || 1 : 1;
        ratios[dowOf(r.day)].push(r.actual / (r.forecast / k));      // the model's own miss, with its earlier correction taken out
        a += r.actual; f += r.forecast; err += Math.abs(r.actual - r.forecast);
      }
      sumA += a; sumF += f; sumErr += err;
      const factors = ratios.map((rs) => {
        if (rs.length < LEARNING.minSamples) return 1;
        const w = rs.length / (rs.length + 3);
        return r4(Math.min(LEARNING.clamp[1], Math.max(LEARNING.clamp[0], 1 + w * (median(rs) - 1))));
      });
      return { queueId: q.id, name: q.name, days: mine.length, wape: a > 0 ? r4(err / a) : null, bias: a > 0 ? r4((f - a) / a) : null, factors, samples: ratios.map((rs) => rs.length) };
    });
    const days = new Set(rows.map((r) => r.day)).size;
    const wape = sumA > 0 ? r4(sumErr / sumA) : null, bias = sumA > 0 ? r4((sumF - sumA) / sumA) : null;
    return { from, to, days, wape, bias, drift: days >= LEARNING.minDays && wape !== null && bias !== null && (wape > LEARNING.wapeLimit || Math.abs(bias) > LEARNING.biasLimit), queues };
  });
}

const systemPrincipal = (tenantId: string): Principal => ({ userId: null as unknown as string, tenantId, workspaceId: currentScope()?.workspaceId ?? '', role: 'WFM_ADMIN', name: 'Learning engine', username: 'learning', jti: '' });

/** A reforecast is a fresh model run, not an edit -- so it never copies volume/AHT. But a manual override at a given
 * (queue, day, slot) is an analyst's deliberate correction, not model output, and silently dropping it when the model
 * refreshes underneath it would lose real work without warning. Carry it forward wherever that exact slot still exists
 * in the new draft. Returns how many were carried, so the caller can say so. */
async function carryForwardManualOverrides(tx: Tx, fromVersionId: string, toVersionId: string): Promise<number> {
  return await tx.exec(
    `UPDATE forecast_intervals nf SET manual = old.manual
     FROM forecast_intervals old
     WHERE nf.tenant_id = :t AND nf.version_id = $1 AND old.tenant_id = :t AND old.version_id = $2
       AND nf.queue_id = old.queue_id AND nf.day = old.day AND nf.slot = old.slot AND old.manual IS NOT NULL`,
    [toVersionId, fromVersionId]);
}

export interface LearnResult { id: number; at: string; trigger: string; days: number; wape: number | null; bias: number | null; drift: boolean; action: string; versionId: string | null; note: string }

const queue = new Map<string, Promise<unknown>>();
/** One learning pass per group at a time, so an automatic run and a "Learn now" click cannot both prepare a draft. */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (queue.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queue.set(key, next);
  next.finally(() => { if (queue.get(key) === next) queue.delete(key); }).catch(() => undefined);
  return next;
}

/** Look at recent misses for one group, update its learned corrections and, on drift, prepare a draft reforecast for a human to review. */
export const learn = (tenantId: string, groupId: string, trigger: 'DATA' | 'MANUAL' | 'SCHEDULE', by?: Principal): Promise<LearnResult> => serial(`${tenantId}:${currentScope()?.workspaceId ?? 'default'}:${groupId}`, () => learnNow(tenantId, groupId, trigger, by));

async function learnNow(tenantId: string, groupId: string, trigger: 'DATA' | 'MANUAL' | 'SCHEDULE', by?: Principal): Promise<LearnResult> {
  const ev = await evaluate(tenantId, groupId);
  const setting = await withTenant(tenantId, (tx) => tx.one<{ autoLearn: boolean }>('SELECT auto_learn FROM wfm_groups WHERE tenant_id = :t AND id = $1', [groupId]));
  const on = !!setting?.autoLearn;
  let action = 'NONE', versionId: string | null = null, note = '';

  if (!on) note = 'Learning is switched off for this group, so nothing was changed.';
  else if (ev.days === 0) note = 'No day yet has both a published forecast and real volume to compare.';
  else {
    const changed = await withTenant(tenantId, async (tx) => {
      const old = new Map((await tx.q<any>('SELECT queue_id, dow, factor::float8 AS factor FROM forecast_feedback WHERE tenant_id = :t AND wfm_group_id = $1', [groupId])).map((r) => [`${r.queueId}:${r.dow}`, r.factor]));
      let n = 0;
      for (const q of ev.queues) for (let d = 0; d < 7; d++) {
        if (q.samples[d] < LEARNING.minSamples) continue;
        if (Math.abs((old.get(`${q.queueId}:${d}`) ?? 1) - q.factors[d]) > 0.005) n++;
        await tx.exec(
          `INSERT INTO forecast_feedback (tenant_id, wfm_group_id, queue_id, dow, factor, samples) VALUES (:t, $1, $2, $3, $4, $5)
           ON CONFLICT (queue_id, dow) DO UPDATE SET factor = EXCLUDED.factor, samples = EXCLUDED.samples, updated_at = now()`, [groupId, q.queueId, d, q.factors[d], q.samples[d]]);
      }
      return n;
    });
    if (changed) { action = 'CORRECTIONS_UPDATED'; note = `Updated ${changed} weekday correction${changed === 1 ? '' : 's'} from ${ev.days} day${ev.days === 1 ? '' : 's'} of real volume.`; }
    else note = `Compared ${ev.days} day${ev.days === 1 ? '' : 's'} of real volume with the published forecast: the corrections are already right.`;

    if (ev.drift) {
      const draft = await withTenant(tenantId, async (tx) => {
        const pub = await tx.one<any>(`SELECT id, kind, from_day::text AS from_day, to_day::text AS to_day, published_at FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' ORDER BY published_at DESC NULLS LAST LIMIT 1`, [groupId]);
        if (!pub) return null;
        const open = await tx.one<any>(`SELECT id FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = $2 AND status IN ('DRAFT', 'SUBMITTED', 'APPROVED') AND created_at > $3`, [groupId, pub.kind, pub.publishedAt]);
        return open ? { open: true as const } : { open: false as const, kind: pub.kind as 'SHORT' | 'LONG', span: (new Date(pub.toDay).getTime() - new Date(pub.fromDay).getTime()) / 864e5 + 1, publishedVersionId: pub.id as string };
      });
      const why = `Forecast has drifted: average miss ${(ev.wape! * 100).toFixed(1)}% and ${ev.bias! > 0 ? 'over' : 'under'}-forecasting by ${(Math.abs(ev.bias!) * 100).toFixed(1)}% over ${ev.days} days.`;
      if (draft && !draft.open) {
        try {
          const p = by ?? systemPrincipal(tenantId);
          const v = await createVersion(p, null, draft.kind === 'SHORT' ? { groupId, kind: 'SHORT', weeks: Math.max(1, Math.round(draft.span / 7)), model: 'auto' } : { groupId, kind: 'LONG', days: draft.span, model: 'auto' });
          const carried = await withTenant(tenantId, (tx) => carryForwardManualOverrides(tx, draft.publishedVersionId, v.id));
          versionId = v.id; action = 'DRAFT_CREATED';
          note = `${why} A fresh draft, "${v.name}", was prepared with the new corrections${carried ? `, carrying forward ${carried} manual override${carried === 1 ? '' : 's'} from the version it will replace` : ''}. Review it, then submit it for approval.`;
          await withTenant(tenantId, (tx) => audit(tx, systemPrincipal(tenantId), null, { action: 'CREATE', entityType: 'FORECAST_VERSION', entityId: v.id, entityName: v.name, reason: `Auto-relearn: ${why}${carried ? ` (${carried} manual override(s) carried forward)` : ''}` }));
        } catch (e) { note = `${why} A draft could not be prepared: ${(e as Error).message}`; }
      } else if (draft?.open) note = `${why} A newer draft is already waiting for review.`;
      else note = `${why} Publish a forecast first so there is something to replace.`;
    }
  }

  const run = await withTenant(tenantId, (tx) => tx.one<any>(
    `INSERT INTO learning_runs (tenant_id, wfm_group_id, trigger, days, wape, bias, drift, action, version_id, note) VALUES (:t, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, at`,
    [groupId, trigger, ev.days, ev.wape, ev.bias, ev.drift, action, versionId, note]));
  if (action !== 'NONE') publish(tenantId, ['forecast', 'relearned'], { groupId, action, versionId, note });
  return { id: Number(run.id), at: run.at, trigger, days: ev.days, wape: ev.wape, bias: ev.bias, drift: ev.drift, action, versionId, note };
}

const lastRun = new Map<string, number>();

/** New real volume arrived (an import or the live feed): let every group that has a published forecast learn from it. Never blocks or fails the caller. */
export function learnFromNewData(tenantId: string): void {
  setImmediate(async () => {
    try {
      const groups = await withTenant(tenantId, (tx) => tx.q<{ wfmGroupId: string }>(`SELECT DISTINCT wfm_group_id FROM forecast_versions WHERE tenant_id = :t AND status IN ('PUBLISHED', 'ARCHIVED')`));
      for (const g of groups) {
        const key = `${tenantId}:${g.wfmGroupId}`;
        if (Date.now() - (lastRun.get(key) ?? 0) < LEARNING.throttleMs) continue;
        lastRun.set(key, Date.now());
        await learn(tenantId, g.wfmGroupId, 'DATA').catch((e) => console.error('[learning]', (e as Error).message));
      }
    } catch (e) { console.error('[learning]', (e as Error).message); }
  });
}

/** Every group with a published forecast, across every tenant, evaluated once -- so a group that goes quiet (no
 * new imports for a while) is still checked for drift, not only right after data arrives. Exported directly (not
 * just via the ticker) so tests, and any future "run it now" admin action, can trigger the same real sweep. */
export async function runScheduledSweep(): Promise<void> {
  for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) {
    for (const w of await raw<{ id: string }>(`SELECT id FROM workspaces WHERE tenant_id = $1 AND status = 'ACTIVE'`, [t.id])) {
      try {
        await withWorkspace(t.id, w.id, async () => {
          const groups = await withTenant(t.id, (tx) => tx.q<{ wfmGroupId: string }>(`SELECT DISTINCT wfm_group_id FROM forecast_versions WHERE tenant_id = :t AND status IN ('PUBLISHED', 'ARCHIVED')`));
          for (const g of groups) await learn(t.id, g.wfmGroupId, 'SCHEDULE').catch((e) => console.error('[learning]', (e as Error).message));
        });
      } catch (e) { console.error('[learning]', (e as Error).message); }
    }
  }
}

let ticker: ReturnType<typeof setInterval> | null = null;
/** Once a day, evaluate every group's forecast against what really happened, even if no one imports new data or
 * opens the screen -- so a slow drift still gets caught and a draft still gets prepared for review. */
export function startLearningTicker(intervalMs = 24 * 60 * 60 * 1000) {
  if (ticker) return;
  ticker = setInterval(() => { runScheduledSweep().catch((e) => console.error('[learning]', (e as Error).message)); }, intervalMs);
  ticker.unref();
}
