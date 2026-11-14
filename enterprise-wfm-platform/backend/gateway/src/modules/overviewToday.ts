/**
 * GET /overview/today?groupId= : everything the Today page shows, worked out in one place from the same functions the detailed screens use, so the page and the screens never disagree.
 *
 * What it returns: a verdict (never "all clear" unless every signal was checked), an attention rail (each item with the action that fixes it, ordered for the person's role), KPI tiles
 * with a target and a trend, today's required-vs-scheduled-vs-actual chart, and the recent changes with sign-ins left out. The arithmetic is in overviewMath.ts and is tested there.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, permissionsFor, requiresAny } from '../auth.ts';
import { parse } from '../http.ts';
import { addDays, loadGroup, todayIn } from './forecast/service.ts';
import { accuracyTrendFor, headlineFor } from './forecast/routes.ts';
import { loadPolicy } from './policyRoutes.ts';
import { coverageFor, computeLite } from './intradayRoutes.ts';
import { cached } from './adherenceCache.ts';
import { VER_SQL, verDto } from './scheduleRoutes.ts';
import { buildAttention, orderFor, round1, toneFor, trendOf, verdictOf, type Area, type Signals } from './overviewMath.ts';

export const overview = Router();
const uuid = z.string().uuid();

export const ADHERENCE_TARGET = 88;      // percent of scheduled minutes spent doing what was scheduled (the figure the Adherence screen already colours green from)
export const ACCURACY_TARGET = 92;       // 100 less the 8% average daily miss that the accuracy trend calls good

const AREA_PERMISSION: Record<Area, string> = { schedule: 'schedule:read', forecast: 'forecast:read', live: 'intraday:read', rta: 'intraday:read', feed: 'data:read' };
const SIGN_INS = ['LOGIN', 'LOGIN_FAILED'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);

overview.get('/today', requiresAny('forecast:read', 'schedule:read', 'intraday:read', 'workforce:read', 'audit:read'), async (req, res) => {
  const p = me(req), q = parse(z.object({ groupId: uuid, includeSignIns: z.enum(['0', '1']).optional() }), req.query);
  const perms = p.scopes ? new Set(p.scopes) : await permissionsFor(p.tenantId, p.role);
  const can = (x: string) => perms.has(x);
  const hidden = (Object.keys(AREA_PERMISSION) as Area[]).filter((a) => !can(AREA_PERMISSION[a]));

  const base = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, q.groupId), today: string = todayIn(group.timezone ?? 'UTC');
    const policy = await loadPolicy(tx);
    const versions = can('schedule:read') ? (await tx.q<any>(`${VER_SQL} AND v.wfm_group_id = $1 ORDER BY v.seq DESC LIMIT 20`, [q.groupId])).map(verDto) : [];
    const forecasts = can('forecast:read') ? await tx.q<any>(
      `SELECT name, status, from_day::text AS from_day, to_day::text AS to_day, submitted_by FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND status IN ('PUBLISHED','SUBMITTED','APPROVED') ORDER BY seq DESC`, [q.groupId]) : [];
    const lastHistory = can('data:read') ? (await tx.one<{ day: string | null }>(
      `SELECT max(h.day)::text AS day FROM interval_history h JOIN queues qu ON qu.id = h.queue_id WHERE h.tenant_id = :t AND qu.wfm_group_id = $1`, [q.groupId]))?.day ?? null : null;
    const people = can('workforce:read') ? await tx.one<{ active: number; then: number; unknown: number }>(
      `SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
              count(*) FILTER (WHERE (hire_date IS NULL OR hire_date <= $2::date) AND (status = 'ACTIVE' OR termination_date > $2::date))::int AS then,
              count(*) FILTER (WHERE status = 'ACTIVE' AND hire_date IS NULL)::int AS unknown
       FROM employees WHERE tenant_id = :t AND (primary_group_id = $1 OR eligible_group_ids @> ARRAY[$1::uuid])`, [q.groupId, addDays(today, -28)]) : null;
    const recent = can('audit:read') ? await tx.q<any>(
      `SELECT id, at, actor_name, action, entity_type, entity_name, reason, diff_summary FROM audit_log WHERE tenant_id = :t AND ($1::boolean OR NOT (action = ANY($2::text[]))) ORDER BY id DESC LIMIT 8`,
      [q.includeSignIns === '1', SIGN_INS]) : [];
    return { group, today, policy, versions, forecasts, lastHistory, people, recent };
  });
  const { group, today, policy, versions, forecasts, lastHistory, people, recent } = base;
  const yesterday = addDays(today, -1);

  // ---- the facts, each from the function the detailed screen uses
  const live = can('intraday:read') ? await coverageFor(p.tenantId, { groupId: q.groupId }).catch(() => null) : null;
  const liveYesterday = can('intraday:read') ? await coverageFor(p.tenantId, { groupId: q.groupId, day: yesterday }).catch(() => null) : null;
  const adh = can('intraday:read') ? (await cached(`${p.tenantId}|${q.groupId}|${today}`, today, () => computeLite(p.tenantId, q.groupId, today)).catch(() => null))?.value ?? null : null;
  const adhYesterday = can('intraday:read') ? (await cached(`${p.tenantId}|${q.groupId}|${yesterday}`, yesterday, () => computeLite(p.tenantId, q.groupId, yesterday)).catch(() => null))?.value ?? null : null;
  const acc = can('forecast:read') ? await accuracyTrendFor(p.tenantId, q.groupId, 8).catch(() => null) : null;

  const published = versions.filter((v: any) => v.status === 'PUBLISHED' && v.kind !== 'ROTATION');
  const pubSched = published.find((v: any) => v.periodStart <= today && today <= (v.publishThrough ?? v.periodEnd)) ?? published[0] ?? null;
  const pubFc = forecasts.find((f: any) => f.status === 'PUBLISHED' && f.fromDay <= today && today <= f.toDay) ?? forecasts.find((f: any) => f.status === 'PUBLISHED') ?? null;
  const fcCoversToday = !!pubFc && pubFc.fromDay <= today && today <= pubFc.toDay;
  const nowSlot = adh?.asOf ? Math.floor((Number(adh.asOf.slice(0, 2)) * 60 + Number(adh.asOf.slice(3, 5))) / 15) : null;
  const gaps = live?.ready ? (live.gaps as { time: string; gap: number }[]).filter((g) => g.gap < -0.5) : [];
  const worst = gaps.length ? gaps.reduce((m, g) => (g.gap < m.gap ? g : m)) : null;
  const sigs: Signals = {
    today,
    schedule: {
      checked: can('schedule:read'),
      published: pubSched ? { id: pubSched.id, name: pubSched.name, periodStart: pubSched.periodStart, periodEnd: pubSched.publishThrough ?? pubSched.periodEnd, coveragePercent: pubSched.stats?.coverage?.percent ?? null, violations: pubSched.stats?.violations ?? 0, stale: pubSched.stale ?? [] } : null,
      coversToday: !!pubSched && pubSched.periodStart <= today && today <= (pubSched.publishThrough ?? pubSched.periodEnd),
      draftsWithViolations: versions.filter((v: any) => v.status === 'DRAFT' && (v.stats?.violations ?? 0) > 0).map((v: any) => ({ name: v.name, violations: v.stats.violations })),
    },
    forecast: {
      checked: can('forecast:read'),
      publishedShort: pubFc ? { name: pubFc.name, fromDay: pubFc.fromDay, toDay: pubFc.toDay } : null, coversToday: fcCoversToday, daysLeft: fcCoversToday ? daysBetween(today, pubFc!.toDay) : null,
      waiting: forecasts.filter((f: any) => f.status === 'SUBMITTED').map((f: any) => ({ name: f.name, by: f.submittedBy })), approvedNotPublished: forecasts.filter((f: any) => f.status === 'APPROVED').map((f: any) => ({ name: f.name })),
    },
    live: { checked: can('intraday:read') && !!live?.ready, understaffedIntervals: gaps.length, worst: worst ? { time: worst.time, gap: worst.gap } : null },
    rta: {
      checked: can('intraday:read') && !!adh, hasEvents: !!adh?.hasEvents,
      scheduledNow: !!adh && nowSlot !== null && (adh.staffing?.[nowSlot]?.published ?? 0) > 0, outOfAdherence: adh?.summary?.outOfAdherence ?? 0, unknownAgents: adh?.summary?.unknown ?? 0,
      unmappedStates: (adh?.unmappedStates ?? []).map((u: any) => ({ state: u.state, agents: u.agents })),
    },
    feed: { checked: can('data:read') && lastHistory !== null, lastHistoryDay: lastHistory, lagDays: lastHistory ? Math.max(0, daysBetween(lastHistory, today)) : null },
    targets: { coveragePercent: policy.scheduling.targetCoverage },
  };
  const items = orderFor(buildAttention(sigs, can), p.role);
  const verdict = verdictOf(sigs, items, hidden);

  // ---- KPI tiles: a value, its target, and the change from the period before
  const week = acc?.total?.weeks ?? [];
  const lastWeek = week.at(-1) ?? null, prevWeek = week.at(-2) ?? null;
  // the same number as everywhere else: published forecasts against actuals, per day, last 28 days
  const hl = can('forecast:read') ? await headlineFor(p.tenantId, q.groupId).catch(() => null) : null;
  const accVal = hl?.accuracyPct ?? null, accPrev = hl?.previousAccuracyPct ?? null;
  const covToday = live?.ready ? live.stats.coveragePercent : null, covPrev = liveYesterday?.ready ? liveYesterday.stats.coveragePercent : null;
  const adhToday = adh?.hasEvents ? adh.summary.dayPercent : null, adhPrev = adhYesterday?.hasEvents ? adhYesterday.summary.dayPercent : null;
  const target = policy.scheduling.targetCoverage;
  const peopleTrend = people ? trendOf(people.active, people.then, { higherIsBetter: true, flatBand: 0.5 }) : null;       // more or fewer people is not good or bad in itself
  const kpis = [
    { key: 'coverage', label: 'Coverage today', unit: '%', value: covToday, target, tone: toneFor(covToday, target, true, 10) ?? null, trend: trendOf(covToday, covPrev, { higherIsBetter: true }), trendBasis: 'since yesterday',
      sub: live?.ready ? `${live.stats.scheduledHours} h scheduled for ${live.stats.requiredHours} h needed${live.stats.shortHours ? `, ${live.stats.shortHours} h short` : ''}` : (live?.reason ?? 'Needs a published forecast that covers today'),
      scheduleCoverage: pubSched?.stats?.coverage?.percent ?? null, go: ['intraday', 'live-coverage'] },
    { key: 'adherence', label: 'Adherence today', unit: '%', value: adhToday, target: ADHERENCE_TARGET, tone: toneFor(adhToday, ADHERENCE_TARGET, true, 8) ?? null, trend: trendOf(adhToday, adhPrev, { higherIsBetter: true }), trendBasis: 'since yesterday',
      sub: adh ? (adh.hasEvents ? `${adh.summary.total} agents tracked${adh.summary.unknown ? `, ${adh.summary.unknown} in a state that cannot be read` : ''}` : 'No agent activity received yet') : 'Not available', go: ['intraday', 'adherence'] },
    { key: 'accuracy', label: 'Forecast accuracy', unit: '%', value: accVal, target: ACCURACY_TARGET, tone: toneFor(accVal, ACCURACY_TARGET, true, 7) ?? null, trend: trendOf(accVal, accPrev, { higherIsBetter: true }), trendBasis: 'vs the 28 days before',
      sub: hl && hl.accuracyPct !== null ? `Last ${hl.windowDays} days: published forecasts missed by ${hl.missPct}% a day on average${hl.state === 'SPARSE' ? `. ${hl.note}` : ''}` : (hl?.note ?? 'Needs a published forecast compared with actuals'), go: ['forecasting', 'accuracy-heatmap'] },
    { key: 'people', label: 'Active people', unit: 'people', value: people?.active ?? null, target: null, tone: null,
      trend: peopleTrend ? { ...peopleTrend, better: null } : null, trendBasis: 'vs 4 weeks ago',
      sub: pubSched ? `${pubSched.stats?.people ?? '?'} on the published schedule${people?.unknown ? ` · change is approximate: ${people.unknown} people have no hire date` : ''}` : 'In this WFM group', go: ['workforce', 'employees'] },
  ];

  // ---- the intraday chart: what is required, what is scheduled, who is really on
  const staffing = adh?.staffing as { slot: number; actual: number | null }[] | undefined;
  const chart = live?.ready ? (live.slots as any[]).filter((s) => s.slot >= live.first && s.slot <= live.last).map((s) => ({
    slot: s.slot, time: s.time, forecast: s.forecast, actualContacts: s.actual, required: s.requiredReforecast ?? s.required, scheduled: s.scheduled, onFloor: staffing?.[s.slot]?.actual ?? null,
  })) : [];

  res.json({
    groupId: q.groupId, day: today, timezone: group.timezone, nowTime: live?.nowTime ?? adh?.asOf ?? null, role: p.role,
    verdict, attention: items, hidden, kpis, chart, chartNote: live?.ready ? `${live.forecastName}${live.reforecast?.applied ? ` · rest of the day adjusted ×${live.reforecast.ratio} from what has arrived` : ''}` : (live?.reason ?? null),
    dayTotals: live?.ready ? { requiredHours: live.stats.requiredHours, scheduledHours: live.stats.scheduledHours, shortHours: live.stats.shortHours, surplusHours: live.stats.surplusHours, serviceLevel: live.stats.serviceLevel, peakRequired: live.stats.peakRequired } : null,
    drivers: { shortForecast: pubFc?.name ?? null, schedule: pubSched ? { name: pubSched.name, from: pubSched.periodStart, to: pubSched.publishThrough ?? pubSched.periodEnd } : null },
    recent: recent.map((r: any) => ({ id: String(r.id), at: r.at, actorName: r.actorName, action: r.action, entityType: r.entityType, entityName: r.entityName, reason: r.reason, diffSummary: r.diffSummary })),
    signInsHidden: q.includeSignIns !== '1',
  });
});
