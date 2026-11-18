/**
 * The headcount summary for a filter: people, contracted hours and the teams they are in. The database layer hands rows back with camelCase names (team_id arrives as teamId),
 * so this reads those names; it is separate so that shape is tested on its own.
 */
export interface SummaryRow { teamId: string | null; teamName: string | null; people: number; hours: string | number }

export function summariseEmployees(rows: SummaryRow[]) {
  return {
    people: rows.reduce((n, r) => n + r.people, 0),
    weeklyHours: rows.reduce((n, r) => n + Number(r.hours), 0),
    teams: rows.filter((r) => r.teamId).map((r) => ({ id: r.teamId as string, name: r.teamName ?? '', people: r.people, weeklyHours: Number(r.hours) })),
  };
}
