/**
 * A live connector writes "Event type 'X' is waiting for a rule" into its health row when a message of a kind nobody has ruled on arrives. The row is only wiped by the next message that goes
 * through cleanly, so once someone sets the rule, a quiet feed would keep saying "Needs attention" for ever. This recognises that one error, so it can be cleared the moment no event type is
 * still waiting. Pure, so it is tested alone.
 */
export const WAITING_RULE = /^Event type '.*' is waiting for a rule\b/;

/** The text of the waiting-for-a-rule error that is no longer true: no rule is pending any more. Any other error is returned as it is (it is still the last thing that went wrong). */
export function currentError(lastError: string | null | undefined, pendingRules: number): string | null {
  if (!lastError) return null;
  return WAITING_RULE.test(lastError) && pendingRules === 0 ? null : lastError;
}

/** The SQL condition (on a connector row) that matches that same error, for clearing it when a rule is set. */
export const WAITING_RULE_SQL = "last_error LIKE 'Event type %is waiting for a rule%'";
