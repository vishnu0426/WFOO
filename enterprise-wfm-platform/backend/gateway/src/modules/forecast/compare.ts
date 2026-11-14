/**
 * Two versions of a forecast side by side, day by day. Pure arithmetic (no database): the gateway hands in each version's daily figures.
 *
 * The totals are worked out over the days both versions cover, so a draft that stops a week earlier is not "lower" just for being shorter; the days only one of them has are counted and
 * reported separately.
 */
export interface DayPoint { day: string; volume: number; aht: number; peakRequired?: number; agentHours?: number }
export interface Side { a: number | null; b: number | null }
export interface DayDiff { day: string; a: number | null; b: number | null; delta: number | null; deltaPct: number | null }

const r1 = (v: number) => Math.round(v * 10) / 10;
const pct = (a: number, b: number) => (a > 0 ? r1(((b - a) / a) * 100) : null);

export function compareDays(a: DayPoint[], b: DayPoint[]) {
  const ma = new Map(a.map((d) => [d.day, d])), mb = new Map(b.map((d) => [d.day, d]));
  const days = [...new Set([...ma.keys(), ...mb.keys()])].sort();
  const rows: DayDiff[] = days.map((day) => {
    const x = ma.get(day)?.volume ?? null, y = mb.get(day)?.volume ?? null;
    return { day, a: x === null ? null : r1(x), b: y === null ? null : r1(y), delta: x === null || y === null ? null : r1(y - x), deltaPct: x === null || y === null ? null : pct(x, y) };
  });
  const shared = days.filter((d) => ma.has(d) && mb.has(d));
  const sum = (m: Map<string, DayPoint>, f: (d: DayPoint) => number) => shared.reduce((s, d) => s + f(m.get(d)!), 0);
  const volA = sum(ma, (d) => d.volume), volB = sum(mb, (d) => d.volume);
  const avgAht = (m: Map<string, DayPoint>, vol: number) => (vol > 0 ? Math.round(sum(m, (d) => d.aht * d.volume) / vol) : null);
  const peak = (m: Map<string, DayPoint>) => { const v = shared.map((d) => m.get(d)!.peakRequired).filter((x): x is number => typeof x === 'number'); return v.length ? Math.max(...v) : null; };
  const hours = (m: Map<string, DayPoint>) => { const v = shared.map((d) => m.get(d)!.agentHours).filter((x): x is number => typeof x === 'number'); return v.length ? r1(v.reduce((s, x) => s + x, 0)) : null; };
  const busiest = (m: Map<string, DayPoint>) => { let best: DayPoint | null = null; for (const d of shared) { const p = m.get(d)!; if (!best || p.volume > best.volume) best = p; } return best ? { day: best.day, volume: r1(best.volume) } : null; };
  // the day they differ on most, in contacts
  const biggest = rows.filter((r) => r.delta !== null).sort((x, y) => Math.abs(y.delta!) - Math.abs(x.delta!) || (x.day < y.day ? -1 : 1))[0] ?? null;
  return {
    overlap: shared.length ? { from: shared[0], to: shared.at(-1)!, days: shared.length } : null,
    onlyA: days.filter((d) => ma.has(d) && !mb.has(d)).length, onlyB: days.filter((d) => mb.has(d) && !ma.has(d)).length,
    summary: {
      volume: { a: shared.length ? r1(volA) : null, b: shared.length ? r1(volB) : null, deltaPct: shared.length ? pct(volA, volB) : null } as Side & { deltaPct: number | null },
      avgAht: { a: avgAht(ma, volA), b: avgAht(mb, volB) } as Side,
      peakRequired: { a: peak(ma), b: peak(mb) } as Side,
      agentHours: { a: hours(ma), b: hours(mb) } as Side,
      busiestDay: { a: busiest(ma), b: busiest(mb) },
    },
    biggest: biggest && biggest.delta !== 0 ? { day: biggest.day, delta: biggest.delta!, deltaPct: biggest.deltaPct } : null,
    rows,
  };
}
