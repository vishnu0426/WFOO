/**
 * Following one request through the system. Each request (and each background build) carries a request id and a W3C trace context (`traceparent`): the gateway accepts one from the
 * caller or makes one, sends it to the engine with every call, and writes both into its logs, so a slow or failed schedule can be followed from the browser's response header
 * through the gateway's log to the solver's. LOG_FORMAT=json turns every log line into one JSON object (what a log collector wants); the default stays readable text.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import util from 'node:util';

export interface TraceContext { requestId: string; traceparent: string }
const store = new AsyncLocalStorage<TraceContext>();

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const hex = (bytes: number) => randomBytes(bytes).toString('hex');

/** A trace context for a new unit of work: continues the caller's trace (new span, same trace id) when `incoming` is a valid traceparent, else starts a trace. */
export function newTrace(requestId: string, incoming?: string | null): TraceContext {
  const m = incoming ? TRACEPARENT.exec(incoming.trim().toLowerCase()) : null;
  const traceId = m && m[1] !== '0'.repeat(32) ? m[1] : hex(16);
  return { requestId, traceparent: `00-${traceId}-${hex(8)}-${m ? m[3] : '01'}` };
}

export const runWithTrace = <T>(ctx: TraceContext, fn: () => T): T => store.run(ctx, fn);
export const currentTrace = (): TraceContext | undefined => store.getStore();
export const traceIdOf = (ctx?: TraceContext) => (ctx ? ctx.traceparent.split('-')[1] : undefined);

/** What goes to the engine with each call. */
export function engineHeaders(): Record<string, string> {
  const c = currentTrace();
  return c ? { 'x-request-id': c.requestId, traceparent: c.traceparent } : {};
}

/** LOG_FORMAT=json: every console line becomes one JSON object with the time, level, message and the request and trace ids of the work that wrote it. */
export function installLogging(): void {
  if ((process.env.LOG_FORMAT || '').toLowerCase() !== 'json') return;
  for (const [method, level] of [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']] as const) {
    (console as any)[method] = (...args: unknown[]) => {
      const c = currentTrace();
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: util.format(...args), requestId: c?.requestId, traceId: traceIdOf(c) });
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
    };
  }
}
