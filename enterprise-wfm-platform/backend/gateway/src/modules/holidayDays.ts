import type { Tx } from '../db.ts';

/**
 * The days of a range that are public holidays for a group: the organisation's holidays, those of the group's site, and the group's own (all special events of the kind
 * "holiday"). One place, so the schedule builder, the fairness carry-over and rotations all agree on what a holiday is.
 */
export async function holidayDays(tx: Tx, groupId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await tx.q<{ startDay: string; endDay: string }>(
    `SELECT start_day::text AS start_day, end_day::text AS end_day FROM special_events
      WHERE tenant_id = :t AND kind = 'holiday' AND ((wfm_group_id IS NULL AND site_id IS NULL) OR wfm_group_id = $1 OR site_id = (SELECT site_id FROM wfm_groups WHERE id = $1)) AND start_day <= $3::date AND end_day >= $2::date`,
    [groupId, from, to]);
  const out = new Set<string>();
  for (const r of rows) {
    const end = r.endDay > to ? to : r.endDay;
    for (let d = r.startDay < from ? from : r.startDay; d <= end; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) out.add(d);
  }
  return out;
}
