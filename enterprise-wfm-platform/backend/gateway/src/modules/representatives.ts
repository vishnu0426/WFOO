/**
 * Scheduling a very large group (tens of thousands of people) by solving for a representative sample and repeating its rosters.
 *
 * One solve cannot weigh every named person against every shift: the number of choices grows with people x days x start times, and past a few thousand people the
 * solver finds nothing better than the plain starting roster. Commercial workforce tools do not solve each named person in one model either; they decide the shape of
 * the roster (how many people on which shift, which days off) and then give named people to it. This does the same in two steps:
 *   1. people with the same contract rules (hours, days a week, rest, days in a row, skills, ...) are interchangeable, so a sample of them, in proportion to each kind,
 *      is solved with the demand scaled down to the sample's share. That is an ordinary solve, the size the solver is good at;
 *   2. every other person takes the roster of a sample member of their own kind, dropping any shift their own time off or availability rules out.
 * Nothing here knows about the solver; it only chooses who stands in for whom.
 */
export interface Representatives {
  /** indexes (into the people given) of those who are solved */
  reps: number[];
  /** for every person, the position in `reps` of the one whose roster they take (a representative takes their own) */
  repOf: number[];
}

/** `signatureOf(i)` is equal for people who can be given each other's roster. Each kind gets a share of the `target` sample in proportion to its size, and at least one. */
export function pickRepresentatives(count: number, signatureOf: (i: number) => string, target: number): Representatives {
  const kinds = new Map<string, number[]>();
  for (let i = 0; i < count; i++) { const k = signatureOf(i); const l = kinds.get(k); if (l) l.push(i); else kinds.set(k, [i]); }
  const reps: number[] = [], repOf = new Array<number>(count).fill(-1);
  const keys = [...kinds.keys()].sort();
  // a share in proportion to size, at least one each; the remainder after rounding goes to the largest kinds
  const goal = Math.max(target, keys.length);
  const share = new Map<string, number>(); let given = 0;
  for (const k of keys) { const n = Math.max(1, Math.min(kinds.get(k)!.length, Math.floor((goal * kinds.get(k)!.length) / count))); share.set(k, n); given += n; }
  for (const k of [...keys].sort((a, b) => kinds.get(b)!.length - kinds.get(a)!.length)) {
    if (given >= goal) break;
    const room = kinds.get(k)!.length - share.get(k)!;
    const add = Math.min(room, goal - given); share.set(k, share.get(k)! + add); given += add;
  }
  for (const k of keys) {
    const members = kinds.get(k)!, n = share.get(k)!, first = reps.length;
    // evenly spaced through the kind, so the sample has the mix of teams and sites the kind has
    for (let j = 0; j < n; j++) reps.push(members[Math.floor(((j + 0.5) * members.length) / n)]);
    const own = new Map(reps.slice(first).map((m, j) => [m, first + j]));
    let turn = 0;                                                            // the others are dealt out one at a time, so every representative has the same number of followers (give or take one)
    for (const m of members) repOf[m] = own.get(m) ?? first + (turn++ % n);
  }
  return { reps, repOf };
}
