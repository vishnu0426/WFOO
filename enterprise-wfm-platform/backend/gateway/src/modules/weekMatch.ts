/** Choosing which solved week a repeated week should copy, kept free of the database so it can be tested on its own. */
/**
 * Which solved week each repeated week should copy. Plain repetition takes them in turn; but a week with a different demand shape (a holiday, a campaign, a
 * month with a later peak) is better served by the solved week whose demand looks most like it. The choice is kept in rotation order unless another week
 * fits clearly better (`margin`), so people's rotations are not shuffled for a trivial gain.
 */
export function matchWeeks(cycleDemand: number[][], targetDemand: number[][], margin = 0.03): { source: number[]; distance: number[]; changed: number } {
  const dist = (a: number[], b: number[]) => { const tot = Math.max(1, b.reduce((x, y) => x + y, 0)); return a.reduce((x, y, i) => x + Math.abs(y - (b[i] ?? 0)), 0) / tot; };
  const source: number[] = [], distance: number[] = []; let changed = 0;
  targetDemand.forEach((t, k) => {
    const turn = k % cycleDemand.length;
    let best = turn, bd = dist(cycleDemand[turn], t);
    cycleDemand.forEach((c, w) => { const d = dist(c, t); if (d + margin < bd) { best = w; bd = d; } });
    if (best !== turn) changed++;
    source.push(best); distance.push(Math.round(bd * 1000) / 1000);
  });
  return { source, distance, changed };
}

