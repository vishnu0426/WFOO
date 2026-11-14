/**
 * A daily note to the people who look after each team: yesterday's attendance problems nobody has excused yet (missed punches, late arrivals, early leaves, punches still open).
 *
 * One note per person per group per day, not one per event: a message for every late arrival would be ignored within a week. Supervisors get their own team's people when the
 * organisation works supervisor-first and the team has one; otherwise (and for people with no team) the managers do. If nearly every scheduled day has no punch at all, the note says
 * that the time-clock file is probably missing instead of listing a problem for each person. Sent once the group's local time reaches ATTENDANCE_DIGEST_HOUR (default 7) for the day
 * before; ATTENDANCE_DIGEST=off turns it off. What has been sent is remembered, so a restart does not send it again.
 */
import { Router } from 'express';
import { z } from 'zod';
import { raw, withTenant, type Tx } from '../db.ts';
import { me, requires } from '../auth.ts';
import { isoDay, notFound, parse } from '../http.ts';
import { notify } from '../notify.ts';
import { approvalSettings, firstLineUsers } from './approvals.ts';
import { addDays, todayIn } from './forecast/service.ts';
import { summarize } from './attendance.ts';
import { feedLooksMissing, summarizeFor, tally, wordsFor, type ExcusableKind } from './attendanceMath.ts';

export const attendanceDigest = Router();
const NOBODY = '00000000-0000-0000-0000-000000000000';
const MANAGERS = `SELECT u.id FROM users u WHERE u.tenant_id = :t AND u.status = 'ACTIVE' AND u.role IN ('WFM_ADMIN', 'WFM_MANAGER', 'SCHEDULER')`;
const KINDS: ExcusableKind[] = ['missed', 'late', 'early', 'open'];

export async function runDigest(tx: Tx, groupId: string, day: string, force: boolean) {
  const done = await tx.one('SELECT 1 FROM attendance_digest_log WHERE tenant_id = :t AND wfm_group_id = $1 AND day = $2::date', [groupId, day]);
  if (done && !force) return { sent: false, reason: 'already sent', exceptions: 0, notified: 0 };
  const g = await tx.one<{ name: string }>('SELECT name FROM wfm_groups WHERE tenant_id = :t AND id = $1', [groupId]);
  if (!g) throw notFound('WFM group');
  const s = await summarize(tx, groupId, day, day);
  const counts = tally(s.days.map((d) => ({ issues: d.issues, punchCount: d.punches.length, scheduledHours: d.scheduledHours, due: d.due })));
  const managers = (await tx.q<{ id: string }>(MANAGERS)).map((r) => r.id);
  let notified = 0, exceptions = 0;
  const link = { screen: 'attendance', day, groupId };
  if (feedLooksMissing(counts)) {
    await notify(tx, managers, { kind: 'INFO', title: `Time-clock punches look missing for ${day}`, body: `${g.name}: ${counts.noPunch} of ${counts.dueScheduled} scheduled days have no punch. The time-clock file has probably not been imported.`, data: link });
    notified = managers.length; exceptions = counts.noPunch;
  } else {
    const people = s.days.map((d) => ({ id: d.employeeId, kinds: KINDS.filter((k) => d.issues.includes(k)) })).filter((p) => p.kinds.length);
    exceptions = people.reduce((n, p) => n + p.kinds.length, 0);
    if (people.length) {
      const team = new Map((await tx.q<{ id: string; teamId: string | null }>('SELECT id, team_id FROM employees WHERE tenant_id = :t AND id = ANY($1::uuid[])', [people.map((p) => p.id)])).map((r) => [r.id, r.teamId]));
      const supervisorFirst = (await approvalSettings(tx)).supervisorFirst;
      const cache = new Map<string | null, string[]>();
      const teams = [...new Set(people.map((p) => team.get(p.id) ?? null))];
      for (const t of teams) cache.set(t, supervisorFirst && t ? (await firstLineUsers(tx, t, NOBODY)).concat([]) : []);
      const audienceOf = (t: string | null) => { const first = cache.get(t) ?? []; return first.length ? first : managers; };
      const per = summarizeFor(people.map((p) => ({ teamId: team.get(p.id) ?? null, kinds: p.kinds })), audienceOf);
      for (const [user, c] of per) {
        const n = KINDS.reduce((a, k) => a + c[k], 0);
        await notify(tx, [user], { kind: 'INFO', title: `Attendance to review for ${day}: ${n}`, body: `${g.name}: ${wordsFor(c)}. Open Time & Attendance to excuse or follow up.`, data: link });
      }
      notified = per.size;
    }
  }
  await tx.exec(
    `INSERT INTO attendance_digest_log (tenant_id, wfm_group_id, day, exceptions, notified) VALUES (:t, $1, $2::date, $3, $4)
     ON CONFLICT (tenant_id, wfm_group_id, day) DO UPDATE SET sent_at = now(), exceptions = EXCLUDED.exceptions, notified = EXCLUDED.notified`, [groupId, day, exceptions, notified]);
  return { sent: true, reason: feedLooksMissing(counts) ? 'time-clock file missing' : exceptions ? 'exceptions' : 'nothing to review', exceptions, notified };
}

attendanceDigest.post('/digest', requires('workforce:write'), async (req, res) => {
  const p = me(req), b = parse(z.object({ groupId: z.string().uuid(), day: z.string().regex(isoDay).optional(), force: z.boolean().default(true) }), req.body);
  res.json(await withTenant(p.tenantId, async (tx) => {
    const g = await tx.one<{ timezone: string }>('SELECT timezone FROM wfm_groups WHERE tenant_id = :t AND id = $1', [b.groupId]);
    if (!g) throw notFound('WFM group');
    return runDigest(tx, b.groupId, b.day ?? addDays(todayIn(g.timezone ?? 'UTC'), -1), b.force);
  }));
});

const localHour = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

/** Once the group's local morning has come, send yesterday's digest for every group that has not had it. */
export async function sendDueDigests(): Promise<number> {
  const hour = Number(process.env.ATTENDANCE_DIGEST_HOUR ?? 7);
  let sent = 0;
  for (const t of await raw<{ id: string }>('SELECT id FROM tenants')) {
    const groups = await withTenant(t.id, (tx) => tx.q<{ id: string; timezone: string | null }>('SELECT id, timezone FROM wfm_groups WHERE tenant_id = :t'));
    for (const g of groups) {
      const tz = g.timezone ?? 'UTC';
      if (localHour(tz) < hour) continue;
      const yesterday = addDays(todayIn(tz), -1);
      try { if ((await withTenant(t.id, (tx) => runDigest(tx, g.id, yesterday, false))).sent) sent++; }
      catch (e) { console.error('[attendance-digest]', (e as Error).message); }
    }
  }
  return sent;
}

let timer: NodeJS.Timeout | null = null;
export function startAttendanceDigest() {
  if (timer || process.env.ATTENDANCE_DIGEST === 'off') return;
  const every = Math.max(60, Number(process.env.ATTENDANCE_DIGEST_TICK_SECONDS) || 900) * 1000;
  timer = setInterval(() => { sendDueDigests().catch((e) => console.error('[attendance-digest]', (e as Error).message)); }, every);
  timer.unref();
}
