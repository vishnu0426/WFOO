/**
 * What to do with one agent-state message from a phone system, as pure rules with no database or network, so every case is tested
 * on its own (test/integrations.agentMessage.test.ts). The subscriber supplies the already field-mapped message and the event-type
 * rule it looked up, and does whatever this says.
 */

export interface EventRule { action: 'PENDING' | 'STATE' | 'SKIP'; state: string | null; reason: string | null }

export type Decision =
  | { kind: 'ingest'; employeeNumber: string; state: string; reason?: string; at?: string }
  | { kind: 'skip' }                                       // known and deliberately ignored (a heartbeat, say): counts as the feed being alive
  | { kind: 'pending'; eventType: string }                 // a new event type nobody has ruled on yet
  | { kind: 'unmapped'; missing: 'employeeNumber' | 'state' };

/**
 * A time as the phone system may send it: an ISO string, epoch seconds or epoch milliseconds (as a number or as text). Anything that
 * is not a real time is dropped, so the event is stamped with its arrival time instead of breaking the whole batch.
 */
export function parseEventTime(v: unknown, now = Date.now()): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  let ms: number;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d{9,13}(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    ms = n < 1e11 ? n * 1000 : n;                           // seconds have 10 digits until the year 5138, milliseconds have 13
  } else if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) ms = Date.parse(v.trim());     // JavaScript reads '12' as a date in 2001, so only ISO-looking text is parsed
  else return undefined;
  if (!Number.isFinite(ms) || ms < Date.UTC(2000, 0, 1) || ms > now + 5 * 60_000 + 24 * 3_600_000) return undefined;
  return new Date(ms).toISOString();
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * `m` is the message after field mapping. A message that carries its own state goes straight through, whatever its event type, unless an
 * administrator marked that type SKIP. One without a state (a login, a logout) takes the state and reason from its event type's rule.
 */
export function decideAgentMessage(m: Record<string, unknown>, rule: EventRule | null): Decision {
  const eventType = text(m.eventType);
  let state = text(m.state);
  let reason = text(m.reason);
  if (eventType && rule) {
    if (rule.action === 'SKIP') return { kind: 'skip' };
    if (!state) {
      if (rule.action === 'PENDING') return { kind: 'pending', eventType };
      if (rule.state) state = rule.state;
      if (rule.reason !== null && rule.reason !== undefined) reason = rule.reason;
    }
  }
  const employeeNumber = text(m.employeeNumber);
  if (!employeeNumber) return { kind: 'unmapped', missing: 'employeeNumber' };
  if (!state) return { kind: 'unmapped', missing: 'state' };
  const out: Decision = { kind: 'ingest', employeeNumber, state };
  if (reason) out.reason = reason;
  const at = parseEventTime(m.at);
  if (at) out.at = at;
  return out;
}
