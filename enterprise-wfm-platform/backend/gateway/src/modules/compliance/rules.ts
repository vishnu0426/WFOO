/**
 * Labour-law rules as data. A pack is a list of rules, each a type from the catalogue below with parameters and a severity:
 * BLOCK rules stop a schedule being published (and the generator will not create such shifts); WARN rules are reported only.
 * This file is pure (no database) so every rule can be tested on its own.
 */
export type RuleType = 'MAX_DAILY_HOURS' | 'MAX_WEEKLY_HOURS' | 'MAX_SPREAD_HOURS' | 'MIN_DAILY_REST_HOURS' | 'MAX_CONSECUTIVE_DAYS' | 'MEAL_BREAK' | 'NIGHT_WORK' | 'OVERTIME_PREMIUM' | 'MIN_NOTICE_DAYS';
export type Severity = 'BLOCK' | 'WARN';
export interface Rule { id: string; type: RuleType; severity: Severity; params: Record<string, any> }
export interface Finding { rule: RuleType; severity: Severity; employeeId: string; day: string; message: string }

export interface ParamSpec { key: string; label: string; kind: 'number' | 'time' | 'boolean'; unit?: string; min?: number; max?: number; default: number | string | boolean }
export interface RuleSpec { type: RuleType; label: string; help: string; params: ParamSpec[]; defaultSeverity: Severity; informational?: boolean }

/** What an administrator can put in a pack. The screen builds its form from this, so a new rule type needs no screen change. */
export const CATALOG: RuleSpec[] = [
  { type: 'MAX_DAILY_HOURS', label: 'Maximum paid hours in a day', help: 'Paid hours in one shift (meal time excluded) must not exceed this.', defaultSeverity: 'BLOCK', params: [{ key: 'hours', label: 'Hours', kind: 'number', unit: 'h', min: 1, max: 24, default: 9 }] },
  { type: 'MAX_WEEKLY_HOURS', label: 'Maximum paid hours in a week', help: 'Paid hours from Monday to Sunday must not exceed this.', defaultSeverity: 'BLOCK', params: [{ key: 'hours', label: 'Hours', kind: 'number', unit: 'h', min: 1, max: 168, default: 48 }] },
  { type: 'MAX_SPREAD_HOURS', label: 'Maximum spread-over of a shift', help: 'From the start to the end of a shift, meals and breaks included.', defaultSeverity: 'BLOCK', params: [{ key: 'hours', label: 'Hours', kind: 'number', unit: 'h', min: 1, max: 24, default: 12 }] },
  { type: 'MIN_DAILY_REST_HOURS', label: 'Minimum rest between shifts', help: 'The gap between the end of one shift and the start of the next.', defaultSeverity: 'BLOCK', params: [{ key: 'hours', label: 'Hours', kind: 'number', unit: 'h', min: 0, max: 24, default: 11 }] },
  { type: 'MAX_CONSECUTIVE_DAYS', label: 'Maximum days worked in a row', help: 'Guarantees a weekly rest day.', defaultSeverity: 'BLOCK', params: [{ key: 'days', label: 'Days', kind: 'number', unit: 'days', min: 1, max: 14, default: 6 }] },
  { type: 'MEAL_BREAK', label: 'Meal or rest interval', help: 'A shift longer than this needs a meal or rest interval of at least the given length.', defaultSeverity: 'BLOCK', params: [{ key: 'afterHours', label: 'For shifts longer than', kind: 'number', unit: 'h', min: 1, max: 12, default: 5 }, { key: 'minutes', label: 'Interval', kind: 'number', unit: 'min', min: 5, max: 120, default: 30 }] },
  { type: 'NIGHT_WORK', label: 'Night work', help: "Work between these times needs the person's recorded consent.", defaultSeverity: 'BLOCK', params: [{ key: 'from', label: 'Night starts', kind: 'time', default: '19:00' }, { key: 'to', label: 'Night ends', kind: 'time', default: '06:00' }, { key: 'requiresConsent', label: 'Needs consent', kind: 'boolean', default: true }] },
  { type: 'OVERTIME_PREMIUM', label: 'Overtime premium', help: 'Hours beyond these limits are paid at a multiple of the normal rate. Reported, never blocked.', defaultSeverity: 'WARN', informational: true, params: [{ key: 'afterDailyHours', label: 'After hours per day', kind: 'number', unit: 'h', min: 1, max: 24, default: 8 }, { key: 'afterWeeklyHours', label: 'After hours per week', kind: 'number', unit: 'h', min: 1, max: 168, default: 48 }, { key: 'multiplier', label: 'Pay multiple', kind: 'number', unit: '×', min: 1, max: 5, default: 2 }] },
  { type: 'MIN_NOTICE_DAYS', label: 'Advance notice of schedule changes', help: "Changing a published shift closer than this needs the person's agreement and may carry extra pay.", defaultSeverity: 'WARN', params: [{ key: 'days', label: 'Days ahead', kind: 'number', unit: 'days', min: 0, max: 60, default: 14 }] },
];
export const RULE_TYPES = CATALOG.map((c) => c.type) as [RuleType, ...RuleType[]];
const SPEC = new Map(CATALOG.map((c) => [c.type, c]));

/** Fill in missing parameters and clamp the rest to the catalogue's limits. Throws a plain message for a rule that cannot be understood. */
export function normaliseRule(r: Partial<Rule> & { type: RuleType }, index = 0): Rule {
  const spec = SPEC.get(r.type);
  if (!spec) throw new Error(`Unknown rule type "${r.type}"`);
  const params: Record<string, any> = {};
  for (const p of spec.params) {
    const v = r.params?.[p.key] ?? p.default;
    if (p.kind === 'number') { const n = Number(v); if (Number.isNaN(n)) throw new Error(`${spec.label}: ${p.label} must be a number`); params[p.key] = Math.min(p.max ?? Infinity, Math.max(p.min ?? -Infinity, n)); }
    else if (p.kind === 'time') { if (!/^\d{1,2}:\d{2}$/.test(String(v))) throw new Error(`${spec.label}: ${p.label} must look like 19:00`); params[p.key] = String(v).padStart(5, '0'); }
    else params[p.key] = !!v;
  }
  return { id: r.id || `${r.type.toLowerCase()}-${index + 1}`, type: r.type, severity: r.severity === 'WARN' ? 'WARN' : r.severity === 'BLOCK' ? 'BLOCK' : spec.defaultSeverity, params };
}

/** A pack shipped with the product. Administrators copy one to change it. */
export interface BuiltIn { code: string; name: string; region: string; description: string; rules: Rule[] }
const R = (type: RuleType, params: Record<string, any>, severity?: Severity, i = 0) => normaliseRule({ type, params, severity }, i);
export const BUILT_INS: BuiltIn[] = [
  {
    code: 'IN_OSH_2020', name: 'India: Occupational Safety, Health and Working Conditions Code 2020', region: 'India',
    description: 'Normal hours 8 a day and 48 a week with overtime at twice the wage; spread-over within 12 hours; 30 minutes rest after 5 hours; a weekly rest day; night work (7pm to 6am) only with consent. State Shops and Establishments rules can differ: copy this pack and adjust.',
    rules: [R('MAX_DAILY_HOURS', { hours: 8 }, 'WARN', 0), R('MAX_WEEKLY_HOURS', { hours: 48 }, 'WARN', 1), R('MAX_SPREAD_HOURS', { hours: 12 }, 'BLOCK', 2), R('MEAL_BREAK', { afterHours: 5, minutes: 30 }, 'BLOCK', 3),
      R('MAX_CONSECUTIVE_DAYS', { days: 6 }, 'BLOCK', 4), R('NIGHT_WORK', { from: '19:00', to: '06:00', requiresConsent: true }, 'BLOCK', 5), R('OVERTIME_PREMIUM', { afterDailyHours: 8, afterWeeklyHours: 48, multiplier: 2 }, 'WARN', 6)],
  },
  {
    code: 'EU_WTD', name: 'European Union: Working Time Directive 2003/88/EC', region: 'European Union',
    description: 'Average week no more than 48 hours (checked per week here), 11 hours daily rest, a weekly rest day and a break for shifts over 6 hours. Member states add their own rules: copy this pack and adjust.',
    rules: [R('MAX_WEEKLY_HOURS', { hours: 48 }, 'BLOCK', 0), R('MIN_DAILY_REST_HOURS', { hours: 11 }, 'BLOCK', 1), R('MAX_CONSECUTIVE_DAYS', { days: 6 }, 'BLOCK', 2), R('MEAL_BREAK', { afterHours: 6, minutes: 20 }, 'BLOCK', 3)],
  },
  {
    code: 'US_PREDICTIVE', name: 'United States: predictive scheduling (fair workweek)', region: 'United States',
    description: 'Schedules posted 14 days ahead, with extra pay and consent when a published shift changes inside that window, and 10 hours between shifts. Applies in Oregon and some cities only.',
    rules: [R('MIN_NOTICE_DAYS', { days: 14 }, 'WARN', 0), R('MIN_DAILY_REST_HOURS', { hours: 10 }, 'WARN', 1)],
  },
];

// ---------------------------------------------------------------- checking

export interface ShiftLite { day: string; startSlot: number; lengthSlots: number; mealSlots: number }
export interface PersonLite { id: string; name: string; nightConsent: boolean }
const SPD = 96;
const r1 = (v: number) => Math.round(v * 10) / 10;
const utcMs = (d: string) => { const [y, m, dd] = d.split('-').map(Number); return Date.UTC(y, m - 1, dd); };
export const addDaysStr = (d: string, n: number) => new Date(utcMs(d) + n * 864e5).toISOString().slice(0, 10);
const dow = (d: string) => (new Date(utcMs(d)).getUTCDay() + 6) % 7;
/** First day of the pay week `d` falls in; weeks start on Monday unless `weekStart` (Monday 0 ... Sunday 6) says otherwise. */
const mondayOf = (d: string, weekStart = 0) => addDaysStr(d, -((dow(d) - weekStart + 7) % 7));
const slotOfTime = (t: string) => { const [h, m] = t.split(':').map(Number); return Math.floor((h * 60 + m) / 15); };
const paidH = (s: { lengthSlots: number; mealSlots: number }) => (s.lengthSlots - s.mealSlots) / 4;

/** Does any part of the shift fall inside the night window (which may cross midnight)? */
export function touchesNight(s: { startSlot: number; lengthSlots: number }, from: string, to: string): boolean {
  const a = slotOfTime(from), b = slotOfTime(to);
  for (let g = s.startSlot; g < s.startSlot + s.lengthSlots; g++) {
    const x = g % SPD;
    if (a <= b ? x >= a && x < b : x >= a || x < b) return true;
  }
  return false;
}

/** Rules that look at one shift alone (used by the generator to leave out shifts a BLOCK rule forbids). Returns the reason, or null. */
export function shiftBlocked(rules: Rule[], person: Pick<PersonLite, 'nightConsent'>, s: { startSlot: number; lengthSlots: number; mealSlots: number }): string | null {
  for (const r of rules) {
    if (r.severity !== 'BLOCK') continue;
    if (r.type === 'MAX_DAILY_HOURS' && paidH(s) > r.params.hours) return `would exceed ${r.params.hours} paid hours in a day`;
    if (r.type === 'MAX_SPREAD_HOURS' && s.lengthSlots / 4 > r.params.hours) return `would spread over more than ${r.params.hours} hours`;
    if (r.type === 'MEAL_BREAK' && s.lengthSlots / 4 > r.params.afterHours && s.mealSlots * 15 < r.params.minutes) return `has no ${r.params.minutes}-minute interval`;
    if (r.type === 'NIGHT_WORK' && r.params.requiresConsent && !person.nightConsent && touchesNight(s, r.params.from, r.params.to)) return 'has not consented to night work';
  }
  return null;
}

/** Limits a BLOCK rule sets that the generator can take as a plain number. */
export function limitsFrom(rules: Rule[]): { minRestHours?: number; maxWeeklyHours?: number; maxConsecutiveDays?: number } {
  const o: { minRestHours?: number; maxWeeklyHours?: number; maxConsecutiveDays?: number } = {};
  for (const r of rules) {
    if (r.severity !== 'BLOCK') continue;
    if (r.type === 'MIN_DAILY_REST_HOURS') o.minRestHours = Math.max(o.minRestHours ?? 0, r.params.hours);
    if (r.type === 'MAX_WEEKLY_HOURS') o.maxWeeklyHours = Math.min(o.maxWeeklyHours ?? Infinity, r.params.hours);
    if (r.type === 'MAX_CONSECUTIVE_DAYS') o.maxConsecutiveDays = Math.min(o.maxConsecutiveDays ?? Infinity, r.params.days);
  }
  return o;
}

/** Everything the rules say about one person's shifts. */
export function checkPerson(rules: Rule[], person: PersonLite, list: ShiftLite[], weekStart = 0): Finding[] {
  const out: Finding[] = [];
  const shifts = [...list].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.startSlot - b.startSlot));
  const add = (r: Rule, day: string, message: string) => out.push({ rule: r.type, severity: r.severity, employeeId: person.id, day, message });
  for (const r of rules) {
    const p = r.params;
    if (r.type === 'MAX_DAILY_HOURS') for (const s of shifts) if (paidH(s) > p.hours) add(r, s.day, `${person.name} works ${r1(paidH(s))}h on ${s.day} (limit ${p.hours}h a day)`);
    if (r.type === 'MAX_SPREAD_HOURS') for (const s of shifts) if (s.lengthSlots / 4 > p.hours) add(r, s.day, `${person.name}'s shift on ${s.day} spreads over ${r1(s.lengthSlots / 4)}h (limit ${p.hours}h)`);
    if (r.type === 'MEAL_BREAK') for (const s of shifts) if (s.lengthSlots / 4 > p.afterHours && s.mealSlots * 15 < p.minutes) add(r, s.day, `${person.name}'s ${r1(s.lengthSlots / 4)}h shift on ${s.day} has no ${p.minutes}-minute meal or rest interval`);
    if (r.type === 'NIGHT_WORK' && p.requiresConsent && !person.nightConsent) for (const s of shifts) if (touchesNight(s, p.from, p.to)) add(r, s.day, `${person.name} works during night hours (${p.from} to ${p.to}) on ${s.day} without recorded consent`);
    if (r.type === 'MIN_DAILY_REST_HOURS') for (let i = 1; i < shifts.length; i++) {
      if (shifts[i].day !== addDaysStr(shifts[i - 1].day, 1)) continue;
      const gap = SPD + shifts[i].startSlot - (shifts[i - 1].startSlot + shifts[i - 1].lengthSlots);
      if (gap < p.hours * 4) add(r, shifts[i].day, `${person.name} has ${r1(gap / 4)}h between shifts before ${shifts[i].day} (needs ${p.hours}h)`);
    }
    if (r.type === 'MAX_CONSECUTIVE_DAYS') {
      let run = 1;
      for (let i = 1; i < shifts.length; i++) {
        run = shifts[i].day === addDaysStr(shifts[i - 1].day, 1) ? run + 1 : shifts[i].day === shifts[i - 1].day ? run : 1;
        if (run === p.days + 1) add(r, shifts[i].day, `${person.name} works more than ${p.days} days in a row`);
      }
    }
    if (r.type === 'MAX_WEEKLY_HOURS') {
      const weeks = new Map<string, number>();
      for (const s of shifts) weeks.set(mondayOf(s.day, weekStart), (weeks.get(mondayOf(s.day, weekStart)) ?? 0) + paidH(s));
      for (const [wk, h] of weeks) if (h > p.hours + 1e-9) add(r, wk, `${person.name} works ${r1(h)}h in the week of ${wk} (limit ${p.hours}h)`);
    }
  }
  return out;
}

/** Hours that attract the overtime premium, with the multiple to pay. Reported, never a violation. */
export function premiumHours(rules: Rule[], list: ShiftLite[], weekStart = 0): { hours: number; multiplier: number } {
  const r = rules.find((x) => x.type === 'OVERTIME_PREMIUM');
  if (!r) return { hours: 0, multiplier: 1 };
  const byDay = new Map<string, number>(), byWeek = new Map<string, number>();
  for (const s of list) { byDay.set(s.day, (byDay.get(s.day) ?? 0) + paidH(s)); byWeek.set(mondayOf(s.day, weekStart), (byWeek.get(mondayOf(s.day, weekStart)) ?? 0) + paidH(s)); }
  let daily = 0, weekly = 0;
  for (const h of byDay.values()) daily += Math.max(0, h - r.params.afterDailyHours);
  for (const h of byWeek.values()) weekly += Math.max(0, h - r.params.afterWeeklyHours);
  return { hours: r1(Math.max(daily, weekly)), multiplier: r.params.multiplier };
}

/** A change to a published shift this close to the day it falls on breaks the notice rule. Null when it does not. */
export function noticeFinding(rules: Rule[], person: PersonLite, day: string, today: string): Finding | null {
  const r = rules.find((x) => x.type === 'MIN_NOTICE_DAYS');
  if (!r) return null;
  const ahead = Math.round((utcMs(day) - utcMs(today)) / 864e5);
  return ahead < r.params.days
    ? { rule: r.type, severity: r.severity, employeeId: person.id, day, message: `${person.name}'s shift on ${day} is only ${Math.max(0, ahead)} day${ahead === 1 ? '' : 's'} away; the pack asks for ${r.params.days} days' notice, so this needs their agreement and may carry extra pay` }
    : null;
}
