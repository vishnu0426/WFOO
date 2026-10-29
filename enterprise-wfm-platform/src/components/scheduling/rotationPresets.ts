/**
 * Ready-made rotation patterns. A preset is a shape, not a roster: it says which days are worked and which shift each worked day uses
 * ("A", "B"), and the planner points each letter at one of their own shift templates. Cycle lengths follow the commonly published forms of
 * these patterns; sources differ on some, which is why every preset can be edited after it is applied.
 */
import type { RotationStep } from '../../services/api';

export interface DayPreset {
  id: string; kind: 'DAY_CYCLE'; label: string; summary: string;
  /** one entry per cycle day: a letter for a worked day, null for a day off */
  shape: (string | null)[];
  letters: { letter: string; label: string }[];
  crews: { name: string; offsetDays: number }[];
}
export interface WeeklyPreset {
  id: string; kind: 'WEEKLY'; label: string; summary: string;
  steps: { name: string; weeks: number; letter: string }[];     // each step works its letter Monday to Friday, in the order of the pay week
  letters: { letter: string; label: string }[];
  crews: { name: string; offsetWeeks: number }[];
}
export type Preset = DayPreset | WeeklyPreset;

const off = null;
export const PRESETS: Preset[] = [
  {
    id: '4on4off', kind: 'DAY_CYCLE', label: '4-on-4-off', summary: 'Four days on, four off, 8-day cycle. Two crews cover every day. Weekends off are not guaranteed.',
    shape: ['A', 'A', 'A', 'A', off, off, off, off], letters: [{ letter: 'A', label: 'Shift worked' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 4 }],
  },
  {
    id: '4on4off-dn', kind: 'DAY_CYCLE', label: '4-on-4-off, days then nights', summary: 'Four day shifts, four off, four night shifts, four off: 16-day cycle, four crews for round-the-clock cover.',
    shape: ['D', 'D', 'D', 'D', off, off, off, off, 'N', 'N', 'N', 'N', off, off, off, off], letters: [{ letter: 'D', label: 'Day shift' }, { letter: 'N', label: 'Night shift' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 4 }, { name: 'Crew C', offsetDays: 8 }, { name: 'Crew D', offsetDays: 12 }],
  },
  {
    id: '223', kind: 'DAY_CYCLE', label: '2-2-3 (also called Panama)', summary: 'Two on, two off, three on, then two off, two on, three off: 14-day cycle on 12-hour shifts. Every other weekend off.',
    shape: ['A', 'A', off, off, 'A', 'A', 'A', off, off, 'A', 'A', off, off, off], letters: [{ letter: 'A', label: 'Shift worked' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 7 }],
  },
  {
    id: 'dupont', kind: 'DAY_CYCLE', label: 'DuPont', summary: 'Four nights, three off, three days, one off, three nights, three off, four days, then seven days off: 28-day cycle, four crews.',
    shape: ['N', 'N', 'N', 'N', off, off, off, 'D', 'D', 'D', off, 'N', 'N', 'N', off, off, off, 'D', 'D', 'D', 'D', off, off, off, off, off, off, off],
    letters: [{ letter: 'D', label: 'Day shift' }, { letter: 'N', label: 'Night shift' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 7 }, { name: 'Crew C', offsetDays: 14 }, { name: 'Crew D', offsetDays: 21 }],
  },
  {
    id: '5on2off', kind: 'DAY_CYCLE', label: 'Five on, two off', summary: 'A standard week, one crew: a 7-day cycle.',
    shape: ['A', 'A', 'A', 'A', 'A', off, off], letters: [{ letter: 'A', label: 'Shift worked' }], crews: [{ name: 'Crew A', offsetDays: 0 }],
  },
  {
    id: 'weekly-dln', kind: 'WEEKLY', label: 'Weekly: days, lates, nights', summary: 'Five days a week, Monday to Friday, on a different shift each week: a week of days, then a week of lates, then a week of nights. Three crews start one week apart.',
    steps: [{ name: 'Days', weeks: 1, letter: 'D' }, { name: 'Lates', weeks: 1, letter: 'L' }, { name: 'Nights', weeks: 1, letter: 'N' }],
    letters: [{ letter: 'D', label: 'Day shift' }, { letter: 'L', label: 'Late shift' }, { letter: 'N', label: 'Night shift' }],
    crews: [{ name: 'Crew A', offsetWeeks: 0 }, { name: 'Crew B', offsetWeeks: 1 }, { name: 'Crew C', offsetWeeks: 2 }],
  },
  {
    id: 'weekly-dd-l', kind: 'WEEKLY', label: 'Weekly: two weeks days, one week lates', summary: 'Two weeks of days, then one week of lates, Monday to Friday. One crew.',
    steps: [{ name: 'Days', weeks: 2, letter: 'D' }, { name: 'Lates', weeks: 1, letter: 'L' }],
    letters: [{ letter: 'D', label: 'Day shift' }, { letter: 'L', label: 'Late shift' }], crews: [{ name: 'Crew A', offsetWeeks: 0 }],
  },
];

/** A day-cycle preset filled from the planner's choice of shift template for each letter. */
export function dayPresetPlan(preset: DayPreset, pick: Record<string, string>): { cycleDays: number; sequence: (string | null)[]; crews: { name: string; offsetDays: number }[] } {
  return { cycleDays: preset.shape.length, sequence: preset.shape.map((l) => (l ? pick[l] ?? null : null)), crews: preset.crews };
}

/** Crews of a weekly preset: they start a whole number of weeks apart. */
export const weeklyCrews = (preset: WeeklyPreset) => preset.crews.map((c) => ({ name: c.name, offsetDays: c.offsetWeeks * 7 }));

/** Weekly steps for a preset, with the working days (Monday to Friday) placed correctly whatever weekday the pay week starts on. weekStart: Monday 0 ... Sunday 6. */
export function weeklySteps(preset: WeeklyPreset, pick: Record<string, string>, weekStart: number): RotationStep[] {
  return preset.steps.map((s) => ({
    name: s.name, weeks: s.weeks,
    days: Array.from({ length: 7 }, (_, i) => { const dow = (weekStart + i) % 7; return dow <= 4 ? pick[s.letter] ?? null : null; }),
  }));
}
