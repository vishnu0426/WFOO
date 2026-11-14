/**
 * A live feed can send thousands of messages an hour with the same outcome ("fine", or the same error). Writing each one to the connector's
 * health row costs a database write per message and tells nobody anything new. This decides which outcomes are worth writing. Pure, so tested alone.
 */
const health = new Map<string, { broken: boolean; okAt: number; error: string; errorAt: number }>();
const OK_WRITE_EVERY_MS = 5_000, SAME_ERROR_EVERY_MS = 30_000;

/** True when this outcome adds something to what the health row already says. A change from working to broken (or back) is never skipped. */
export function worthRecording(connectorId: string, ok: boolean, message: string | undefined, now = Date.now()): boolean {
  const h = health.get(connectorId) ?? { broken: true, okAt: 0, error: '', errorAt: 0 };   // unknown at start: the first outcome always writes
  let write: boolean;
  if (ok) { write = h.broken || now - h.okAt >= OK_WRITE_EVERY_MS; if (write) { h.okAt = now; h.broken = false; h.error = ''; } }
  else { write = !h.broken || h.error !== (message ?? '') || now - h.errorAt >= SAME_ERROR_EVERY_MS; if (write) { h.errorAt = now; h.broken = true; h.error = message ?? ''; } }
  health.set(connectorId, h);
  return write;
}

export const forgetConnector = (connectorId: string) => { health.delete(connectorId); };
export const forgetAllConnectors = () => { health.clear(); };
