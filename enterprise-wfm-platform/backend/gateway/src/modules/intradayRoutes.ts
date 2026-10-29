/**
 * Intraday & real-time adherence (RTA), modelled on how the market WFM products work (NICE, Verint/Calabrio, Genesys):
 *  - the phone/ACD system reports each agent's state (plus an optional reason code) as events;
 *  - a state map turns "state + reason" into a WFM activity (or "not working");
 *  - the agent's actual activity is compared with what the published schedule says they should be doing right now;
 *  - the result is In adherence, Out of adherence, Unscheduled, Ignored (activity left out of adherence) or Unknown (state not mapped).
 * A person is only flagged out of adherence once they have been out for longer than the grace period (Configuration › Scheduling Rules).
 * Live coverage lines the published forecast up against actual contacts so far, the reforecast for the rest of the day, and the schedule.
 */
import { Router } from 'express';
import { z } from 'zod';
import { withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { audit } from '../audit.ts';
import { bad, notFound, parse, isoDay } from '../http.ts';
import { engine, engineReady } from '../infra.ts';
import { loadGroup, todayIn, versionRecords } from './forecast/service.ts';
import { loadPolicy } from './policyRoutes.ts';
import { requirementFor } from './scheduleRoutes.ts';
import { suggestBreakMoves, type ShiftActs } from './breakOptimizer.ts';

export const intraday = Router();
const uuid = z.string().uuid();
const SPD = 96;

// ---------------------------------------------------------------- state map (ACD state + reason code -> activity)

const MapBody = z.object({ state: z.string().trim().min(1).max(80), reason: z.string().trim().max(80).optional(), activityId: uuid.nullable() });
const mapDto = (m: any) => ({ id: m.id, state: m.state, reason: m.reason, activityId: m.activityId, activityName: m.activityName ?? null });
const MAP_SQL = `SELECT m.*, a.name AS activity_name FROM rta_state_map m LEFT JOIN activities a ON a.id = m.activity_id WHERE m.tenant_id = :t`;

intraday.get('/state-map', requires('config:read'), async (req, res) => {
  res.json((await withTenant(me(req).tenantId, (tx) => tx.q<any>(`${MAP_SQL} ORDER BY lower(m.state), m.reason`))).map(mapDto));
});
intraday.post('/state-map', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(MapBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const m = await tx.one<any>('INSERT INTO rta_state_map (tenant_id, state, reason, activity_id) VALUES (:t, $1, $2, $3) RETURNING id', [b.state, b.reason ?? '', b.activityId]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'RTA_STATE_MAP', entityId: m!.id, entityName: `${b.state}${b.reason ? ` / ${b.reason}` : ''}`, after: b });
    return mapDto((await tx.q<any>(`${MAP_SQL} AND m.id = $1`, [m!.id]))[0]);
  });
  res.status(201).json(out);
});
intraday.put('/state-map/:id', requires('config:write'), async (req, res) => {
  const p = me(req), b = parse(MapBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const n = await tx.exec('UPDATE rta_state_map SET state = $2, reason = $3, activity_id = $4 WHERE tenant_id = :t AND id = $1', [req.params.id, b.state, b.reason ?? '', b.activityId]);
    if (!n) throw notFound('State mapping');
    await audit(tx, p, req, { action: 'UPDATE', entityType: 'RTA_STATE_MAP', entityId: String(req.params.id), entityName: `${b.state}${b.reason ? ` / ${b.reason}` : ''}`, after: b });
    return mapDto((await tx.q<any>(`${MAP_SQL} AND m.id = $1`, [req.params.id]))[0]);
  });
  res.json(out);
});
intraday.delete('/state-map/:id', requires('config:write'), async (req, res) => {
  const p = me(req);
  await withTenant(p.tenantId, async (tx) => {
    const m = await tx.one<any>('DELETE FROM rta_state_map WHERE tenant_id = :t AND id = $1 RETURNING *', [req.params.id]);
    if (!m) throw notFound('State mapping');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'RTA_STATE_MAP', entityId: m.id, entityName: `${m.state}${m.reason ? ` / ${m.reason}` : ''}` });
  });
  res.status(204).end();
});

// ---------------------------------------------------------------- state events from the phone / ACD system

const EventsBody = z.object({
  events: z.array(z.object({
    employeeNumber: z.string().trim().min(1), state: z.string().trim().min(1).max(80), reason: z.string().trim().max(80).optional(),
    at: z.string().datetime({ offset: true }).optional(),
  })).min(1).max(2000),
});

/** Shared with the Integration Station: a connector's live/webhook agent-state records go through this exact path too. */
export async function ingestAgentEvents(tenantId: string, events: z.infer<typeof EventsBody>['events']) {
  return withTenant(tenantId, async (tx) => {
    const emps = await tx.q<{ id: string; employeeNumber: string }>('SELECT id, employee_number FROM employees WHERE tenant_id = :t');
    const byNo = new Map(emps.map((e) => [e.employeeNumber.toLowerCase(), e.id]));
    const errors: { index: number; message: string }[] = [];
    const rows: { e: string; s: string; r: string; at: string }[] = [];
    const now = Date.now();
    events.forEach((ev, index) => {
      const id = byNo.get(ev.employeeNumber.toLowerCase());
      if (!id) return errors.push({ index, message: `Unknown employee number '${ev.employeeNumber}'` });
      const t = ev.at ? Date.parse(ev.at) : now;
      if (t > now + 5 * 60_000) return errors.push({ index, message: 'The time is in the future' });
      rows.push({ e: id, s: ev.state, r: ev.reason ?? '', at: new Date(t).toISOString() });
    });
    if (rows.length) await tx.exec(
      'INSERT INTO agent_state_events (tenant_id, employee_id, state, reason, at) SELECT :t, x.e, x.s, x.r, x.a::timestamptz FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS x(e, s, r, a)',
      [rows.map((r) => r.e), rows.map((r) => r.s), rows.map((r) => r.r), rows.map((r) => r.at)]);
    return { accepted: rows.length, errors };
  });
}

intraday.post('/events', requires('intraday:act'), async (req, res) => {
  const p = me(req), b = parse(EventsBody, req.body);
  const out = await ingestAgentEvents(p.tenantId, b.events);
  res.json(out);
});

// ---------------------------------------------------------------- adherence

type Status = 'IN' | 'OUT' | 'UNSCHEDULED' | 'IGNORED' | 'UNKNOWN' | 'NOT_STARTED' | 'SHIFT_ENDED';
interface Resolved { kind: 'ACTIVITY' | 'OFF' | 'UNMAPPED' | 'NONE'; category?: string; name: string; ignore?: boolean; countsAsWork?: boolean }

export const localClock = (tz: string, at = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return +p.find((x) => x.type === 'hour')!.value * 60 + +p.find((x) => x.type === 'minute')!.value;
};
/** Same as localClock, but to the second -- what decides the live adherence status and the grace countdown. */
const localClockSec = (tz: string, at = new Date()) => {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  return +p.find((x) => x.type === 'hour')!.value * 3600 + +p.find((x) => x.type === 'minute')!.value * 60 + +p.find((x) => x.type === 'second')!.value;
};
const hhmm = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** The calendar date (YYYY-MM-DD) an instant falls on in a zone. */
const localDate = (tz: string, at: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
/** The UTC instant at which a zone's wall clock shows `minute` on `day` (minutes since that day's local midnight). */
const zonedToInstant = (day: string, minute: number, tz: string) => {
  const guess = Date.parse(`${day}T00:00:00Z`) + minute * 60_000;
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess));
  const g = (t: string) => +p.find((x) => x.type === t)!.value;
  const offset = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - guess;
  return guess - offset;
};

async function loadMap(tx: Tx) {
  const rows = await tx.q<any>('SELECT m.state, m.reason, m.activity_id, a.name, a.category, a.ignore_adherence, a.counts_as_work FROM rta_state_map m LEFT JOIN activities a ON a.id = m.activity_id WHERE m.tenant_id = :t');
  const map = new Map<string, Resolved>();
  for (const r of rows) map.set(`${r.state.toLowerCase()}|${r.reason.toLowerCase()}`, r.activityId ? { kind: 'ACTIVITY', category: r.category, name: r.name, ignore: r.ignoreAdherence, countsAsWork: r.countsAsWork } : { kind: 'OFF', name: 'Not working' });
  return (state: string | null, reason: string): Resolved => {
    if (state === null) return { kind: 'NONE', name: 'No state received' };
    return map.get(`${state.toLowerCase()}|${reason.toLowerCase()}`) ?? map.get(`${state.toLowerCase()}|`) ?? { kind: 'UNMAPPED', name: state };
  };
}

interface Seg { from: number; to: number; type: string }   // minutes of the local day
function segments(shift: any): Seg[] {
  const start = shift.startSlot * 15, end = Math.min(1440, (shift.startSlot + shift.lengthSlots) * 15);
  const acts = ((shift.activities ?? []) as { type: string; startSlot: number; slots: number }[]).map((a) => ({ from: a.startSlot * 15, to: (a.startSlot + a.slots) * 15, type: a.type })).sort((a, b) => a.from - b.from);
  const out: Seg[] = []; let c = start;
  for (const a of acts) { if (a.from > c) out.push({ from: c, to: a.from, type: 'WORK' }); out.push(a); c = Math.max(c, a.to); }
  if (c < end) out.push({ from: c, to: end, type: 'WORK' });
  return out;
}

interface AgentRow {
  employeeId: string; employeeNumber: string; name: string; team: string | null; timezone: string;
  scheduled: string; scheduledUntil: string | null; actual: string; state: string | null; reason: string; stateSince: string | null;
  status: Status; outMinutes: number; outSeconds: number; dayPercent: number | null; shift: string | null;
  timeline: { schedule: { from: number; to: number; type: string }[]; actual: { from: number; to: number; status: Status; label: string }[] };
  exceptions: { id: string; from: number; to: number; category: string; note: string; excused: boolean; createdBy: string | null }[];
}

async function adherence(tenantId: string, groupId: string, day: string) {
  return withTenant(tenantId, async (tx) => {
    const group = await loadGroup(tx, groupId);
    const tz = group.timezone, pol = await loadPolicy(tx), graceSec = pol.adherenceGraceSeconds;
    const resolve = await loadMap(tx);
    const isToday = day === todayIn(tz);
    const nowMin = isToday ? localClock(tz) : 1440;
    const shifts = await tx.q<any>(
      `SELECT s.employee_id, s.start_slot, s.length_slots, s.activities FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id
       WHERE s.tenant_id = :t AND v.wfm_group_id = $1 AND v.status = 'PUBLISHED' AND s.day = $2`, [groupId, day]);
    // fetched across the whole day in every zone (UTC -1 day to +2 days), then placed on each agent's own local clock below
    const events = await tx.q<any>(
      `SELECT e.employee_id, e.state, e.reason, e.at
       FROM agent_state_events e JOIN employees m ON m.id = e.employee_id
       WHERE e.tenant_id = :t AND (m.primary_group_id = $1 OR $1 = ANY(m.eligible_group_ids)) AND e.at >= ($2::date - 1)::timestamptz AND e.at < ($2::date + 2)::timestamptz
       ORDER BY e.at, e.id`, [groupId, day]);
    const emps = await tx.q<any>(
      `SELECT m.id, m.employee_number, m.first_name, m.last_name, m.timezone, t.name AS team FROM employees m LEFT JOIN teams t ON t.id = m.team_id
       WHERE m.tenant_id = :t AND m.status = 'ACTIVE' AND (m.primary_group_id = $1 OR $1 = ANY(m.eligible_group_ids)) ORDER BY m.last_name, m.first_name`, [groupId]);
    const excRows = await tx.q<any>(
      `SELECT x.id, x.employee_id, x.from_minute, x.to_minute, x.category, x.note, x.excused, x.created_by FROM adherence_exceptions x JOIN employees m ON m.id = x.employee_id
       WHERE x.tenant_id = :t AND x.day = $2::date AND (m.primary_group_id = $1 OR $1 = ANY(m.eligible_group_ids))
       ORDER BY x.from_minute`, [groupId, day]);
    const excBy = new Map<string, any[]>();
    for (const x of excRows) excBy.set(x.employeeId, [...(excBy.get(x.employeeId) ?? []), { id: x.id, from: x.fromMinute, to: x.toMinute, category: x.category, note: x.note, excused: x.excused, createdBy: x.createdBy }]);
    const shiftBy = new Map<string, any>(shifts.map((s) => [s.employeeId, s]));
    const evBy = new Map<string, any[]>();
    for (const e of events) evBy.set(e.employeeId, [...(evBy.get(e.employeeId) ?? []), e]);

    const agents: AgentRow[] = [];
    const unmapped = new Map<string, number>();
    const published = new Array(96).fill(0), actualIn = new Array(96).fill(0);
    for (const m of emps) {
      // each agent is judged on their own clock: their shift slots, their "today", and their events' local minutes
      const etz = m.timezone || tz;
      const sh = shiftBy.get(m.id);
      const evs = (evBy.get(m.id) ?? []).filter((e) => localDate(etz, new Date(e.at)) === day)
        .map((e) => ({ state: e.state, reason: e.reason, sec: localClockSec(etz, new Date(e.at)), at: e.at }));
      if (!sh && !evs.length) continue;
      const aNow = todayIn(etz);
      const aPast = day < aNow, aFuture = day > aNow;
      const aNowSec = day === aNow ? localClockSec(etz) : 1440 * 60;
      const aNowMin = Math.floor(aNowSec / 60);
      const segs = sh ? segments(sh) : [];
      const excusedAt = (min: number) => (excBy.get(m.id) ?? []).some((x) => x.excused && min >= x.from && min < x.to);
      const shiftStart = segs.length ? segs[0].from : 1440, shiftEnd = segs.length ? segs[segs.length - 1].to : 0;
      const schedAt = (min: number) => segs.find((s) => min >= s.from && min < s.to)?.type ?? null;
      // judged second by second so the live status and the grace countdown are accurate to the second, not the
      // minute -- only minutes that have actually started are judged at all (nothing to adhere to before a shift
      // begins, and "no state yet" is not in adherence); the exported view (runs, staffing slots, day percentage)
      // stays minute-grained, recorded once per minute, same as before this was reworked
      const endSec = Math.min(aNowSec - 1, shiftEnd * 60 - 1, 1439 * 60 + 59);
      let ei = -1, outRun = 0, inSched = 0, inAdh = 0;
      let cur: { status: Status; outSeconds: number } = { status: 'NOT_STARTED', outSeconds: 0 };
      const statusAt = new Map<number, Status>();
      const runs: { from: number; to: number; status: Status; label: string }[] = [];
      for (let sec = shiftStart * 60; sec <= endSec; sec++) {
        const min = Math.floor(sec / 60);
        while (ei + 1 < evs.length && evs[ei + 1].sec <= sec) ei++;
        const ev = ei >= 0 ? evs[ei] : null;
        const act = resolve(ev ? ev.state : null, ev ? ev.reason : '');
        const sched = schedAt(min);
        let st: Status;
        if (act.kind === 'UNMAPPED' || act.kind === 'NONE') st = 'UNKNOWN';
        else if (act.kind === 'ACTIVITY' && act.ignore) st = 'IGNORED';
        else if (sched === null) st = act.kind === 'ACTIVITY' ? 'UNSCHEDULED' : 'OUT';
        // a work segment is met by any activity that counts as queue work; a break/meal/training segment needs that same activity category
        else st = act.kind === 'ACTIVITY' && (sched === 'WORK' ? act.countsAsWork : act.category === sched) ? 'IN' : 'OUT';
        // an excused explanation takes the time out of adherence altogether, the same as an activity marked "ignore"
        if ((st === 'OUT' || st === 'UNSCHEDULED') && excusedAt(min)) st = 'IGNORED';
        outRun = st === 'OUT' || st === 'UNSCHEDULED' ? outRun + 1 : 0;
        const flagged = (st === 'OUT' || st === 'UNSCHEDULED') && outRun > graceSec;
        const shown: Status = (st === 'OUT' || st === 'UNSCHEDULED') && !flagged ? 'IN' : st;
        if (sec % 60 === 59 || sec === endSec) {
          statusAt.set(min, shown);
          if (sched !== null && st !== 'IGNORED' && st !== 'UNKNOWN') { inSched++; if (!flagged) inAdh++; }
          const last = runs[runs.length - 1];
          if (last && last.status === shown && last.label === act.name && last.to === min) last.to = min + 1;
          else runs.push({ from: min, to: min + 1, status: shown, label: act.name });
        }
        if (sec === endSec) cur = { status: shown, outSeconds: flagged ? outRun : 0 };
      }
      if (!sh) cur = { status: 'UNSCHEDULED', outSeconds: 0 };
      else if (day === aNow && aNowMin >= shiftEnd) cur = { status: 'SHIFT_ENDED', outSeconds: 0 };
      // the staffing chart is on the group's clock: each of this agent's shift minutes is mapped onto the group's 15-minute slots
      const toGroupSlot = (x: number) => { const at = new Date(zonedToInstant(day, x, etz)); return localDate(tz, at) === day ? Math.floor(localClock(tz, at) / 15) : -1; };
      const onShift = new Set<number>(), inAdhSlots = new Set<number>();
      for (let x = shiftStart; x < shiftEnd; x++) {
        const s = toGroupSlot(x);
        if (s >= 0) onShift.add(s);
        if (statusAt.get(x) === 'IN' && s >= 0) inAdhSlots.add(s);
      }
      onShift.forEach((s) => published[s]++);
      inAdhSlots.forEach((s) => actualIn[s]++);
      // the person's latest state so far today, whether or not their shift has started: the loop above only walks the shift
      const evNow = [...evs].reverse().find((e) => e.sec <= aNowSec) ?? null, actNow = resolve(evNow ? evNow.state : null, evNow ? evNow.reason : '');
      if (actNow.kind === 'UNMAPPED' && evNow) unmapped.set(`${evNow.state}|${evNow.reason}`, (unmapped.get(`${evNow.state}|${evNow.reason}`) ?? 0) + 1);
      const schedNow = schedAt(Math.min(aNowMin, 1439));
      const seg = segs.find((s) => aNowMin >= s.from && aNowMin < s.to);
      const scheduled = !sh ? 'NONE' : aFuture ? 'NOT_STARTED' : aPast || aNowMin >= shiftEnd ? 'SHIFT_ENDED' : aNowMin < shiftStart ? 'NOT_STARTED' : (schedNow ?? 'NONE');
      agents.push({
        employeeId: m.id, employeeNumber: m.employeeNumber, name: `${m.firstName} ${m.lastName}`, team: m.team, timezone: etz,
        scheduled, scheduledUntil: seg ? hhmm(seg.to) : null,
        actual: actNow.name, state: evNow?.state ?? null, reason: evNow?.reason ?? '', stateSince: evNow ? hhmm(Math.floor(evNow.sec / 60)) : null,
        status: cur.status, outMinutes: Math.round(cur.outSeconds / 60), outSeconds: cur.outSeconds, dayPercent: inSched ? Math.round((inAdh / inSched) * 1000) / 10 : null,
        shift: sh ? `${hhmm(sh.startSlot * 15)}–${hhmm((sh.startSlot + sh.lengthSlots) * 15)}` : null,
        timeline: { schedule: segs.map((s) => ({ from: s.from, to: s.to, type: s.type })), actual: runs },
        exceptions: excBy.get(m.id) ?? [],
      });
    }
    const gPast = day < todayIn(tz), gFuture = day > todayIn(tz);
    const staffing = Array.from({ length: 96 }, (_, s) => {
      const known = !gFuture && s * 15 < (gPast ? 1440 : nowMin);
      return { slot: s, time: hhmm(s * 15), published: published[s], actual: known ? actualIn[s] : null };
    });
    const count = (s: Status) => agents.filter((a) => a.status === s).length;
    const scored = agents.filter((a) => a.dayPercent !== null);
    return {
      day, asOf: isToday ? hhmm(nowMin) : null, timezone: tz, graceSeconds: graceSec, publishedSchedule: shifts.length > 0, hasEvents: events.length > 0,
      summary: { total: agents.length, inAdherence: count('IN'), outOfAdherence: count('OUT'), unscheduled: count('UNSCHEDULED'), ignored: count('IGNORED'), unknown: count('UNKNOWN'),
        dayPercent: scored.length ? Math.round((scored.reduce((s, a) => s + a.dayPercent!, 0) / scored.length) * 10) / 10 : null },
      unmappedStates: [...unmapped].map(([k, agentCount]) => { const [state, reason] = k.split('|'); return { state, reason, agents: agentCount }; }),
      staffing,
      agents: agents.sort((a, b) => (a.status === 'OUT' ? 0 : 1) - (b.status === 'OUT' ? 0 : 1) || b.outMinutes - a.outMinutes || a.name.localeCompare(b.name)),
    };
  });
}

const Q = z.object({ groupId: uuid, day: z.string().regex(isoDay).optional() });
const CoverageQ = Q.extend({ versionId: uuid.optional() });   // a specific short-term forecast; default = the published one

intraday.get('/adherence', requires('intraday:read'), async (req, res) => {
  const p = me(req), q = parse(Q, req.query);
  const day = q.day ?? await withTenant(p.tenantId, async (tx) => todayIn((await loadGroup(tx, q.groupId)).timezone));
  res.json(await adherence(p.tenantId, q.groupId, day));
});

// ---------------------------------------------------------------- out-of-adherence explanations

const ExceptionBody = z.object({
  employeeId: uuid, day: z.string().regex(isoDay), fromMinute: z.number().int().min(0).max(1439), toMinute: z.number().int().min(1).max(1440),
  category: z.enum(['COACHING', 'TRAINING', 'SYSTEM_ISSUE', 'MEETING', 'OTHER']), note: z.string().trim().min(3).max(300), excused: z.boolean(),
});

intraday.post('/exceptions', requires('intraday:act'), async (req, res) => {
  const p = me(req), b = parse(ExceptionBody, req.body);
  if (b.toMinute <= b.fromMinute) throw bad('The end of the stretch must be after its start');
  const out = await withTenant(p.tenantId, async (tx) => {
    const emp = await tx.one<any>('SELECT id, first_name, last_name FROM employees WHERE tenant_id = :t AND id = $1', [b.employeeId]);
    if (!emp) throw notFound('Employee');
    const x = await tx.one<any>(
      `INSERT INTO adherence_exceptions (tenant_id, employee_id, day, from_minute, to_minute, category, note, excused, created_by)
       VALUES (:t, $1, $2::date, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [b.employeeId, b.day, b.fromMinute, b.toMinute, b.category, b.note, b.excused, p.name]);
    await audit(tx, p, req, { action: 'CREATE', entityType: 'ADHERENCE_EXCEPTION', entityId: x!.id, entityName: `${emp.firstName} ${emp.lastName} ${b.day}`, after: b });
    return { id: x!.id };
  });
  res.status(201).json(out);
});

intraday.delete('/exceptions/:id', requires('intraday:act'), async (req, res) => {
  const p = me(req), id = parse(uuid, req.params.id);
  await withTenant(p.tenantId, async (tx) => {
    const x = await tx.one<any>('DELETE FROM adherence_exceptions WHERE tenant_id = :t AND id = $1 RETURNING id, day::text AS day, category, note', [id]);
    if (!x) throw notFound('Explanation');
    await audit(tx, p, req, { action: 'DELETE', entityType: 'ADHERENCE_EXCEPTION', entityId: id, entityName: `${x.day} ${x.category}`, before: x });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- live reforecast (shared by coverage and the suggestion endpoints below)

export interface LiveReforecast { ratio: number; credibility: number; required: Map<number, number> }
/**
 * Today's live reforecast for one group: the rest of the day's per-slot required-agents, adjusted from what has
 * actually arrived so far against the published short-term forecast (the same engine call `/intraday/coverage`
 * itself uses for its `requiredReforecast` figures). Returns null when it is not today, there is no published
 * short-term forecast covering the day, or there is not yet enough live data to reforecast against -- callers
 * should fall back to the plain published requirement in every one of those cases, exactly as `/coverage` does.
 */
export async function liveReforecast(tenantId: string, groupId: string, day: string): Promise<LiveReforecast | null> {
  const group = await withTenant(tenantId, (tx) => loadGroup(tx, groupId));
  if (day !== todayIn(group.timezone)) return null;
  const nowSlot = Math.floor(localClock(group.timezone) / 15);
  if (nowSlot >= SPD || !(await engineReady())) return null;
  const { v, actuals } = await withTenant(tenantId, async (tx) => ({
    v: await tx.one<any>(`SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND status = 'PUBLISHED' ORDER BY seq DESC LIMIT 1`, [groupId]),
    actuals: await tx.q<any>(
      `SELECT h.slot, sum(h.volume)::int AS volume, sum(h.volume * h.aht_sec)::float8 / nullif(sum(h.volume), 0) AS aht
       FROM interval_history h JOIN queues qu ON qu.id = h.queue_id WHERE h.tenant_id = :t AND qu.wfm_group_id = $1 AND h.day = $2 AND h.slot < $3 GROUP BY h.slot`, [groupId, day, nowSlot]),
  }));
  if (!v || !actuals.length) return null;
  const { records } = await versionRecords(tenantId, v);
  const fc = new Map(records.filter((r) => r.day === day).map((r) => [r.slot, r]));
  if (!fc.size) return null;
  try {
    const r = await engine.intraday({
      forecast: [...fc.values()].map((f) => ({ day, slot: f.slot, volume: f.volume, aht_sec: f.aht })),
      actuals: actuals.map((a: any) => ({ day, slot: a.slot, volume: a.volume, aht_sec: a.aht ?? 0 })), current_slot: nowSlot,
    }, 8000);
    const required = new Map<number, number>();
    for (const a of r.adjusted) { const f = fc.get(a.slot); if (f && f.volume > 0) required.set(a.slot, f.required * (a.volume / f.volume)); }
    return { ratio: r.ratio, credibility: r.credibility, required };
  } catch { return null; }
}

// ---------------------------------------------------------------- live coverage

intraday.get('/coverage', requires('intraday:read'), async (req, res) => {
  const p = me(req), q = parse(CoverageQ, req.query);
  const { group, v, actuals, shifts, lastWeek } = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, q.groupId);
    const day = q.day ?? todayIn(group.timezone);
    const v = await tx.one<any>(
      `SELECT * FROM forecast_versions WHERE tenant_id = :t AND wfm_group_id = $1 AND kind = 'SHORT' AND ($2::uuid IS NULL OR id = $2) AND ($2::uuid IS NOT NULL OR status = 'PUBLISHED') ORDER BY seq DESC LIMIT 1`, [q.groupId, q.versionId ?? null]);
    // the same weekday a week earlier, for the "historical" bars
    const lastWeek = await tx.q<any>(
      `SELECT h.slot, sum(h.volume)::int AS volume FROM interval_history h JOIN queues qu ON qu.id = h.queue_id
       WHERE h.tenant_id = :t AND qu.wfm_group_id = $1 AND h.day = ($2::date - 7) GROUP BY h.slot`, [q.groupId, day]);
    const actuals = await tx.q<any>(
      `SELECT h.slot, sum(h.volume)::int AS volume, sum(h.abandoned)::int AS abandoned, sum(h.volume * h.aht_sec)::float8 / nullif(sum(h.volume), 0) AS aht
       FROM interval_history h JOIN queues qu ON qu.id = h.queue_id WHERE h.tenant_id = :t AND qu.wfm_group_id = $1 AND h.day = $2 GROUP BY h.slot ORDER BY h.slot`, [q.groupId, day]);
    const shifts = await tx.q<any>(
      `SELECT s.start_slot, s.length_slots FROM schedule_shifts s JOIN schedule_versions sv ON sv.id = s.version_id
       WHERE s.tenant_id = :t AND sv.wfm_group_id = $1 AND sv.status = 'PUBLISHED' AND s.day = $2`, [q.groupId, day]);
    return { group: { ...group, day }, v, actuals, shifts, lastWeek };
  });
  const day = group.day, isToday = day === todayIn(group.timezone);
  if (!v) return res.json({ day, ready: false, reason: q.versionId ? 'That short-term forecast was not found for this group.' : 'There is no published short-term forecast for this group yet. Publish one under Forecasting first.' });
  const { records } = await versionRecords(p.tenantId, v);
  const fc = new Map(records.filter((r) => r.day === day).map((r) => [r.slot, r]));
  if (!fc.size) return res.json({ day, ready: false, reason: `The forecast "${v.name}" does not cover ${day} (it runs ${v.fromDay} to ${v.toDay}).` });
  const act = new Map(actuals.map((a) => [a.slot, a]));
  const hist = new Map<number, number>(lastWeek.map((h: any) => [h.slot, h.volume]));
  const nowSlot = isToday ? Math.floor(localClock(group.timezone) / 15) : SPD;   // first slot that has not completed
  const sched = new Array(SPD).fill(0);
  for (const s of shifts) for (let g = s.startSlot; g < Math.min(SPD, s.startSlot + s.lengthSlots); g++) sched[g]++;

  // reforecast the rest of the day from what has actually arrived
  let ratio = 1, credibility = 0; const adj = new Map<number, number>();
  const done = actuals.filter((a) => a.slot < nowSlot);
  if (isToday && done.length && nowSlot < SPD && await engineReady()) {
    try {
      const r = await engine.intraday({
        forecast: [...fc.values()].map((f) => ({ day, slot: f.slot, volume: f.volume, aht_sec: f.aht })),
        actuals: done.map((a) => ({ day, slot: a.slot, volume: a.volume, aht_sec: a.aht ?? 0 })), current_slot: nowSlot,
      }, 8000);
      ratio = r.ratio; credibility = r.credibility;
      for (const a of r.adjusted) adj.set(a.slot, a.volume);
    } catch { /* the reforecast is an extra: coverage still shows without it */ }
  }
  const slots = Array.from({ length: SPD }, (_, s) => {
    const f = fc.get(s), a = act.get(s), re = adj.get(s);
    const need = f ? f.required : 0;
    const reNeed = f && re !== undefined && f.volume > 0 ? need * (re / f.volume) : null;
    return {
      slot: s, time: hhmm(s * 15), forecast: f ? Math.round(f.volume) : 0, forecastLow: f ? Math.round(f.p10) : 0, forecastHigh: f ? Math.round(f.p90) : 0,
      historical: hist.has(s) ? hist.get(s)! : null, aht: f ? Math.round(f.aht) : null, serviceLevel: f ? Math.round(f.sl * 1000) / 1000 : null, occupancy: f ? Math.round(f.occ * 1000) / 1000 : null, edited: f ? f.edited : false, actual: a && s < nowSlot ? a.volume : null, reforecast: re !== undefined ? Math.round(re) : null,
      abandoned: a && s < nowSlot ? a.abandoned : null, required: Math.round(need * 10) / 10, requiredReforecast: reNeed === null ? null : Math.round(reNeed * 10) / 10, scheduled: sched[s],
    };
  });
  const open = slots.filter((s) => s.forecast > 0 || s.scheduled > 0 || s.actual !== null);
  const upcoming = slots.filter((s) => s.slot >= nowSlot && (s.forecast > 0 || s.scheduled > 0));
  const needOf = (s: (typeof slots)[number]) => s.requiredReforecast ?? s.required;
  const fSoFar = slots.filter((s) => s.slot < nowSlot).reduce((t, s) => t + s.forecast, 0);
  const aSoFar = slots.filter((s) => s.actual !== null).reduce((t, s) => t + (s.actual ?? 0), 0);
  // day-level figures for the dashboard strip: realised miss, how many intervals are covered, average service level and occupancy
  const withActual = slots.filter((s) => s.actual !== null);
  const actualSum = withActual.reduce((t, s) => t + (s.actual ?? 0), 0);
  const wape = actualSum > 0 ? withActual.reduce((t, s) => t + Math.abs((s.actual ?? 0) - s.forecast), 0) / actualSum : null;
  const workSlots = slots.filter((s) => s.required > 0);
  const stats = {
    wape, coveragePercent: workSlots.length ? Math.round((workSlots.filter((s) => s.scheduled >= s.required).length / workSlots.length) * 100) : null,
    peakRequired: Math.max(0, ...slots.map((s) => s.required)),
    ahtAvg: (() => { const vol = slots.reduce((t, s) => t + s.forecast, 0); return vol ? Math.round(slots.reduce((t, s) => t + (s.aht ?? 0) * s.forecast, 0) / vol) : null; })(),
    serviceLevel: workSlots.length ? workSlots.reduce((t, s) => t + (s.serviceLevel ?? 0), 0) / workSlots.length : null,
    occupancy: workSlots.length ? workSlots.reduce((t, s) => t + (s.occupancy ?? 0), 0) / workSlots.length : null,
  };
  const gaps = upcoming.map((s) => ({ slot: s.slot, time: s.time, gap: Math.round((s.scheduled - needOf(s)) * 10) / 10 }));
  res.json({
    day, ready: true, timezone: group.timezone, nowSlot, nowTime: isToday ? hhmm(nowSlot * 15) : null, forecastName: v.name,
    reforecast: { applied: adj.size > 0, ratio: Math.round(ratio * 100) / 100, credibility: Math.round(credibility * 100) / 100 },
    totals: { forecastSoFar: Math.round(fSoFar), actualSoFar: aSoFar, forecastDay: Math.round(slots.reduce((t, s) => t + s.forecast, 0)), reforecastDay: adj.size ? Math.round(slots.reduce((t, s) => t + (s.slot < nowSlot ? (s.actual ?? 0) : (s.reforecast ?? s.forecast)), 0)) : null },
    hasActuals: actuals.length > 0, hasSchedule: shifts.length > 0, first: open[0]?.slot ?? 0, last: open.at(-1)?.slot ?? SPD - 1,
    gaps, slots, stats, versionId: v.id, versionStatus: v.status,
  });
});

// ---------------------------------------------------------------- dynamic break/meal re-optimization
// Moves only activities that have not started yet, never a shift's own start/end time or paid hours; every rule the
// initial placement respected (stay inside the shift, do not overlap a sibling activity) is re-checked here too.

async function loadTodayShifts(tx: Tx, groupId: string, day: string): Promise<ShiftActs[]> {
  return tx.q<any>(
    `SELECT s.id, s.employee_id, e.first_name || ' ' || e.last_name AS name, s.start_slot, s.length_slots, s.activities FROM schedule_shifts s
     JOIN schedule_versions v ON v.id = s.version_id JOIN employees e ON e.id = s.employee_id
     WHERE s.tenant_id = :t AND v.wfm_group_id = $1 AND v.status = 'PUBLISHED' AND s.day = $2`, [groupId, day]);
}

intraday.get('/break-suggestions', requires('intraday:read'), async (req, res) => {
  const p = me(req), q = parse(Q, req.query);
  const { group, shifts, required } = await withTenant(p.tenantId, async (tx) => {
    const group = await loadGroup(tx, q.groupId);
    const day = q.day ?? todayIn(group.timezone);
    const shifts = await loadTodayShifts(tx, q.groupId, day);
    const { required } = await requirementFor(p.tenantId, q.groupId, [day]).catch(() => ({ required: new Array(SPD).fill(0) }));
    return { group: { ...group, day }, shifts, required };
  });
  const day = group.day, isToday = day === todayIn(group.timezone);
  if (!isToday) return res.json({ day, ready: false, reason: 'Break re-optimization only applies to today, against the live gap for the rest of the day.', suggestions: [] });
  if (!shifts.length) return res.json({ day, ready: false, reason: 'No published schedule for today.', suggestions: [] });
  const nowSlot = Math.floor(localClock(group.timezone) / 15);
  // act on how the day is actually running, not the stale plain forecast, wherever the live reforecast has an opinion
  const live = await liveReforecast(p.tenantId, q.groupId, day);
  const liveRequired = live ? required.map((r, s) => live.required.get(s) ?? r) : required;
  const suggestions = suggestBreakMoves(shifts, liveRequired, nowSlot).slice(0, 30)
    .map((s) => ({ ...s, from: hhmm(s.fromSlot * 15), to: hhmm(s.toSlot * 15) }));
  res.json({ day, ready: true, nowTime: hhmm(nowSlot * 15), reforecastApplied: !!live, suggestions });
});

const ApplyBody = z.object({ groupId: uuid, day: z.string().regex(isoDay), moves: z.array(z.object({ shiftId: uuid, type: z.enum(['MEAL', 'BREAK']), fromSlot: z.number().int().min(0).max(95), toSlot: z.number().int().min(0).max(95) })).min(1).max(50) });

intraday.post('/break-suggestions/apply', requires('intraday:act'), async (req, res) => {
  const p = me(req), b = parse(ApplyBody, req.body);
  const out = await withTenant(p.tenantId, async (tx) => {
    const shifts = await loadTodayShifts(tx, b.groupId, b.day);
    const byId = new Map(shifts.map((s) => [s.id, s]));
    let applied = 0;
    const notes: string[] = [];
    for (const m of b.moves) {
      const s = byId.get(m.shiftId);
      if (!s) continue;
      const idx = s.activities.findIndex((a) => a.type === m.type && a.startSlot === m.fromSlot);
      if (idx < 0) continue; // already moved or stale
      const act = s.activities[idx];
      if (m.toSlot <= s.startSlot || m.toSlot + act.slots >= s.startSlot + s.lengthSlots) continue;
      if (s.activities.some((other, i) => i !== idx && m.toSlot < other.startSlot + other.slots && m.toSlot + act.slots > other.startSlot)) continue;
      const nextActs = s.activities.map((a, i) => (i === idx ? { ...a, startSlot: m.toSlot } : a)).sort((a, c) => a.startSlot - c.startSlot);
      await tx.exec('UPDATE schedule_shifts SET activities = $2::jsonb WHERE tenant_id = :t AND id = $1', [s.id, JSON.stringify(nextActs)]);
      notes.push(`${s.name}: ${m.type === 'MEAL' ? 'meal' : 'break'} moved from ${hhmm(m.fromSlot * 15)} to ${hhmm(m.toSlot * 15)}`);
      applied++;
    }
    if (notes.length) await audit(tx, p, req, { action: 'UPDATE', entityType: 'SCHEDULE_SHIFT', entityId: b.groupId, entityName: `Break re-optimization ${b.day}`, diffSummary: notes.join('; ').slice(0, 500) });
    return { applied };
  });
  res.json(out);
});
