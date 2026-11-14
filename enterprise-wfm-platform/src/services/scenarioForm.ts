/**
 * Rules behind the Scenarios (what-if) screen, with no React and no browser so they are tested on their own: the starting points (presets), how a scenario in the form becomes the
 * parameters the server takes and back, and how a change against the baseline is worded.
 */
export interface Params { volumePct?: number; ahtPct?: number; ahtAddSec?: number; shrinkage?: number; serviceLevel?: number; occupancyCap?: number }
/** What is typed for one scenario. Targets are percentages as text so that blank means "keep the group's setting". */
export interface Draft { name: string; volumePct: number; aht: number; ahtUnit: 'pct' | 'sec'; shrinkage: string; serviceLevel: string; occupancyCap: string }

export const MAX_SCENARIOS = 5;
export const blank = (name: string, extra: Partial<Draft> = {}): Draft => ({ name, volumePct: 0, aht: 0, ahtUnit: 'pct', shrinkage: '', serviceLevel: '', occupancyCap: '', ...extra });

export interface Preset { id: string; label: string; make: () => Draft }
/** One click to a scenario worth looking at, instead of a blank row of five boxes. Each can be changed afterwards. */
export const PRESETS: Preset[] = [
  { id: 'vol10', label: '+10% volume', make: () => blank('Volume +10%', { volumePct: 10 }) },
  { id: 'aht15', label: '+15 s handle time', make: () => blank('Handle time +15 s', { aht: 15, ahtUnit: 'sec' }) },
  { id: 'shrink25', label: 'Shrinkage 25%', make: () => blank('Shrinkage 25%', { shrinkage: '25' }) },
  { id: 'holiday', label: 'Holiday week', make: () => blank('Holiday week', { volumePct: 25, shrinkage: '35' }) },
];

const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));
export function toParams(d: Draft): Params {
  const p: Params = {};
  if (d.volumePct) p.volumePct = d.volumePct;
  if (d.aht) { if (d.ahtUnit === 'sec') p.ahtAddSec = d.aht; else p.ahtPct = d.aht; }
  const sh = num(d.shrinkage), sl = num(d.serviceLevel), oc = num(d.occupancyCap);
  if (sh !== null) p.shrinkage = sh / 100;
  if (sl !== null) p.serviceLevel = sl / 100;
  if (oc !== null) p.occupancyCap = oc / 100;
  return p;
}
const pctText = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 1000) / 10));
export function fromParams(name: string, p: Params): Draft {
  return blank(name, {
    volumePct: p.volumePct ?? 0, aht: p.ahtAddSec ?? p.ahtPct ?? 0, ahtUnit: p.ahtAddSec !== undefined ? 'sec' : 'pct',
    shrinkage: pctText(p.shrinkage), serviceLevel: pctText(p.serviceLevel), occupancyCap: pctText(p.occupancyCap),
  });
}
/** A stable text for what a scenario asks for: when it changes, the comparison is worked out again. */
export const scenarioKey = (d: Draft) => JSON.stringify([d.name.trim(), toParams(d)]);
/** Is it the same as the baseline (nothing changed)? */
export const isBaseline = (d: Draft) => Object.keys(toParams(d)).length === 0;
/** Why a scenario cannot be compared yet, or an empty string. */
export function problemWith(d: Draft): string {
  const sh = num(d.shrinkage), sl = num(d.serviceLevel), oc = num(d.occupancyCap);
  if (d.volumePct < -90 || d.volumePct > 500) return 'Volume can change between −90% and +500%.';
  if (d.ahtUnit === 'pct' && (d.aht < -90 || d.aht > 500)) return 'Handle time can change between −90% and +500%.';
  if (d.ahtUnit === 'sec' && (d.aht < -600 || d.aht > 600)) return 'Handle time can change by up to 600 seconds either way.';
  if (sh !== null && (sh < 0 || sh > 90)) return 'Shrinkage is between 0% and 90%.';
  if (sl !== null && (sl < 1 || sl > 99)) return 'Service level is between 1% and 99%.';
  if (oc !== null && (oc <= 30 || oc > 100)) return 'The occupancy cap is above 30% and at most 100%.';
  return '';
}

/** "+3.2 FTE", "−0.4 FTE", "No change". */
export function deltaText(v: number | null | undefined, unit: string, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  if (r === 0) return 'No change';
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toLocaleString('en', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${unit ? ` ${unit}` : ''}`;
}
export function money(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return '–';
  try { return new Intl.NumberFormat('en', { style: 'currency', currency, maximumFractionDigits: 0 }).format(v); } catch { return `${currency} ${Math.round(v).toLocaleString('en')}`; }
}
export function moneyDelta(v: number | null | undefined, currency: string): string {
  if (v === null || v === undefined) return '–';
  if (Math.round(v) === 0) return 'No change';
  return `${v > 0 ? '+' : '−'}${money(Math.abs(v), currency)}`;
}

export interface HeadlineResult { fte: number; impactRequiredFteDelta: number; impactServiceLevelDelta: number | null; impactCostDelta: number | null }
/** One plain sentence on what a scenario does: "Holiday week needs 3.2 more agents (+21%); service level -4.0 pts; costs $23,918 more." */
export function headline(name: string, r: HeadlineResult, baseFte: number, currency: string): string {
  const parts: string[] = [];
  const d = r.impactRequiredFteDelta;
  if (Math.abs(d) < 0.05) parts.push('needs the same number of agents');
  else {
    const share = baseFte > 0 ? ` (${d > 0 ? '+' : '−'}${Math.round((Math.abs(d) / baseFte) * 100)}%)` : '';
    parts.push(`needs ${Math.abs(Math.round(d * 10) / 10).toFixed(1)} ${d > 0 ? 'more' : 'fewer'} agents${share}`);
  }
  const sl = r.impactServiceLevelDelta;
  if (sl !== null && Math.abs(sl) >= 0.05) parts.push(`service level ${sl > 0 ? '+' : '−'}${Math.abs(sl).toFixed(1)} pts`);
  const c = r.impactCostDelta;
  if (c !== null && Math.abs(c) >= 0.5) parts.push(`costs ${money(Math.abs(c), currency)} ${c > 0 ? 'more' : 'less'}`);
  return `${name} ${parts.join('; ')}.`;
}
