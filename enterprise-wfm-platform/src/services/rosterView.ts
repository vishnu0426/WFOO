/**
 * Rules behind the Roster view of a schedule, with no React and no browser so they are tested on their own: one row per person and one column per day, with the shift as text, the paid hours,
 * how many rule violations the person has, and the ways the rows can be ordered and grouped.
 */
import { naturalCompare } from './scheduleIssues';

export type RosterSort = 'name' | 'hours' | 'violations';
export type RosterShow = 'times' | 'hours';
export interface RosterShift { employeeId: string; employeeName: string; employeeNumber?: string; teamName?: string | null; day: string; startTime: string; endTime: string; startSlot: number; lengthSlots: number; activities: { type: string; slots: number }[] }
export interface RosterCell { times: string; hours: number; bad: boolean; startSlot: number }
export interface RosterRow { id: string; name: string; number: string; team: string; cells: Record<string, RosterCell>; hours: number; violations: number; shifts: number }

/** Paid hours of one shift: its length less the unpaid meal. */
export const paidHours = (s: Pick<RosterShift, 'lengthSlots' | 'activities'>): number => (s.lengthSlots - s.activities.filter((a) => a.type === 'MEAL').reduce((n, a) => n + a.slots, 0)) / 4;

/** One row per person from the shifts in the period; `bad` holds "employeeId|day" for each day that breaks a rule. */
export function buildRoster(shifts: RosterShift[], bad: Set<string>): RosterRow[] {
  const by = new Map<string, RosterRow>();
  for (const s of shifts) {
    const r = by.get(s.employeeId) ?? { id: s.employeeId, name: s.employeeName, number: s.employeeNumber ?? '', team: s.teamName ?? 'No team', cells: {}, hours: 0, violations: 0, shifts: 0 };
    const hours = paidHours(s), isBad = bad.has(`${s.employeeId}|${s.day}`);
    r.cells[s.day] = { times: `${s.startTime}–${s.endTime}`, hours, bad: isBad, startSlot: s.startSlot };
    r.hours += hours; r.shifts++; if (isBad) r.violations++;
    by.set(s.employeeId, r);
  }
  return [...by.values()].map((r) => ({ ...r, hours: Math.round(r.hours * 10) / 10 }));
}

/** Names in natural order by default; by paid hours (most first); or people with violations first. Optionally grouped by team, teams in natural order. */
export function sortRoster(rows: RosterRow[], sort: RosterSort, groupByTeam: boolean): RosterRow[] {
  const within = (a: RosterRow, b: RosterRow) => (sort === 'hours' ? b.hours - a.hours : sort === 'violations' ? b.violations - a.violations : 0) || naturalCompare(a.name, b.name);
  return [...rows].sort((a, b) => (groupByTeam ? naturalCompare(a.team, b.team) : 0) || within(a, b));
}

export type RosterItem = { kind: 'group'; team: string; count: number } | { kind: 'row'; row: RosterRow };
/** The list as drawn: a heading before each team's people when grouped (a folded team shows only its heading). */
export function rosterItems(rows: RosterRow[], groupByTeam: boolean, folded: Set<string> = new Set()): RosterItem[] {
  if (!groupByTeam) return rows.map((row) => ({ kind: 'row', row }));
  const out: RosterItem[] = [];
  for (let i = 0; i < rows.length;) {
    const team = rows[i].team; let j = i; while (j < rows.length && rows[j].team === team) j++;
    out.push({ kind: 'group', team, count: j - i });
    if (!folded.has(team)) for (let k = i; k < j; k++) out.push({ kind: 'row', row: rows[k] });
    i = j;
  }
  return out;
}

/** What a cell says: the shift's times, or its paid hours; a dot for a day off. */
export const cellText = (c: RosterCell | undefined, show: RosterShow): string => (!c ? '·' : show === 'hours' ? `${Math.round(c.hours * 10) / 10} h` : c.times);
/** The people matching a name or number search. */
export const matchRoster = (rows: RosterRow[], query: string): RosterRow[] => {
  const t = query.trim().toLowerCase();
  return t ? rows.filter((r) => r.name.toLowerCase().includes(t) || r.number.toLowerCase().includes(t)) : rows;
};
