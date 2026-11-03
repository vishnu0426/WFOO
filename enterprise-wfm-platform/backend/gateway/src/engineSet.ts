/**
 * Which engines exist right now when they come and go (an autoscaled set of engine pods behind a DNS name). Pure, so it can be tested without a network.
 * Addresses only ever get appended to the list the caller keeps, so the position of an engine never changes while calls to it are in flight; an engine that has
 * disappeared is marked gone (nothing new is sent to it) and comes back to life if the same address appears again.
 */
export interface EngineSet { addrs: string[]; gone: boolean[]; fixed: Set<string> }

/** Returns the addresses that were added (the caller makes a client for each, in order) and updates `gone`. Addresses in `fixed` (ENGINE_ADDR) are never marked gone. */
export function reconcile(set: EngineSet, found: string[]): string[] {
  const now = new Set(found);
  const added: string[] = [];
  for (const a of found) {
    const i = set.addrs.indexOf(a);
    if (i < 0) { set.addrs.push(a); set.gone.push(false); added.push(a); } else set.gone[i] = false;
  }
  set.addrs.forEach((a, i) => { if (!now.has(a) && !set.fixed.has(a)) set.gone[i] = true; });
  return added;
}
