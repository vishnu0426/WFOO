/**
 * When every engine says it is full, wait for room instead of failing the request: a rush of builds should queue, not error. Waits grow from 0.2 s to 2 s with
 * some randomness (so waiting callers do not all knock at once) until `maxWaitMs`; after that the original "engine busy" answer is given.
 */
export interface BusyStats { busy: number; busyWaitSec: number; waitedGaveUp: number }
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function retryWhileBusy<T>(maxWaitMs: number, stats: BusyStats, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const t0 = Date.now();
  let delay = 200;
  for (;;) {
    try { return await fn(); } catch (e: any) {
      if (e?.code !== 'ENGINE_BUSY') throw e;
      stats.busy++;
      const wait = Math.round(delay * (0.5 + Math.random()));
      if (signal?.aborted || Date.now() - t0 + wait > maxWaitMs) { stats.waitedGaveUp++; throw e; }
      await sleep(wait);
      stats.busyWaitSec += wait / 1000;
      delay = Math.min(2000, Math.round(delay * 1.6));
    }
  }
}
