/**
 * The look-back periods offered for accuracy and quality, the same on every screen that has them (the accuracy trend, the self-learning trend), so a choice means the same thing everywhere.
 * In weeks, because forecasts and schedules are planned in weeks; the choice is remembered between screens.
 */
export interface Period { weeks: number; label: string }
export const PERIOD_PRESETS: Period[] = [
  { weeks: 8, label: '8 weeks' },
  { weeks: 12, label: '12 weeks' },
  { weeks: 26, label: '26 weeks' },
  { weeks: 52, label: '52 weeks' },
];
export const DEFAULT_WEEKS = 12;
export const PERIOD_KEY = 'wfm_quality_weeks';

/** A remembered choice, or the default when it is missing or not one of the presets. */
export function readWeeks(raw: string | null | undefined): number {
  const n = Number(raw);
  return PERIOD_PRESETS.some((p) => p.weeks === n) ? n : DEFAULT_WEEKS;
}
export const daysOf = (weeks: number) => weeks * 7;
export const weeksLabel = (weeks: number) => PERIOD_PRESETS.find((p) => p.weeks === weeks)?.label ?? `${weeks} weeks`;
