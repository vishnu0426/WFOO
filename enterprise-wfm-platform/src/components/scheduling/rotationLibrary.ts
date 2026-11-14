/**
 * The rotation library: the ready-made patterns grouped into categories, the facts worked out from a pattern's shape (so a planner can compare before applying),
 * and the conversion from a pattern saved by the organisation. The cycle lengths are the commonly published forms of these patterns; sources differ on some of them,
 * which is why every pattern can be edited after it is applied and why the library says "check with your customer".
 */
import { PRESETS, type DayPreset, type Preset, type WeeklyPreset } from './rotationPresets';

export const CATEGORIES = [
  { id: 'STANDARD', label: 'Standard weeks' },
  { id: 'CREW_24X7', label: 'Round-the-clock crews' },
  { id: 'WEEKLY', label: 'Weekly rotations' },
  { id: 'PART_TIME', label: 'Part-time and cover' },
  { id: 'CUSTOM', label: 'Your library' },
] as const;
export type CategoryId = (typeof CATEGORIES)[number]['id'];

const off = null;
const NOTE = 'Commonly published form; check it against the customer\'s own agreement and local law.';

const CATEGORY_OF: Record<string, CategoryId> = {
  '4on4off': 'CREW_24X7', '4on4off-dn': 'CREW_24X7', '223': 'CREW_24X7', '223-dn': 'CREW_24X7', dupont: 'CREW_24X7', '5on2off': 'STANDARD',
  'weekly-dln': 'WEEKLY', 'weekly-dd-l': 'WEEKLY',
};

const ADDED: Preset[] = [
  {
    id: 'continental', kind: 'DAY_CYCLE', category: 'CREW_24X7', label: 'Continental (2-2-2-2)', note: NOTE,
    summary: 'Two early shifts, two lates, two nights, two days off: an 8-day cycle with four crews. Three crews are working a shift on every day, one is off, so all three shifts are always covered on 8-hour shifts.',
    shape: ['E', 'E', 'L', 'L', 'N', 'N', off, off], letters: [{ letter: 'E', label: 'Early shift' }, { letter: 'L', label: 'Late shift' }, { letter: 'N', label: 'Night shift' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 2 }, { name: 'Crew C', offsetDays: 4 }, { name: 'Crew D', offsetDays: 6 }],
  },
  {
    id: '6on2off', kind: 'DAY_CYCLE', category: 'STANDARD', label: '6-on-2-off', note: NOTE,
    summary: 'Six days on, two off, an 8-day cycle. Two crews, four days apart, cover every day with some overlap. Weekends off are not guaranteed.',
    shape: ['A', 'A', 'A', 'A', 'A', 'A', off, off], letters: [{ letter: 'A', label: 'Shift worked' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 4 }],
  },
  {
    id: '4on3off', kind: 'DAY_CYCLE', category: 'STANDARD', label: '4-on-3-off (compressed week, 10-hour shifts)', note: NOTE,
    summary: 'Four 10-hour days then three off, a 7-day cycle. Two crews, three days apart, cover all seven days with one day of overlap.',
    shape: ['A', 'A', 'A', 'A', off, off, off], letters: [{ letter: 'A', label: 'Shift worked (10 hours)' }],
    crews: [{ name: 'Crew A', offsetDays: 0 }, { name: 'Crew B', offsetDays: 3 }],
  },
  {
    id: 'fixed-nights', kind: 'DAY_CYCLE', category: 'STANDARD', label: 'Fixed nights, five on two off', note: NOTE,
    summary: 'The same night shift five days a week, Monday to Friday. Set the anchor date to a Monday. One crew.',
    shape: ['N', 'N', 'N', 'N', 'N', off, off], letters: [{ letter: 'N', label: 'Night shift' }], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorWeekday: 0,
  },
  {
    id: 'weekly-dn', kind: 'WEEKLY', category: 'WEEKLY', label: 'Weekly: days then nights', note: NOTE,
    summary: 'A week of days, then a week of nights, Monday to Friday. Two crews, a week apart, so there is always a day and a night crew.',
    steps: [{ name: 'Days', weeks: 1, letter: 'D' }, { name: 'Nights', weeks: 1, letter: 'N' }],
    letters: [{ letter: 'D', label: 'Day shift' }, { letter: 'N', label: 'Night shift' }], crews: [{ name: 'Crew A', offsetWeeks: 0 }, { name: 'Crew B', offsetWeeks: 1 }],
  },
  {
    id: 'three-12s', kind: 'DAY_CYCLE', category: 'PART_TIME', label: 'Three 12-hour days (3-on-4-off)', note: NOTE,
    summary: 'Three long shifts then four days off, a 7-day cycle, for part-time contracts of about 36 hours. One crew.',
    shape: ['A', 'A', 'A', off, off, off, off], letters: [{ letter: 'A', label: 'Shift worked (12 hours)' }], crews: [{ name: 'Crew A', offsetDays: 0 }],
  },
  {
    id: 'weekend-fri-sun', kind: 'DAY_CYCLE', category: 'PART_TIME', label: 'Weekend cover, Friday to Sunday', note: NOTE,
    summary: 'Three days a week, Friday, Saturday and Sunday. Set the anchor date to a Monday. One crew.',
    shape: [off, off, off, off, 'A', 'A', 'A'], letters: [{ letter: 'A', label: 'Shift worked' }], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorWeekday: 0,
  },
  {
    id: 'weekend-sat-sun', kind: 'DAY_CYCLE', category: 'PART_TIME', label: 'Weekend only, Saturday and Sunday', note: NOTE,
    summary: 'Two long days at the weekend only. Set the anchor date to a Monday. One crew.',
    shape: [off, off, off, off, off, 'A', 'A'], letters: [{ letter: 'A', label: 'Shift worked' }], crews: [{ name: 'Crew A', offsetDays: 0 }], anchorWeekday: 0,
  },
];

/** Every ready-made pattern, with its category and the reminder about where its shape comes from. */
export const LIBRARY: Preset[] = [
  ...PRESETS.map((p) => ({ ...p, category: CATEGORY_OF[p.id] ?? 'STANDARD', note: NOTE })),
  ...ADDED,
];

// ---------------------------------------------------------------- a pattern the organisation saved

export interface SavedTemplate {
  id: string; name: string; category: string; summary: string; kind: 'DAY_CYCLE' | 'WEEKLY'; shape: (string | null)[];
  steps: { name: string; weeks: number; letter?: string; days?: (string | null)[] }[] | null;
  letters: { letter: string; label: string }[]; crews: { name: string; offsetDays?: number; offsetWeeks?: number }[]; usedBy: number;
}

/** A saved pattern as a preset the form can apply (its id starts with "lib:" so a pattern made from it can point back at it). */
export function savedToPreset(t: SavedTemplate): Preset {
  const meta = { category: 'CUSTOM', note: 'Saved by your organisation.', saved: { id: t.id, usedBy: t.usedBy } };
  if (t.kind === 'WEEKLY') return { id: `lib:${t.id}`, kind: 'WEEKLY', label: t.name, summary: t.summary || 'A weekly rotation saved by your organisation.', steps: t.steps ?? [], letters: t.letters, crews: t.crews.map((c) => ({ name: c.name, offsetWeeks: c.offsetWeeks ?? 0 })), ...meta };
  return { id: `lib:${t.id}`, kind: 'DAY_CYCLE', label: t.name, summary: t.summary || 'A pattern saved by your organisation.', shape: t.shape, letters: t.letters, crews: t.crews.map((c) => ({ name: c.name, offsetDays: c.offsetDays ?? 0 })), ...meta };
}

// ---------------------------------------------------------------- what a shape means

/** One crew's cycle as one entry per day (a letter or null), whatever kind of preset it is. Weekly steps are read with Monday as the first day of the week. */
export function cycleOf(p: Preset): (string | null)[] {
  if (p.kind === 'DAY_CYCLE') return p.shape;
  return p.steps.flatMap((s) => Array.from({ length: s.weeks }, () => s.days ?? Array.from({ length: 7 }, (_, i) => (i <= 4 ? s.letter ?? null : null))).flat());
}
const crewOffsets = (p: Preset) => (p.kind === 'DAY_CYCLE' ? p.crews.map((c) => c.offsetDays) : p.crews.map((c) => c.offsetWeeks * 7));

export interface PresetFacts { cycleDays: number; crews: number; daysPerWeek: number; longestRun: number; nightsPerCycle: number; coverage: 'ROUND_THE_CLOCK' | 'EVERY_DAY' | 'GAPS' }

export function presetFacts(p: Preset): PresetFacts {
  const seq = cycleOf(p).flat() as (string | null)[];
  const n = seq.length;
  const work = seq.filter(Boolean).length;
  let run = 0, longest = 0;
  for (let i = 0; i < n * 2; i++) { if (seq[i % n]) { run++; longest = Math.max(longest, run); } else run = 0; }
  longest = Math.min(longest, n);
  const nightLetters = new Set(p.letters.filter((l) => /night/i.test(l.label)).map((l) => l.letter));
  const offs = crewOffsets(p);
  const letters = p.letters.map((l) => l.letter);
  let everyDay = true, everyShift = letters.length > 1;
  for (let d = 0; d < n; d++) {
    const on = new Set(offs.map((o) => seq[(d + o) % n]).filter(Boolean) as string[]);
    if (!on.size) everyDay = false;
    if (letters.some((l) => !on.has(l))) everyShift = false;
  }
  return {
    cycleDays: n, crews: offs.length, daysPerWeek: Math.round((work * 7 / n) * 10) / 10, longestRun: longest,
    nightsPerCycle: seq.filter((l) => l && nightLetters.has(l)).length,
    coverage: everyDay && everyShift ? 'ROUND_THE_CLOCK' : everyDay ? 'EVERY_DAY' : 'GAPS',
  };
}

export const coverageText = (c: PresetFacts['coverage'], letters: number) =>
  c === 'ROUND_THE_CLOCK' ? 'Covers every shift every day' : c === 'EVERY_DAY' ? (letters > 1 ? 'Covers every day, not every shift' : 'Covers every day') : 'Leaves some days uncovered';
