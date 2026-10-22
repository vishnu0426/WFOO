/**
 * Shift bidding: who gets which weekly pattern. Pure code, no database.
 * Everyone ranks the patterns they want; the round has a capacity per pattern (how many people may hold it). Three ways to decide:
 *   SENIORITY  - the most senior person picks first (serial: each takes their best remaining choice);
 *   LOTTERY    - the same, in a random but repeatable order;
 *   BALANCED   - the best overall outcome: the assignment that minimises everyone's disappointment together, squaring the rank so one
 *                person getting their last choice counts for more than two people getting their second.
 * A pattern that would break a rule for a person is never given to them, whatever they ranked.
 */
export type Method = 'SENIORITY' | 'LOTTERY' | 'BALANCED';
export const METHODS: Method[] = ['SENIORITY', 'LOTTERY', 'BALANCED'];
export interface Bidder { id: string; employeeNumber: string; hireDate: string | null }
export interface Pattern { id: string; capacity: number }
export interface Award { employeeId: string; patternId: string | null; rank: number | null }     // rank: 1 = their first choice, null = not one they ranked

const mix = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

export function pickOrder(bidders: Bidder[], method: Method, seed: string): Bidder[] {
  const tie = (a: Bidder, b: Bidder) => (a.employeeNumber < b.employeeNumber ? -1 : a.employeeNumber > b.employeeNumber ? 1 : 0);
  return [...bidders].sort((a, b) => {
    if (method === 'LOTTERY') return mix(seed + a.id) - mix(seed + b.id) || tie(a, b);
    const x = a.hireDate ?? '9999-12-31', y = b.hireDate ?? '9999-12-31';
    return (x < y ? -1 : x > y ? 1 : 0) || tie(a, b);
  });
}

/** Minimum-cost assignment (Hungarian algorithm). cost[i][j] for n rows and m >= n columns; returns the column chosen for each row. */
export function hungarian(cost: number[][]): number[] {
  const n = cost.length, m = n ? cost[0].length : 0;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const minv = new Array(m + 1).fill(Infinity), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const ans = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) ans[p[j] - 1] = j - 1;
  return ans;
}

export function allocate(opts: {
  bidders: Bidder[]; patterns: Pattern[]; ranks: Map<string, string[]>; fits: (employeeId: string, patternId: string) => boolean; method: Method; seed: string; fillUnranked?: boolean;
}): Award[] {
  const { bidders, patterns, ranks, fits, method } = opts, fill = opts.fillUnranked ?? true;
  const rankOf = (e: string, p: string) => { const i = (ranks.get(e) ?? []).indexOf(p); return i < 0 ? null : i + 1; };
  if (method !== 'BALANCED') {
    const left = new Map(patterns.map((p) => [p.id, p.capacity]));
    const order = pickOrder(bidders, method, opts.seed);
    const got = new Map<string, string | null>();
    // first everyone's own choices, in pick order, so people who did not rank anything never take a place someone asked for
    for (const b of order) {
      const choice = (ranks.get(b.id) ?? []).find((p) => (left.get(p) ?? 0) > 0 && fits(b.id, p)) ?? null;
      if (choice) left.set(choice, left.get(choice)! - 1);
      got.set(b.id, choice);
    }
    // then whatever is left goes to those who got nothing they asked for
    if (fill) for (const b of order) if (!got.get(b.id)) {
      const choice = patterns.find((p) => (left.get(p.id) ?? 0) > 0 && fits(b.id, p.id))?.id ?? null;
      if (choice) { left.set(choice, left.get(choice)! - 1); got.set(b.id, choice); }
    }
    return order.map((b) => { const pid = got.get(b.id) ?? null; return { employeeId: b.id, patternId: pid, rank: pid ? rankOf(b.id, pid) : null }; });
  }
  // BALANCED: rows are people, columns are the places in each pattern plus one "no pattern" column per person
  const cols: (string | null)[] = [];
  for (const p of patterns) for (let k = 0; k < p.capacity; k++) cols.push(p.id);
  const realCols = cols.length;
  for (let k = 0; k < bidders.length; k++) cols.push(null);
  const BIG = 1e6, UNRANKED = 40 * 40;
  const cost = bidders.map((b) => cols.map((pid) => {
    if (pid === null) return BIG;
    if (!fits(b.id, pid)) return BIG * 10;
    const r = rankOf(b.id, pid);
    return r !== null ? r * r : fill ? UNRANKED : BIG * 5;
  }));
  const pick = hungarian(cost);
  return bidders.map((b, i) => {
    const c = pick[i], pid = c >= 0 && c < realCols && cost[i][c] < BIG ? cols[c] : null;
    return { employeeId: b.id, patternId: pid, rank: pid ? rankOf(b.id, pid) : null };
  });
}

/** How the round went: who got their first choice, second, and so on. */
export function summarise(awards: Award[]) {
  const byRank: Record<string, number> = {};
  let none = 0;
  for (const a of awards) { if (!a.patternId) none++; else { const k = a.rank === null ? 'unranked' : String(a.rank); byRank[k] = (byRank[k] ?? 0) + 1; } }
  const got = awards.filter((a) => a.patternId).length;
  return { people: awards.length, assigned: got, unassigned: none, byRank, firstChoicePercent: awards.length ? Math.round(((byRank['1'] ?? 0) / awards.length) * 100) : 0 };
}
