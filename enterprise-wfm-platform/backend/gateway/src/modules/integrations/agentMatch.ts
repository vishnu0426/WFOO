/**
 * Pure rules for tying the agent id a phone system sends (for example "1001@agnoshin.com") to one of our employees, and for what may be stored
 * as an agent extension. No database, so every case is tested on its own (test/integrations.agentMatch.test.ts).
 */

export interface EmployeeHit { employeeNumber: string; name: string; exact: boolean }
export type AgentMatch = { kind: 'one'; employeeNumber: string; name: string } | { kind: 'many'; names: string[] } | { kind: 'none' };

/** The part before the @ of a SIP-style agent id ("1001@agnoshin.com" gives "1001"); null when the id has no @ to split on. */
export const bareNumber = (id: string): string | null => { const i = id.indexOf('@'); return i > 0 ? id.slice(0, i).trim() || null : null; };

/**
 * `hits` are the employees whose stored extension equals the id as sent (exact) or its bare number. An extension stored exactly as sent wins over
 * one stored as the bare number. Two people sharing the winning kind is never guessed: the caller is told who they are.
 */
export function pickAgent(hits: EmployeeHit[]): AgentMatch {
  const best = hits.some((h) => h.exact) ? hits.filter((h) => h.exact) : hits;
  const byNumber = new Map(best.map((h) => [h.employeeNumber, h]));      // the same person found twice is still one person
  if (byNumber.size === 1) { const h = [...byNumber.values()][0]; return { kind: 'one', employeeNumber: h.employeeNumber, name: h.name }; }
  if (byNumber.size > 1) return { kind: 'many', names: [...byNumber.values()].map((h) => `${h.name} (${h.employeeNumber})`).sort() };
  return { kind: 'none' };
}

/**
 * What is wrong with a value typed as an agent extension, or null when it is fine. An extension is a phone number, and many phone systems name an
 * agent as that number at the company's domain ("1001@agnoshin.com"), which is accepted. Anything else with an @ is a person's email address.
 */
export function extensionProblem(v: string): string | null {
  const t = v.trim();
  if (!t.includes('@')) return null;
  return /^\d+@[A-Za-z0-9.-]+$/.test(t) ? null : 'An agent extension is a phone number such as 1001, or 1001@yourcompany.com. It is not a person\'s email address.';
}
