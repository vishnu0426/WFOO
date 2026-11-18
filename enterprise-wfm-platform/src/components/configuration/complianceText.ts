/** Plain words for a compliance pack's card: the limits its rules set, and where it applies. Pure, so it is tested without the screen. */
export type Rule = { id: string; type: string; severity: 'BLOCK' | 'WARN'; params: Record<string, any> };
export type Placed = { scopeType: 'TENANT' | 'REGION' | 'SITE' | 'GROUP' | 'TEAM' | 'EMPLOYEE'; scopeName: string };

const SCOPE_WORDS: Record<string, [string, string]> = { REGION: ['region', 'regions'], SITE: ['site', 'sites'], GROUP: ['group', 'groups'], TEAM: ['team', 'teams'], EMPLOYEE: ['person', 'people'] };
/** Where a pack applies, in a few words: the whole organisation, or a count of regions, sites, groups, teams and people. */
export const scopeText = (a: Placed[]) => {
  if (a.some((x) => x.scopeType === 'TENANT')) return a.length > 1 ? `Whole organisation + ${a.length - 1} more` : 'Whole organisation';
  const by = new Map<string, number>();
  for (const x of a) by.set(x.scopeType, (by.get(x.scopeType) ?? 0) + 1);
  return [...by].map(([k, n]) => `${n} ${SCOPE_WORDS[k]?.[n === 1 ? 0 : 1] ?? k.toLowerCase()}`).join(', ');
};
/** The limits a pack sets, in plain words, taken from its rules (what blocks publishing first). At most `max` are shown. */
export function headline(p: { rules: Rule[] }, max = 3): { shown: string[]; more: number; warnOnly: boolean } {
  const say = (r: Rule): string | null => {
    const x = r.params;
    switch (r.type) {
      case 'MAX_WEEKLY_HOURS': return `${x.hours} h a week`;
      case 'MAX_DAILY_HOURS': return `${x.hours} h a day`;
      case 'MAX_SPREAD_HOURS': return `${x.hours} h spread-over`;
      case 'MIN_DAILY_REST_HOURS': return `${x.hours} h rest`;
      case 'MAX_CONSECUTIVE_DAYS': return `${x.days} days in a row`;
      case 'MIN_DAYS_OFF_TOGETHER': return `${x.days} days off together`;
      case 'MIN_WEEKENDS_OFF_MONTH': return `${x.weekends} weekends off a month`;
      case 'MEAL_BREAK': return `${x.minutes} min break after ${x.afterHours} h`;
      case 'NIGHT_WORK': return 'night work needs consent';
      case 'MIN_NOTICE_DAYS': return `${x.days} days' notice`;
      default: return null;                                   // overtime premium and anything new: shown in the pack itself
    }
  };
  const ordered = [...p.rules].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'BLOCK' ? -1 : 1));
  const all = ordered.map(say).filter((t): t is string => !!t);
  return { shown: all.slice(0, max), more: Math.max(0, all.length - max), warnOnly: p.rules.length > 0 && p.rules.every((r) => r.severity === 'WARN') };
}


/** One rule as a full sentence, for reading a pack's rules in the drawer. */
export function ruleLine(r: Rule): string {
  const x = r.params;
  switch (r.type) {
    case 'MAX_DAILY_HOURS': return `At most ${x.hours} paid hours in a day`;
    case 'MAX_WEEKLY_HOURS': return `At most ${x.hours} paid hours in a pay week`;
    case 'MAX_SPREAD_HOURS': return `A shift spreads over at most ${x.hours} hours, meals and breaks included`;
    case 'MIN_DAILY_REST_HOURS': return `At least ${x.hours} hours between the end of one shift and the start of the next`;
    case 'MAX_CONSECUTIVE_DAYS': return `At most ${x.days} days worked in a row`;
    case 'MIN_DAYS_OFF_TOGETHER': return `At least ${x.days} days off side by side in every full pay week`;
    case 'MIN_WEEKENDS_OFF_MONTH': return `At least ${x.weekends} full weekends off in every month`;
    case 'MEAL_BREAK': return `A shift longer than ${x.afterHours} hours has a meal or rest interval of at least ${x.minutes} minutes`;
    case 'NIGHT_WORK': return `Work between ${x.from} and ${x.to} ${x.requiresConsent ? "needs the person's recorded consent" : 'is allowed'}`;
    case 'OVERTIME_PREMIUM': return `Hours beyond ${x.afterDailyHours} a day or ${x.afterWeeklyHours} a week are paid at ${x.multiplier} times the normal rate`;
    case 'MIN_NOTICE_DAYS': return `Changing a published shift needs ${x.days} days' notice`;
    default: return r.type;
  }
}
