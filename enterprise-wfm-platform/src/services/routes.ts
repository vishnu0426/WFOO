/**
 * Address bar <-> screen. Every screen has its own URL, /<module>/<section> (for example /workforce/employees,
 * /workforce/teams, /scheduling/generate-schedule), so a screen can be bookmarked, shared and reloaded, and the
 * browser's back and forward buttons work. Plain History API: no router library.
 */

export const MODULES = ['overview', 'workforce', 'forecasting', 'scheduling', 'intraday', 'configuration', 'data-management', 'audit', 'administration'] as const;
export type ModuleId = (typeof MODULES)[number];

/** The section a module opens on: the first item under it in the sidebar. */
export const DEFAULT_SUB: Record<ModuleId, string> = {
  overview: '', workforce: 'employees', forecasting: 'forecast-dashboard', scheduling: 'schedule-timeline', intraday: 'live-coverage',
  configuration: 'wfm-groups', 'data-management': 'staged-imports', audit: '', administration: 'users',
};

export const HOME = { module: 'forecasting' as ModuleId, sub: DEFAULT_SUB.forecasting };

export const toPath = (module: string, sub?: string) => `/${module}${sub ? `/${sub}` : ''}`;

export function fromPath(pathname: string): { module: ModuleId; sub: string } {
  const [m, s] = pathname.split('/').filter(Boolean);
  if (!m || !(MODULES as readonly string[]).includes(m)) return HOME;
  const module = m as ModuleId;
  return { module, sub: s || DEFAULT_SUB[module] };
}
