/**
 * Capacity and overload behaviour that needs no stack: how connection and parallel-part counts are worked out, and that a full engine means waiting, not failing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { partParallelFor, poolSizeFor } from '../src/autosize.ts';
import { retryWhileBusy, type BusyStats } from '../src/busyWait.ts';
import { reconcile, type EngineSet } from '../src/engineSet.ts';

const stats = (): BusyStats => ({ busy: 0, busyWaitSec: 0, waitedGaveUp: 0 });
const busy = () => Object.assign(new Error('full'), { code: 'ENGINE_BUSY' });

describe('database connections per process', () => {
  it('shares what the database allows between the processes that may run, with room left for other tools', () => {
    assert.equal(poolSizeFor(100, 3, 0, 4), 13, '(100 - 3 - 10) x 0.8 = 69.6 over 5 processes');
    assert.equal(poolSizeFor(500, 3, 0, 4), 50, 'never above 50 for one process');
    assert.equal(poolSizeFor(20, 3, 0, 4), 4, 'never below 4');
    assert.equal(poolSizeFor(100, 3, 60, 4), 5, 'connections others already hold are not given away');
  });
  it('more allowed processes means fewer connections each, so the total stays inside the limit', () => {
    for (const replicas of [1, 4, 10, 20]) {
      const each = poolSizeFor(200, 3, 0, replicas);
      assert.ok(each * (replicas + 1) <= 200 - 3, `${replicas} replicas x ${each} fits`);
    }
  });
});

describe('parts of a build in flight', () => {
  it('follows the number of engines, two solves each plus one waiting, and never fewer than 3', () => {
    assert.equal(partParallelFor(1), 3);
    assert.equal(partParallelFor(2), 5);
    assert.equal(partParallelFor(6), 13);
    assert.equal(partParallelFor(0), 3);
  });
});

describe('a full engine is waited for', () => {
  it('retries until there is room, counting what it waited', async () => {
    const s = stats(); let tries = 0;
    const r = await retryWhileBusy(5000, s, async () => { if (++tries < 4) throw busy(); return 'done'; });
    assert.equal(r, 'done'); assert.equal(tries, 4); assert.equal(s.busy, 3); assert.ok(s.busyWaitSec > 0.1); assert.equal(s.waitedGaveUp, 0);
  });
  it('gives the busy answer after the longest wait it was allowed', async () => {
    const s = stats(); const t0 = Date.now();
    await assert.rejects(retryWhileBusy(700, s, async () => { throw busy(); }), (e: any) => e.code === 'ENGINE_BUSY');
    assert.ok(Date.now() - t0 < 1500, 'it did not wait much longer than allowed');
    assert.equal(s.waitedGaveUp, 1);
  });
  it('does not retry any other failure', async () => {
    const s = stats(); let tries = 0;
    await assert.rejects(retryWhileBusy(5000, s, async () => { tries++; throw Object.assign(new Error('rules cannot be met'), { code: 'INFEASIBLE' }); }), /rules cannot be met/);
    assert.equal(tries, 1); assert.equal(s.busy, 0);
  });
  it('stops waiting when the caller cancels', async () => {
    const s = stats(); const ac = new AbortController(); setTimeout(() => ac.abort(), 300);
    const t0 = Date.now();
    await assert.rejects(retryWhileBusy(60_000, s, async () => { throw busy(); }, ac.signal), (e: any) => e.code === 'ENGINE_BUSY');
    assert.ok(Date.now() - t0 < 3000);
  });
  it('many callers waiting at once all get through once there is room', async () => {
    const s = stats(); let open = false; setTimeout(() => { open = true; }, 600);
    const one = () => retryWhileBusy(10_000, s, async () => { if (!open) throw busy(); return true; });
    const results = await Promise.all(Array.from({ length: 40 }, one));
    assert.equal(results.filter(Boolean).length, 40); assert.equal(s.waitedGaveUp, 0);
  });
});

describe('engines that come and go', () => {
  const fresh = (...fixed: string[]): EngineSet => ({ addrs: [...fixed], gone: fixed.map(() => false), fixed: new Set(fixed) });
  it('adds new engines at the end, so the position of a working one never changes', () => {
    const s = fresh();
    assert.deepEqual(reconcile(s, ['10.0.0.1:50051', '10.0.0.2:50051']), ['10.0.0.1:50051', '10.0.0.2:50051']);
    assert.deepEqual(reconcile(s, ['10.0.0.1:50051', '10.0.0.2:50051', '10.0.0.3:50051']), ['10.0.0.3:50051']);
    assert.deepEqual(s.addrs, ['10.0.0.1:50051', '10.0.0.2:50051', '10.0.0.3:50051']);
  });
  it('marks an engine that disappeared as gone, and brings it back if it returns', () => {
    const s = fresh();
    reconcile(s, ['a:1', 'b:1']);
    assert.deepEqual(reconcile(s, ['a:1']), []);
    assert.deepEqual(s.gone, [false, true]);
    assert.deepEqual(reconcile(s, ['a:1', 'b:1']), [], 'no second client for an address already known');
    assert.deepEqual(s.gone, [false, false]);
  });
  it('never drops an engine that was named in ENGINE_ADDR', () => {
    const s = fresh('static:1');
    reconcile(s, ['a:1']);
    assert.deepEqual(s.gone, [false, false]);
    reconcile(s, ['b:1']);
    assert.deepEqual(s.gone, [false, true, false]);
  });
});
