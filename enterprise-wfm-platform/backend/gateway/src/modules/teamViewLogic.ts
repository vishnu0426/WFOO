/**
 * Pure rules for the team view ("who is working today"): who may see what, and what each person's day looks like at this moment.
 * No database here, so each rule is tested on its own.
 */
export type TeamViewSetting = 'MANAGERS' | 'PEERS_NOW' | 'PEERS_ROSTER';
export type TeamAccess = 'FULL' | 'PEERS_NOW' | 'PEERS_ROSTER' | 'NONE';
export const TEAM_VIEW_SETTINGS: TeamViewSetting[] = ['MANAGERS', 'PEERS_NOW', 'PEERS_ROSTER'];
const SPD = 96;

/** A team lead sees everything about their people; anyone else sees only what the organisation allows, and only within their own team. */
export function accessFor(setting: TeamViewSetting, isLead: boolean, hasTeam: boolean): TeamAccess {
  if (isLead) return 'FULL';
  if (!hasTeam) return 'NONE';
  return setting === 'PEERS_NOW' ? 'PEERS_NOW' : setting === 'PEERS_ROSTER' ? 'PEERS_ROSTER' : 'NONE';
}

/** The days a person may look at: leads a fortnight back and two months ahead, colleagues only the present (a week ahead when they may see the roster). */
export function dateWindow(access: TeamAccess, today: string): { from: string; to: string } {
  const add = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (access === 'FULL') return { from: add(-14), to: add(60) };
  if (access === 'PEERS_ROSTER') return { from: today, to: add(7) };
  return { from: today, to: today };
}
export const clampDate = (access: TeamAccess, today: string, asked?: string): string => {
  const w = dateWindow(access, today), d = asked ?? today;
  return d < w.from ? w.from : d > w.to ? w.to : d;
};

export type DayStatus = 'ON_NOW' | 'LATER' | 'DONE' | 'WORKING' | 'LEAVE' | 'OFF' | 'UNPUBLISHED';
export interface PersonDay {
  shifts: { startSlot: number; lengthSlots: number }[];          // shifts that start on the day looked at
  spillSlots: number;                                             // slots of the previous day's overnight shift that run into this day (0 when none)
  leave: boolean;                                                 // approved time off covers the day
  published?: boolean;                                            // a published schedule covers the day for this person's groups (default yes). Without one, "no shift" does not mean "off"
}

/** Where a person's day stands. `nowSlot` is the current 15-minute slot on the viewer's clock, given only when the day looked at is today. */
export function statusOf(d: PersonDay, nowSlot: number | null): DayStatus {
  if (nowSlot !== null) {
    if (d.spillSlots > nowSlot) return 'ON_NOW';                                              // last night's shift is still running
    if (d.shifts.some((s) => nowSlot >= s.startSlot && nowSlot < Math.min(SPD, s.startSlot + s.lengthSlots))) return 'ON_NOW';
  }
  if (d.shifts.length) {
    if (nowSlot === null) return 'WORKING';
    if (d.shifts.some((s) => s.startSlot > nowSlot)) return 'LATER';
    return 'DONE';
  }
  if (d.spillSlots > 0 && nowSlot === null) return 'WORKING';
  if (d.leave) return 'LEAVE';
  return d.published === false ? 'UNPUBLISHED' : 'OFF';
}

/** Is this person's day covered by a published schedule of any group they work in? */
export const coveredByPublished = (personGroups: (string | null | undefined)[], publishedGroups: Set<string>): boolean => personGroups.some((g) => !!g && publishedGroups.has(g));

/** What a viewer may be told about a person's status: colleagues never learn that someone is on leave (it reads as "off"), and see nobody off in the "now" view. */
export function shownStatus(access: TeamAccess, s: DayStatus): DayStatus | null {
  if (access === 'FULL') return s;
  if (access === 'PEERS_NOW') return s === 'ON_NOW' ? s : null;
  return s === 'LEAVE' ? 'OFF' : s;      // a colleague may be told a day is not published: it says nothing about anyone's private life
}
