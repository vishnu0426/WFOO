/**
 * Splitting a very large group into independent parts that can be solved side by side.
 *
 * One solve has a practical limit (the number of candidate shifts it has to weigh). A group of several thousand people goes past it, so its people are split into
 * parts, each part is given its fair share of the demand in every quarter-hour, and the parts are solved in parallel on the engines. The share is exact: the parts'
 * requirements add up to the whole requirement in every quarter-hour. What is given up is pooling across parts (a part cannot lend someone to another), which is why
 * the split is by team where it can be, and why the parts are kept as few and as large as the solver can take.
 */

/** Split `total` between parts in proportion to `weights`, in whole numbers that add up to `total`. Remainders go to the parts with the largest fraction; ties rotate with `salt`. */
export function splitCounts(total: number, weights: number[], salt = 0): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum), base = exact.map(Math.floor);
  let left = total - base.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => ({ i, frac: e - base[i], tie: (i + salt) % weights.length })).sort((a, b) => b.frac - a.frac || a.tie - b.tie);
  for (const o of order) { if (left <= 0) break; base[o.i]++; left--; }
  return base;
}

/** The requirement for each part: for every slot, the people needed are shared out by part size. */
export function splitRequirement(required: number[], sizes: number[]): number[][] {
  const out = sizes.map(() => new Array<number>(required.length).fill(0));
  for (let g = 0; g < required.length; g++) {
    if (!required[g]) continue;
    const c = splitCounts(required[g], sizes, g);
    for (let k = 0; k < sizes.length; k++) out[k][g] = c[k];
  }
  return out;
}

/** Group people into `k` parts of near-equal size, keeping each team together where possible (people are taken team by team, then cut). Returns indexes into the input. */
export function partitionIndexes(teamOf: string[], k: number): number[][] {
  const order = teamOf.map((t, i) => ({ t, i })).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i)).map((x) => x.i);
  const sizes = splitCounts(order.length, new Array(k).fill(1));
  const parts: number[][] = [];
  let at = 0;
  for (const n of sizes) { parts.push(order.slice(at, at + n).sort((a, b) => a - b)); at += n; }
  return parts.filter((p) => p.length);
}

/**
 * Parts that each look like the whole group: the people of every kind (here, every combination of skills) are dealt out one by one across the k parts, so each part gets its
 * fair share of each kind. A group whose queues need different skills is split this way: parts cut by team or by position can end up with only one kind of person, and a part
 * of Spanish speakers given an even share of English demand cannot cover it, while the part with the English speakers has too little help.
 */
export function stratifiedIndexes(kindOf: string[], k: number): number[][] {
  const parts: number[][] = Array.from({ length: k }, () => []);
  const byKind = new Map<string, number[]>();
  kindOf.forEach((kind, i) => { const l = byKind.get(kind); if (l) l.push(i); else byKind.set(kind, [i]); });
  let turn = 0;
  for (const kind of [...byKind.keys()].sort()) for (const i of byKind.get(kind)!) { parts[turn % k].push(i); turn++; }
  return parts.filter((p) => p.length).map((p) => p.sort((a, b) => a - b));
}
