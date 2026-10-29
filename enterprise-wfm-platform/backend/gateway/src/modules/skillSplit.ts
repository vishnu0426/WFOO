/** The pure part of per-skill requirements: no database, no network, so it can be tested alone. */
const SPD = 96;
export const MAX_SKILLS = 5;

/** Splits `required` between skills in proportion to `work`, slot by slot, by largest remainder so every slot sums exactly. */
export function splitBySkill(required: number[], work: number[][]): number[][] {
  const k = work.length, out = work.map(() => new Array(required.length).fill(0));
  // a slot with no workload of its own (a quiet interval with a requirement from a minimum, say) follows the day's overall shares
  const dayShare = work.map((w) => { const tot = w.reduce((s, v) => s + v, 0); return tot; });
  const grand = dayShare.reduce((s, v) => s + v, 0);
  for (let g = 0; g < required.length; g++) {
    const need = required[g];
    if (need <= 0) continue;
    let weights = work.map((w) => w[g] ?? 0);
    let tot = weights.reduce((s, v) => s + v, 0);
    if (tot <= 0) { weights = grand > 0 ? dayShare : new Array(k).fill(1); tot = weights.reduce((s, v) => s + v, 0); }
    const exact = weights.map((w) => (need * w) / tot), base = exact.map(Math.floor);
    let left = need - base.reduce((s, v) => s + v, 0);
    const order = exact.map((v, i) => ({ i, f: v - Math.floor(v) })).sort((a, b) => b.f - a.f || a.i - b.i);
    for (const { i } of order) { if (left <= 0) break; base[i]++; left--; }
    base.forEach((v, i) => { out[i][g] = v; });
  }
  return out;
}
