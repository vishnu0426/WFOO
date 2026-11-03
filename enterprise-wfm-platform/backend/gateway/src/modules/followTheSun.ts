/**
 * Follow the sun. Pick WFM groups at different sites, and see them on one clock: the combined need against the combined cover for every hour in UTC, where it falls
 * short, how the day is shared between sites, and whether sliding a site's roster earlier or later would help. Each group's need and cover come from its published
 * schedule and its forecast; this view assumes the people can help across the groups you pick, and says so.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { bad, isoDay, parse } from '../http.ts';
import { addDays, dayRange, loadGroup } from './forecast/service.ts';
import { liveStats, loadVersion } from './scheduleRoutes.ts';
import { analyse, localMidnightSlot, type GroupSeries } from './sunMath.ts';

export const followTheSun = Router();
const SPD = 96;
const uuid = z.string().uuid();

followTheSun.get('/', requires('schedule:read'), async (req, res) => {
  const p = me(req);
  const q = parse(z.object({ groupIds: z.string().min(36), from: z.string().regex(isoDay), days: z.coerce.number().int().min(1).max(14).default(7), maxShiftHours: z.coerce.number().int().min(0).max(8).default(4) }), req.query);
  const ids = q.groupIds.split(',').map((x) => parse(uuid, x.trim()));
  if (ids.length < 2) throw bad('Pick at least two WFM groups to put on one clock.');
  if (ids.length > 12) throw bad('Pick up to 12 groups.');
  const want = dayRange(q.from, addDays(q.from, q.days - 1), 40);
  const series: GroupSeries[] = [], notes: string[] = [], groups: any[] = [];
  for (const id of ids) {
    const g = await withTenant(p.tenantId, (tx) => loadGroup(tx, id));
    const v = await withTenant(p.tenantId, (tx) => tx.one<any>(`SELECT id FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'DEMAND' AND status = 'PUBLISHED' AND period_start <= $3::date AND period_end >= $2::date ORDER BY seq DESC LIMIT 1`, [id, want[0], want.at(-1)]));
    if (!v) { notes.push(`${g.name} has no published schedule over these dates, so it adds nothing here.`); groups.push({ id, name: g.name, timezone: g.timezone, versionId: null }); continue; }
    const ver = await withTenant(p.tenantId, (tx) => loadVersion(tx, v.id));
    const live = await liveStats(p.tenantId, ver);
    const idx = new Map((live.days as string[]).map((d, i) => [d, i]));
    const required = new Map<number, number>(), scheduled = new Map<number, number>();
    for (const day of want) {
      const i = idx.get(day); if (i === undefined) continue;
      const base = localMidnightSlot(day, g.timezone);
      for (let s = 0; s < SPD; s++) { const r = live.required[i * SPD + s]; if (r) required.set(base + s, r); }
    }
    for (const sh of live.shifts as any[]) {
      if (!want.includes(sh.day) && !want.includes(addDays(sh.day, 1))) continue;
      const base = localMidnightSlot(sh.day, g.timezone);
      for (let k = 0; k < sh.lengthSlots; k++) {
        if (sh.activities?.some((a: any) => k + sh.startSlot >= a.startSlot && k + sh.startSlot < a.startSlot + a.slots)) continue;       // on a meal or break
        const s = base + sh.startSlot + k;
        scheduled.set(s, (scheduled.get(s) ?? 0) + 1);
      }
    }
    series.push({ id, name: g.name, timezone: g.timezone, required, scheduled });
    groups.push({ id, name: g.name, timezone: g.timezone, versionId: v.id, versionName: ver.name, coveragePercent: live.stats.coverage.percent });
  }
  if (series.length < 2) throw bad(`Fewer than two of those groups have a published schedule over these dates. ${notes.join(' ')}`);
  const a = analyse(series, { maxShiftHours: q.maxShiftHours });
  res.json({
    from: want[0], to: want.at(-1), groups, ...a, notes: [
      ...notes,
      'Everything is on UTC. Need comes from each group\'s forecast, cover from its published schedule less meals and breaks.',
      'This assumes people can help across the groups you picked. If the groups serve different queues with different skills, read it as the combined staffing level, not as one pool.',
      'The suggestions slide a whole site\'s roster earlier or later as a what-if. They ignore each person\'s own hours, availability and labour rules, so use them to see where the gap is, then plan the real change in the schedule.',
    ],
  });
});
