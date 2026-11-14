/**
 * The words for accuracy, in one place so every screen says the same thing. There is one headline figure, "Forecast accuracy": 100% minus the WAPE of the published forecast against what
 * really arrived, per day, over the last 28 days. Everything else a screen shows is a different measure and is labelled as that, never as "accuracy" or an unlabelled "miss".
 */
export interface AccuracyHeadline {
  name: 'Forecast accuracy'; definition: string; windowDays: number; from: string; to: string; days: number;
  accuracyPct: number | null; missPct: number | null; biasPct: number | null; state: 'NONE' | 'SPARSE' | 'OK'; note: string; targetPct: number;
  previousAccuracyPct: number | null; deltaPts: number | null;
}

export const ACCURACY_LABEL = 'Forecast accuracy';
export const ACCURACY_SHORT = 'Forecast accuracy = 100% − WAPE (daily, last 28 days, published forecast against actual).';

/** The other measures, each named for what it is, with what it is for. */
export const OTHER_MEASURES = {
  latestWeek: { label: 'Latest week miss', tip: 'How far the published forecasts were from actual in the latest full week, per day. One week, so it moves more than Forecast accuracy.' },
  test: { label: 'Test miss', tip: 'A test run now: the forecast is rebuilt from history before the window and compared with what happened. It shows how good the method is, not how the published forecasts did.' },
  test15: { label: 'Test miss · 15 min', tip: 'The test miss measured interval by interval. Always larger than the daily figure, because errors do not cancel out within a day.' },
  testHourly: { label: 'Test miss · hourly', tip: 'The test miss measured hour by hour: what most schedules are built on.' },
  testDaily: { label: 'Test miss · daily', tip: 'The test miss measured on whole days.' },
  view: { label: 'Miss in this view', tip: 'How far the forecast was from actual for the days and intervals currently on screen.' },
  backtest: { label: 'Test miss', tip: 'How the model did when tested on the last 4 weeks of history. A version you have not yet published has no real result, so this is shown instead.' },
} as const;

export type Tone = 'good' | 'warn' | 'bad' | 'neutral';
/** Good at or above the target (92%), worth watching to 85%, below that poor. */
export const accuracyTone = (pct: number | null, target = 92): Tone => (pct === null ? 'neutral' : pct >= target ? 'good' : pct >= target - 7 ? 'warn' : 'bad');
export const accuracyValue = (h: AccuracyHeadline | null | undefined): string => (h && h.accuracyPct !== null ? `${h.accuracyPct.toFixed(1)}%` : '–');
/** "Last 28 days · missed by 3.2% a day", or the note when there is not enough to say. */
export const accuracySub = (h: AccuracyHeadline | null | undefined): string => {
  if (!h) return '';
  if (h.accuracyPct === null) return h.note;
  return `Last ${h.windowDays} days · missed by ${h.missPct!.toFixed(1)}% a day${h.state === 'SPARSE' ? ` · ${h.note}` : ''}`;
};
