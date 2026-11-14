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

export interface PartResult {
  status: string; gap: number; wall_sec: number; variables: number; constraints: number; objective: number; best_bound?: number; backend?: string; attempts?: string[]; windowed?: boolean; score?: number; scored?: boolean; score_terms?: { name: string; value: number }[]; capability_notes?: string[]; advice?: string; verdict?: { checked: boolean; valid: boolean; status: string; coverage_status: string; hard_violations: number; soft_warnings: number; note: string; findings?: { code: string; message: string }[] };
  assignments: { employee: number; [k: string]: unknown }[];
}

/**
 * One answer from the parts of a group solved separately. Its quality is judged for the whole group, not taken from the best or worst part:
 *   - the objective is the parts' objectives added up, and the best possible is the parts' bounds added up, so the gap is how far the whole answer can be from the best the parts
 *     could together reach (not the widest gap of any one part);
 *   - the status is OPTIMAL only for a single solve. People cannot be lent from one part to another, so even when every part is optimal for its own share the whole group is
 *     not proven the best possible: it is FEASIBLE, with `partsOptimal` saying how many parts were proven.
 */
export function combineParts(results: PartResult[], partitions: number[][] | null): PartResult & { partitioned: boolean; partsOptimal: number } {
  if (results.length === 1 || !partitions) return { ...results[0], partitioned: false, partsOptimal: results[0].status === 'OPTIMAL' ? 1 : 0 };
  const objective = results.reduce((n, r) => n + r.objective, 0);
  const bound = Math.min(objective, results.reduce((n, r) => n + (r.best_bound ?? 0), 0));
  const usable = results.every((r) => r.status === 'OPTIMAL' || r.status === 'FEASIBLE');
  return {
    status: results.some((r) => r.status === 'INFEASIBLE') ? 'INFEASIBLE' : usable ? 'FEASIBLE' : 'UNKNOWN',
    gap: objective > 0 ? Math.round((Math.max(0, objective - bound) / Math.max(1, Math.abs(objective))) * 10000) / 10000 : 0,
    wall_sec: Math.max(...results.map((r) => r.wall_sec)), variables: results.reduce((n, r) => n + r.variables, 0), constraints: results.reduce((n, r) => n + r.constraints, 0),
    objective, best_bound: bound, backend: [...new Set(results.map((r) => r.backend).filter(Boolean))].join('+'),
    attempts: results.flatMap((r, k) => (r.attempts ?? []).map((a) => `part ${k + 1}: ${a}`)),
    assignments: results.flatMap((r, k) => r.assignments.map((a) => ({ ...a, employee: partitions[k][a.employee - 1] + 1 }))),
    partitioned: true, partsOptimal: results.filter((r) => r.status === 'OPTIMAL').length, windowed: results.some((r) => r.windowed),
    // the engine's verdict on the whole: valid only if every part was checked and valid
    capability_notes: [...new Set(results.flatMap((r) => r.capability_notes ?? []))],
    advice: [...new Set(results.map((r) => r.advice).filter(Boolean))].join(' '),
    verdict: {
      checked: results.every((r) => r.verdict?.checked), valid: results.every((r) => r.verdict?.checked && r.verdict.valid), status: results.some((r) => r.verdict?.checked && !r.verdict.valid) ? 'INVALID' : results.every((r) => r.verdict?.checked) ? (results.some((r) => r.verdict?.status === 'VALIDATED_WITH_WARNINGS') ? 'VALIDATED_WITH_WARNINGS' : 'VALIDATED') : 'NOT_CHECKED',
      coverage_status: results.some((r) => r.verdict?.coverage_status === 'UNDERSTAFFED') ? 'UNDERSTAFFED' : 'ADEQUATE', hard_violations: results.reduce((n, r) => n + (r.verdict?.hard_violations ?? 0), 0), soft_warnings: results.reduce((n, r) => n + (r.verdict?.soft_warnings ?? 0), 0),
      note: results.filter((r) => !r.verdict?.checked).length ? `${results.filter((r) => !r.verdict?.checked).length} of ${results.length} parts were not checked by the engine` : 'every part checked by the engine', findings: results.flatMap((r) => r.verdict?.findings ?? []).slice(0, 20),
    },
    // the parts' scores add up: each was priced by the same evaluator, so the sum is the whole group's
    score: results.reduce((n, r) => n + (r.score ?? 0), 0), scored: results.every((r) => r.scored),
    score_terms: [...results.flatMap((r) => r.score_terms ?? []).reduce((m, t) => m.set(t.name, (m.get(t.name) ?? 0) + t.value), new Map<string, number>())].map(([name, value]) => ({ name, value })),
  };
}

