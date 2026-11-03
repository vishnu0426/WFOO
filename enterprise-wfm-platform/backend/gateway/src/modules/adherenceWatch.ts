/**
 * Tells team managers when people stay out of adherence, and keeps the event table from growing for ever.
 *
 * Once a minute, for every organisation that has had agent events in the last half hour, each group with a published schedule is looked at (using the same shared,
 * seconds-old judgement the screen uses, so watching costs nothing extra while supervisors are on the page). Anyone out of adherence for longer than the
 * organisation's limit (default 10 minutes) and not yet told about is reported once: one inbox message per team manager, listing who, and one `adherence.out`
 * event, which webhooks and the alert rules under Administration › Alerts & Reports can pick up. A person who stays out is not reported again until their state changes.
 */
import { pool, raw, withTenant } from '../db.ts';
import { publish } from '../infra.ts';
import { notify, usersOf } from '../notify.ts';
import { loadGroup, todayIn } from './forecast/service.ts';
import { cached } from './adherenceCache.ts';
import { computeLite } from './intradayRoutes.ts';

const DEFAULT_ALERT_MIN = 10;
const MAX_NEW_PER_GROUP = 500;

export async function watchGroup(tenantId: string, groupId: string, groupName: string, thresholdMin: number): Promise<number> {
  const day = await withTenant(tenantId, async (tx) => todayIn((await loadGroup(tx, groupId)).timezone));
  const { value } = await cached(`${tenantId}|${groupId}|${day}`, day, () => computeLite(tenantId, groupId, day));
  const out = value.agents.filter((a) => a.status === 'OUT' && a.outMinutes >= thresholdMin).slice(0, MAX_NEW_PER_GROUP);
  if (!out.length) return 0;
  return withTenant(tenantId, async (tx) => {
    // only people not already told about for this stretch: the primary key (person, day, the time their state began) does the remembering
    const fresh = await tx.q<{ employeeId: string }>(
      `INSERT INTO adherence_alerts (tenant_id, employee_id, day, since) SELECT :t, x.e, $1::date, x.s FROM unnest($2::uuid[], $3::text[]) AS x(e, s)
       ON CONFLICT DO NOTHING RETURNING employee_id`, [day, out.map((a) => a.employeeId), out.map((a) => a.stateSince ?? '')]);
    if (!fresh.length) return 0;
    const newIds = new Set(fresh.map((f) => f.employeeId));
    const people = out.filter((a) => newIds.has(a.employeeId));
    const managers = new Map((await tx.q<{ name: string; managerId: string }>('SELECT name, manager_id FROM teams WHERE tenant_id = :t AND manager_id IS NOT NULL')).map((t) => [t.name, t.managerId]));
    const byManager = new Map<string, typeof people>();
    for (const a of people) { const m = a.team ? managers.get(a.team) : undefined; if (m) byManager.set(m, [...(byManager.get(m) ?? []), a]); }
    for (const [managerEmployee, list] of byManager) {
      const users = await usersOf(tx, [managerEmployee]);
      const names = list.slice(0, 5).map((a) => `${a.name} (${a.outMinutes} min)`).join(', ');
      await notify(tx, users, {
        kind: 'INFO', title: `${list.length} ${list.length === 1 ? 'person has' : 'people have'} been out of adherence for over ${thresholdMin} minutes`,
        body: `${names}${list.length > 5 ? ` and ${list.length - 5} more` : ''}. Group: ${groupName}.`, data: { screen: 'intraday', groupId, day },
      });
    }
    publish(tenantId, ['adherence', 'out'], {
      groupId, group: groupName, people: people.length, afterMinutes: thresholdMin, day,
      who: people.slice(0, 10).map((a) => ({ name: a.name, team: a.team, outMinutes: a.outMinutes, state: a.state })),
    });
    return people.length;
  });
}

let busy = false;
export async function watchOnce(): Promise<number> {
  if (busy) return 0;
  busy = true;
  let told = 0;
  try {
    const tenants = await raw<{ id: string; alertAfterMin: number; enabled: boolean }>(
      'SELECT t.id, coalesce(s.alert_after_min, $1)::int AS alert_after_min, coalesce(s.enabled, true) AS enabled FROM tenants t LEFT JOIN adherence_settings s ON s.tenant_id = t.id', [DEFAULT_ALERT_MIN]);
    for (const t of tenants.filter((x) => x.enabled)) {
      // only groups whose people have sent a state in the last half hour: a group nobody is working in costs nothing to skip, and judging every group every minute would not be cheap
      const active = new Set((await raw<{ gid: string }>(
        `SELECT DISTINCT m.primary_group_id AS gid FROM agent_state_events e JOIN employees m ON m.id = e.employee_id
         WHERE e.tenant_id = $1 AND e.at > now() - interval '30 minutes' AND m.primary_group_id IS NOT NULL`, [t.id])).map((r) => r.gid));
      if (!active.size) continue;
      const groups = (await raw<{ id: string; name: string }>(
        `SELECT g.id, g.name FROM wfm_groups g WHERE g.tenant_id = $1 AND g.id = ANY($2::uuid[]) AND EXISTS (SELECT 1 FROM schedule_versions v WHERE v.wfm_group_id = g.id AND v.status = 'PUBLISHED'
           AND v.period_end >= current_date - 1 AND v.period_start <= current_date + 1)`, [t.id, [...active]]));
      for (const g of groups) {
        try { told += await watchGroup(t.id, g.id, g.name, t.alertAfterMin); }
        catch (e: any) { console.error(`[adherence-watch] ${g.name}:`, e.message); }
      }
    }
  } catch (e: any) { console.error('[adherence-watch]', e.message); } finally { busy = false; }
  return told;
}

/** Old agent events, alerts and kept history go. ADHERENCE_EVENT_RETENTION_DAYS (default 45, 0 = keep everything) is how long raw events are kept. */
export async function pruneOnce(): Promise<void> {
  const days = Number(process.env.ADHERENCE_EVENT_RETENTION_DAYS ?? 45);
  try {
    if (days > 0) {
      for (let i = 0; i < 20; i++) {          // in slices, so one pass never holds the table for long
        const r = await pool.query(`DELETE FROM wfm.agent_state_events WHERE id IN (SELECT id FROM wfm.agent_state_events WHERE at < now() - ($1 || ' days')::interval LIMIT 50000)`, [String(days)]);
        if ((r.rowCount ?? 0) < 50000) break;
      }
    }
    await pool.query(`DELETE FROM wfm.adherence_alerts WHERE created_at < now() - interval '30 days'`);
    await pool.query(`DELETE FROM wfm.adherence_daily WHERE day < current_date - 400`);
    await pool.query(`DELETE FROM wfm.adherence_days WHERE day < current_date - 400`);
  } catch (e: any) { console.error('[adherence-prune]', e.message); }
}

let timer: ReturnType<typeof setInterval> | null = null, pruneTimer: ReturnType<typeof setInterval> | null = null;
export function startAdherenceWatch() {
  const sec = Number(process.env.ADHERENCE_WATCH_SEC ?? 60);
  if (timer || sec <= 0) return;
  timer = setInterval(() => void watchOnce(), sec * 1000); timer.unref();
  pruneTimer = setInterval(() => void pruneOnce(), 60 * 60_000); pruneTimer.unref();
  setTimeout(() => void pruneOnce(), 5 * 60_000).unref();      // not in the first minutes of a start
}
export function stopAdherenceWatch() { if (timer) clearInterval(timer); if (pruneTimer) clearInterval(pruneTimer); timer = pruneTimer = null; }
