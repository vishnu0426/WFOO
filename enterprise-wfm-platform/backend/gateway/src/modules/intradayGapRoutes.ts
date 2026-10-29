/**
 * Intraday gap fixer routes. Looks at how many people are on against how many are needed for the rest of today (using the live
 * reforecast where there is one) and proposes who could stay on, come in early, take an extra shift or, where there are far too many,
 * leave early. Suggestions only: a supervisor approves each one and the person has to agree. The same rules as scheduling apply
 * (weekly cap, rest between shifts, availability, time off), and they are checked again at the moment of approval.
 */
import { z } from 'zod';
import { withTenant } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, parse, isoDay } from '../http.ts';
import { addDays, loadGroup, todayIn } from './forecast/service.ts';
import { blockedReason, loadCtx, mondayOf, refreshStats, requirementFor, revision } from './scheduleRoutes.ts';
import { paidSlots } from './templateRules.ts';
import { fixProblem, suggestGapFixes, type FixKind, type GapPerson } from './gapFixer.ts';
import { intraday, liveReforecast, localClock } from './intradayRoutes.ts';

const uuid = z.string().uuid();
const SPD = 96;
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const Q = z.object({ groupId: uuid, day: z.string().regex(isoDay).optional() });

async function loadGapState(tenantId: string, groupId: string, day: string) {
  return withTenant(tenantId, async (tx) => {
    const ver = await tx.one<any>(
      `SELECT id, settings FROM schedule_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND status = 'PUBLISHED' AND period_start <= $2::date AND period_end >= $2::date ORDER BY seq DESC LIMIT 1`, [groupId, day]);
    if (!ver) return null;
    const weekStart = Number(ver.settings?.weekStart ?? 0), monday = mondayOf(day, weekStart);
    const from = monday < addDays(day, -1) ? monday : addDays(day, -1), to = addDays(day, 1);
    const ctx = { ...(await loadCtx(tx, groupId, from, to)), weekStart };
    const rows = await tx.q<any>(
      `SELECT s.id, s.employee_id, s.day::text AS day, s.start_slot, s.length_slots, s.template_id, s.activities FROM schedule_shifts s
       WHERE s.tenant_id = :t AND s.version_id = $1 AND s.day >= $2::date AND s.day <= $3::date`, [ver.id, from, to]);
    return { ver, ctx, rows, monday };
  });
}
type GapState = NonNullable<Awaited<ReturnType<typeof loadGapState>>>;

function peopleFrom(st: GapState, day: string): GapPerson[] {
  const { ctx, rows, monday } = st, tpl = new Map(ctx.templates.map((t: any) => [t.id, t]));
  const weekEnd = addDays(monday, 6), yesterday = addDays(day, -1), tomorrow = addDays(day, 1);
  const byEmp = new Map<string, any[]>();
  for (const r of rows) byEmp.set(r.employeeId, [...(byEmp.get(r.employeeId) ?? []), r]);
  return ctx.employees.filter((e: any) => e.status === 'ACTIVE').map((e: any) => {
    const mine = byEmp.get(e.id) ?? [];
    const today = mine.find((r) => r.day === day), prev = mine.find((r) => r.day === yesterday), next = mine.find((r) => r.day === tomorrow);
    const week = mine.filter((r) => r.day >= monday && r.day <= weekEnd).reduce((n, r) => n + paidSlots(tpl.get(r.templateId ?? ''), r.lengthSlots), 0);
    return {
      id: e.id, name: `${e.firstName} ${e.lastName}`, shift: today ? { start: today.startSlot, len: today.lengthSlots } : null,
      prevEnd: prev ? prev.startSlot + prev.lengthSlots - SPD : -Infinity, nextStart: next ? SPD + next.startSlot : null,
      weekPaidSlots: week, maxWeekSlots: Math.round(Number(e.maxWeeklyHours) * 4), contractWeekSlots: Math.round(Number(e.weeklyContractHours) * 4),
      restSlots: Math.round(Number(e.minRestHours) * 4), canWork: (s: number, l: number) => blockedReason(ctx, e, day, s, l),
    };
  });
}

const FIX_TEXT: Record<FixKind, string> = { EXTEND: 'Stay on', START_EARLY: 'Come in early', CALL_IN: 'Extra shift', RELEASE_EARLY: 'Finish early', RELEASE_LATE: 'Start later' };

intraday.get('/gap-fixes', requires('intraday:read'), async (req, res) => {
  const p = me(req), q = parse(Q, req.query);
  const group = await withTenant(p.tenantId, (tx) => loadGroup(tx, q.groupId));
  const day = q.day ?? todayIn(group.timezone);
  if (day !== todayIn(group.timezone)) return res.json({ day, ready: false, reason: 'Gap fixes only apply to today, against how the rest of the day is running.', fixes: [] });
  const st = await loadGapState(p.tenantId, q.groupId, day);
  if (!st) return res.json({ day, ready: false, reason: 'There is no published schedule covering today.', fixes: [] });
  const { required } = await requirementFor(p.tenantId, q.groupId, [day]).catch(() => ({ required: new Array(SPD).fill(0) }));
  const nowSlot = Math.floor(localClock(group.timezone) / 15);
  const live = await liveReforecast(p.tenantId, q.groupId, day);
  const need = required.map((r: number, s: number) => live?.required.get(s) ?? r);
  const sched = new Array(SPD).fill(0);
  for (const r of st.rows) if (r.day === day) for (let g = r.startSlot; g < Math.min(SPD, r.startSlot + r.lengthSlots); g++) sched[g]++;
  const out = suggestGapFixes(peopleFrom(st, day), sched, need, { nowSlot });
  const t = (s: number) => hhmm(s * 15);
  res.json({
    day, ready: true, nowTime: t(nowSlot), reforecastApplied: !!live, versionId: st.ver.id,
    before: { shortSlots: out.before.shortSlots, windows: out.before.windows.map((w) => ({ ...w, fromTime: t(w.from), toTime: t(w.to) })) },
    after: { shortSlots: out.after.shortSlots, windows: out.after.windows.map((w) => ({ ...w, fromTime: t(w.from), toTime: t(w.to) })) },
    fixes: out.fixes.map((f) => ({
      ...f, action: FIX_TEXT[f.kind], newStartTime: t(f.newStart), newEndTime: t(f.newStart + f.newLength), coverFromTime: t(f.coverFrom), coverToTime: t(f.coverTo),
      paidMinutes: f.extraPaidSlots * 15, pastContractMinutes: f.pastContractSlots * 15,
    })),
  });
});

const ApplyFixBody = z.object({
  groupId: uuid, day: z.string().regex(isoDay), reason: z.string().trim().min(3, 'is required: say why the schedule is being changed'),
  fixes: z.array(z.object({ employeeId: uuid, kind: z.enum(['EXTEND', 'START_EARLY', 'CALL_IN', 'RELEASE_EARLY', 'RELEASE_LATE']), newStart: z.number().int().min(0).max(95), newLength: z.number().int().min(1).max(96) })).min(1).max(30),
});

intraday.post('/gap-fixes/apply', requires('intraday:act'), async (req, res) => {
  const p = me(req), b = parse(ApplyFixBody, req.body);
  const group = await withTenant(p.tenantId, (tx) => loadGroup(tx, b.groupId));
  if (b.day !== todayIn(group.timezone)) throw bad('Gap fixes only apply to today.');
  const st = await loadGapState(p.tenantId, b.groupId, b.day);
  if (!st) throw bad('There is no published schedule covering today.');
  const nowSlot = Math.floor(localClock(group.timezone) / 15);
  const people = new Map(peopleFrom(st, b.day).map((x) => [x.id, x]));
  const applied: string[] = [], refused: { employeeId: string; name: string; why: string }[] = [];
  const touched = await withTenant(p.tenantId, async (tx) => {
    let n = 0;
    for (const f of b.fixes) {
      const person = people.get(f.employeeId);
      if (!person) { refused.push({ employeeId: f.employeeId, name: 'Unknown', why: 'They are not in this group.' }); continue; }
      const why = fixProblem(person, f.kind, f.newStart, f.newLength, { nowSlot });
      if (why) { refused.push({ employeeId: f.employeeId, name: person.name, why }); continue; }
      const row = st.rows.find((r: any) => r.employeeId === f.employeeId && r.day === b.day);
      if (row) {
        // meals and breaks have to stay inside the shift
        const acts: any[] = row.activities ?? [];
        if (acts.some((a) => a.startSlot < f.newStart || a.startSlot + a.slots > f.newStart + f.newLength)) { refused.push({ employeeId: f.employeeId, name: person.name, why: 'A meal or break falls outside the new shift times. Move it first.' }); continue; }
        await tx.exec(`UPDATE schedule_shifts SET start_slot = $2, length_slots = $3, source = 'MANUAL' WHERE tenant_id = :t AND id = $1`, [row.id, f.newStart, f.newLength]);
      } else {
        await tx.exec(`INSERT INTO schedule_shifts (tenant_id, version_id, employee_id, day, template_id, start_slot, length_slots, activities, source) VALUES (:t, $1, $2, $3, NULL, $4, $5, '[]'::jsonb, 'MANUAL')`,
          [st.ver.id, f.employeeId, b.day, f.newStart, f.newLength]);
      }
      applied.push(`${person.name}: ${FIX_TEXT[f.kind].toLowerCase()}, now ${hhmm(f.newStart * 15)}-${hhmm((f.newStart + f.newLength) * 15)}`);
      n++;
    }
    if (n) await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_VERSION', entityId: st.ver.id, entityName: `Intraday gap fixes ${b.day}`, reason: b.reason, diffSummary: applied.join('; ').slice(0, 500) });
    return n;
  });
  if (touched) {
    const live = await refreshStats(p.tenantId, st.ver.id);
    await withTenant(p.tenantId, (tx) => revision(tx, p, st.ver.id, 'EDIT', `Intraday: ${applied.join('; ').slice(0, 300)}`, b.reason, live.stats));
  }
  res.json({ applied: touched, notes: applied, refused, needsRepublish: touched > 0 });
});
