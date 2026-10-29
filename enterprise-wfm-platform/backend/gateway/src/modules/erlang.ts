/**
 * Erlang C, used to estimate the service level a schedule would deliver. The staffing engine (backend/engine/staffing.py)
 * has the same formulas; this copy lets the gateway judge a finished schedule without a round trip per interval.
 * test/erlang.test.ts checks it against the engine's numbers.
 */

/** Probability that a contact has to wait: n agents, traffic in erlangs (iterative Erlang B, then converted, which stays stable for large n). */
export function waitProbability(n: number, traffic: number): number {
  if (n <= traffic) return 1;
  let b = 1;
  for (let k = 1; k <= n; k++) b = (traffic * b) / (k + traffic * b);
  return b / (1 - (traffic / n) * (1 - b));
}

/** Service level (share answered within answerSec) and average speed of answer for a whole number of agents. */
export function erlangC(n: number, traffic: number, ahtSec: number, answerSec: number): { sl: number; asa: number } {
  if (traffic <= 0) return { sl: 1, asa: 0 };
  if (n <= traffic) return { sl: 0, asa: Infinity };
  const pw = waitProbability(n, traffic);
  return { sl: 1 - pw * Math.exp((-(n - traffic) * answerSec) / ahtSec), asa: (pw * ahtSec) / (n - traffic) };
}

/** The same for a fractional number of agents (for example 41.3 after shrinkage), by interpolating between the two whole numbers. */
export function serviceLevel(agents: number, traffic: number, ahtSec: number, answerSec: number): { sl: number; asa: number } {
  if (traffic <= 0) return { sl: 1, asa: 0 };
  if (agents <= 0) return { sl: 0, asa: Infinity };
  const lo = Math.floor(agents), hi = Math.ceil(agents), f = agents - lo;
  const a = erlangC(lo, traffic, ahtSec, answerSec);
  if (f === 0 || lo === hi) return a;
  const b = erlangC(hi, traffic, ahtSec, answerSec);
  const asa = !Number.isFinite(a.asa) ? b.asa : a.asa + (b.asa - a.asa) * f;
  return { sl: a.sl + (b.sl - a.sl) * f, asa };
}
