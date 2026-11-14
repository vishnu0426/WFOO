/**
 * The one number for "how accurate is the forecast", used on every screen that shows it: 100% minus the WAPE of the published forecast against what really arrived, per day, over the
 * last 28 days. Any other figure on a screen (a test on history, a 15-minute miss, the last full week) is labelled as that and is not called forecast accuracy.
 */
export const WINDOW_DAYS = 28;
/** Under two completed weeks of compared days the figure is shown as an early reading with a note, not as settled. */
export const MIN_DAYS = 14;
export const TARGET_PCT = 92;
export const DEFINITION = 'Forecast accuracy = 100% − WAPE: how far the published forecast was from what really arrived, added up per day over the last 28 days, as a share of real volume.';

export interface Window { wape: number | null; bias: number | null; days: number; from: string; to: string }
export interface Headline {
  name: 'Forecast accuracy'; definition: string; windowDays: number; from: string; to: string; days: number;
  /** 100 − WAPE, in percent, one decimal; null when nothing has been compared */
  accuracyPct: number | null; missPct: number | null; biasPct: number | null;
  state: 'NONE' | 'SPARSE' | 'OK'; note: string; targetPct: number;
  /** the 28 days before, and the change in percentage points (only when both have enough days) */
  previousAccuracyPct: number | null; deltaPts: number | null;
}
const r1 = (n: number) => Math.round(n * 10) / 10;

export function headlineFrom(cur: Window, prev: Window | null): Headline {
  const has = cur.wape !== null && cur.days > 0;
  const state: Headline['state'] = !has ? 'NONE' : cur.days < MIN_DAYS ? 'SPARSE' : 'OK';
  const accuracyPct = has ? r1(100 - cur.wape! * 100) : null;
  const prevOk = prev && prev.wape !== null && prev.days >= MIN_DAYS;
  const previousAccuracyPct = prevOk ? r1(100 - prev!.wape! * 100) : null;
  return {
    name: 'Forecast accuracy', definition: DEFINITION, windowDays: WINDOW_DAYS, from: cur.from, to: cur.to, days: cur.days,
    accuracyPct, missPct: has ? r1(cur.wape! * 100) : null, biasPct: has && cur.bias !== null ? r1(cur.bias * 100) : null,
    state, targetPct: TARGET_PCT,
    note: state === 'NONE' ? 'Needs a published forecast compared with actuals.' : state === 'SPARSE' ? `Needs 2+ completed weeks of data (${cur.days} ${cur.days === 1 ? 'day' : 'days'} so far).` : '',
    previousAccuracyPct, deltaPts: previousAccuracyPct !== null && accuracyPct !== null && state === 'OK' ? r1(accuracyPct - previousAccuracyPct) : null,
  };
}
