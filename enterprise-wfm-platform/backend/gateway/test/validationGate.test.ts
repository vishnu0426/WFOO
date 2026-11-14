/**
 * The gate in front of publishing, without an engine or a database: a roster that breaks a rule is refused, and a check that cannot run is not a pass.
 *   npx tsx --test --test-force-exit test/validationGate.test.ts
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Verdict } from '../src/modules/scheduleValidation.ts';

// the module reads its settings when it loads; nothing here connects to a database or an engine
process.env.DATABASE_URL ??= 'postgres://unused:unused@127.0.0.1:1/unused';
process.env.JWT_SECRET ??= 'unit-test-secret-unit-test-secret-00';
const { requireValid } = await import('../src/modules/scheduleValidation.ts');

const live = { ctx: {}, shifts: [], days: ['2026-12-07'], required: [] };
const verdict = (hard: { day: string | null; message: string }[]): Verdict => ({
  valid: hard.length === 0, status: hard.length ? 'INVALID' : 'VALIDATED', coverageStatus: 'ADEQUATE', hardViolations: hard.length, softWarnings: 0, coveragePercent: 100, underHours: 0, fairnessSpreadHours: 0, days: [],
  findings: hard.map((h) => ({ severity: 'HARD' as const, code: 'REST', employeeId: 'e1', employeeName: 'Asha', day: h.day, message: h.message, shiftId: null })),
});

describe('the publish gate', () => {
  afterEach(() => { delete process.env.VALIDATION_FAIL_OPEN; });

  it('lets a roster that obeys every rule through', async () => {
    const v = await requireValid('t', live, undefined, async () => verdict([]));
    assert.equal(v?.valid, true);
  });

  it('refuses a roster that breaks a rule, naming the first reason', async () => {
    await assert.rejects(requireValid('t', live, undefined, async () => verdict([{ day: '2026-12-07', message: 'Asha has 6 hours between shifts and needs 11' }])),
      (e: any) => e.status === 409 && e.code === 'VALIDATION_FAILED' && /6 hours between shifts/.test(e.message));
  });

  it('judges only the days being published when part of a long plan is published', async () => {
    const v = await requireValid('t', live, { from: '2026-12-07', to: '2026-12-13' }, async () => verdict([{ day: '2026-12-20', message: 'later week' }]));
    assert.ok(v);
  });

  it('does not treat a check that could not run as a pass', async () => {
    await assert.rejects(requireValid('t', live, undefined, async () => { throw new Error('engine down'); }), (e: any) => e.status === 503 && e.code === 'VALIDATION_UNAVAILABLE');
  });

  it('lets an operator who accepts the risk publish without the check, only when they say so', async () => {
    process.env.VALIDATION_FAIL_OPEN = 'true';
    assert.equal(await requireValid('t', live, undefined, async () => { throw new Error('engine down'); }), null);
  });
});
