/** The gateway's Erlang C must agree with the engine's (backend/engine/staffing.py). Reference values come from erlang_c_metrics(). */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { erlangC, serviceLevel } from '../src/modules/erlang.ts';

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

describe('erlang', () => {
  it('matches the engine for whole numbers of agents', () => {
    for (const [n, a, aht, ans, sl, asa] of [
      [12, 10, 180, 20, 0.6401580403740064, 40.4449401868444],
      [15, 12, 240, 30, 0.7806238429274049, 25.53523400900478],
      [40, 35, 300, 20, 0.774634537541956, 18.871370375503133],
      [70, 60.2, 180, 20, 0.9485138818172597, 2.809538673132612],
      [25, 16.8, 180, 20, 0.9829541145859806, 0.9306122079101767],
    ]) {
      const r = erlangC(n, a, aht, ans);
      near(r.sl, sl); near(r.asa, asa, 1e-7);
    }
  });
  it('fewer agents than the traffic can never answer in time', () => {
    assert.equal(erlangC(10, 10, 180, 20).sl, 0);
    assert.equal(serviceLevel(0, 5, 180, 20).sl, 0);
  });
  it('no traffic is always answered', () => assert.equal(serviceLevel(3, 0, 180, 20).sl, 1));
  it('fractional agents sit between their neighbours and service level never falls as agents are added', () => {
    const lo = serviceLevel(12, 10, 180, 20).sl, mid = serviceLevel(12.5, 10, 180, 20).sl, hi = serviceLevel(13, 10, 180, 20).sl;
    assert.ok(lo < mid && mid < hi);
    let prev = 0;
    for (let n = 11; n <= 30; n += 0.5) { const s = serviceLevel(n, 10, 180, 20).sl; assert.ok(s >= prev - 1e-12); prev = s; }
  });
});
