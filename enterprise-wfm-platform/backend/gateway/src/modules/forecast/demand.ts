/**
 * Demand from history. A queue's `volume` is either every call that arrived (OFFERED) or only the calls an agent answered (ANSWERED).
 * In the second case the callers who gave up are not in the figure, so a forecast built on it would plan for less work than really arrived.
 * Those callers are added back, less the share who ring again and are already counted in a later interval.
 */
export type VolumeBasis = 'OFFERED' | 'ANSWERED';

export function demandVolume(volume: number, abandoned: number, basis: VolumeBasis, repeatPct = 0): number {
  if (basis !== 'ANSWERED') return volume;
  const lost = Math.max(0, abandoned) * (1 - Math.min(100, Math.max(0, repeatPct)) / 100);
  return volume + Math.round(lost);
}

/** The same sum in SQL, for `interval_history h` joined to `queues q`. */
export const DEMAND_SQL = `(h.volume + CASE WHEN q.volume_basis = 'ANSWERED' THEN round(h.abandoned * (100 - q.abandon_repeat_pct) / 100.0)::int ELSE 0 END)`;
