/**
 * People who are in more than one WFM group, seen from the group being built: who of them already works for another group in these dates, and which other
 * DRAFT schedules plan the same people for the same dates. A draft is not a promise (only a published schedule blocks a build), but whichever of two drafts
 * is published first takes the shared people, and the other is then blocked or short, so the planner is told while building, not at publishing.
 */
import type { Tx } from '../db.ts';

export interface SharedGroup { versionId: string; name: string; groupName: string; status: 'DRAFT' | 'PUBLISHED'; people: number; examples: { name: string; days: number }[] }
export interface SharedInfo { published: SharedGroup[]; drafts: SharedGroup[]; people: number }

export async function sharedPeople(tx: Tx, groupId: string, from: string, to: string, ids: string[]): Promise<SharedInfo> {
  if (!ids.length) return { published: [], drafts: [], people: 0 };
  const rows = await tx.q<{ versionId: string; name: string; status: 'DRAFT' | 'PUBLISHED'; groupName: string; employeeId: string; empName: string; days: number }>(
    `SELECT v.id AS version_id, v.name, v.status, g.name AS group_name, s.employee_id, e.first_name || ' ' || e.last_name AS emp_name, count(*)::int AS days
       FROM schedule_shifts s JOIN schedule_versions v ON v.id = s.version_id JOIN wfm_groups g ON g.id = v.wfm_group_id JOIN employees e ON e.id = s.employee_id
      WHERE s.tenant_id = :t AND v.wfm_group_id <> $1 AND v.status IN ('DRAFT', 'PUBLISHED') AND (v.status = 'DRAFT' OR v.publish_through IS NULL OR s.day <= v.publish_through)
        AND s.day >= $2::date AND s.day <= $3::date AND s.employee_id = ANY($4::uuid[])
      GROUP BY v.id, v.name, v.status, g.name, s.employee_id, e.first_name, e.last_name`, [groupId, from, to, ids]);
  const by = new Map<string, SharedGroup & { list: { name: string; days: number }[] }>();
  const everyone = new Set<string>();
  for (const r of rows) {
    everyone.add(r.employeeId);
    const g = by.get(r.versionId) ?? { versionId: r.versionId, name: r.name, groupName: r.groupName, status: r.status, people: 0, examples: [], list: [] };
    g.people++; g.list.push({ name: r.empName, days: r.days }); by.set(r.versionId, g);
  }
  const all = [...by.values()].map(({ list, ...g }) => ({ ...g, examples: list.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name)).slice(0, 3) }));
  all.sort((a, b) => b.people - a.people || a.groupName.localeCompare(b.groupName));
  return { published: all.filter((g) => g.status === 'PUBLISHED'), drafts: all.filter((g) => g.status === 'DRAFT'), people: everyone.size };
}

const who = (g: SharedGroup) => g.examples.map((e) => `${e.name} (${e.days} day${e.days === 1 ? '' : 's'})`).join(', ') + (g.people > g.examples.length ? ` and ${g.people - g.examples.length} more` : '');

/** One line for the build report about people who already work for other groups in these dates, or null. */
export function sharedText(s: SharedInfo): string | null {
  if (!s.published.length) return null;
  const n = new Set(s.published.flatMap((g) => g.examples.map((e) => e.name))).size;
  return `${s.published.length === 1 ? 'Another published schedule already uses' : `${s.published.length} other published schedules already use`} people from this group in these dates: ${s.published.map((g) => `${g.groupName} — ${who(g)}`).join('; ')}. Their time there is counted here (one shift a day across groups, the week's hours and days, days in a row and rest), so they may have fewer shifts than their contract${n ? '' : ''}.`;
}

/** The warning for one other draft that plans some of the same people for the same dates. */
export function draftText(d: SharedGroup): { name: string; groupName: string; message: string } {
  return {
    name: d.name, groupName: d.groupName,
    message: `The draft "${d.name}" (${d.groupName}) plans ${d.people} of the same ${d.people === 1 ? 'person' : 'people'} for these dates: ${who(d)}. Drafts do not block each other: whichever is published first takes them, and the other is then refused at publishing or left short. Publish one before building the other, or choose different people.`,
  };
}

/** The report line about guests: people whose home group is another one, and what that group's schedules took from them. Null when nobody is a guest. */
export function guestText(g: { guests: number; heldDays: number; homeNames: string[]; draftShifts: number }): { level: 'WARNING' | 'INFO'; message: string } {
  const homes = g.homeNames.slice(0, 3).join(', ') + (g.homeNames.length > 3 ? ` and ${g.homeNames.length - 3} more` : '');
  const who = `${g.guests} ${g.guests === 1 ? 'person is a guest' : 'people are guests'} here (their home group is ${homes})`;
  if (g.heldDays) return { level: 'WARNING', message: `${who}. They get only the time their home group leaves free, and ${g.heldDays} of their days were held back because the home group has no schedule for them yet. Build the home group first, or choose "Use shared people even if their home group is not scheduled" when generating.` };
  return { level: 'INFO', message: `${who}. They get only the time their home group leaves free${g.draftShifts ? ` (its draft schedule's ${g.draftShifts} shift${g.draftShifts === 1 ? '' : 's'} for them ${g.draftShifts === 1 ? 'is' : 'are'} respected as if published)` : ''}.` };
}
