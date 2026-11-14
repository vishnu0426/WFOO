/** The status badge on each provider: every provider has one, and none claims more than the code can back up. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS } from '../src/modules/integrations/presets.ts';
import { pullSupport } from '../src/modules/integrations/pullRules.ts';
import { hasReadiness, readinessOf } from '../src/modules/integrations/readiness.ts';

describe('provider readiness', () => {
  it('every provider has a status, so a new one cannot appear unlabelled', () => {
    const missing = PRESETS.filter((p) => !hasReadiness(p.id)).map((p) => p.id);
    assert.deepEqual(missing, []);
  });
  it('an unknown provider is shown as not ready, never as working', () => {
    assert.equal(readinessOf('SOMETHING_NEW').level, 'NOT_READY');
  });
  it('a provider the server cannot pull and that has no on-site reader or live feed is never marked verified or tested by pulling alone', () => {
    // an API_PULL provider whose scheduled pull is switched off cannot be VERIFIED or TESTED as a pull
    for (const p of PRESETS.filter((x) => x.method === 'API_PULL' && !pullSupport(x, {}).canPull)) {
      assert.ok(['FROM_DOCS', 'NOT_READY'].includes(readinessOf(p.id).level), `${p.id} is ${readinessOf(p.id).level} but cannot be pulled`);
    }
  });
  it('every employee-sync provider is not ready while employee sync is not wired up', () => {
    for (const p of PRESETS.filter((x) => x.category === 'HRMS')) assert.equal(readinessOf(p.id).level, 'NOT_READY', p.id);
  });
  it('the two real pulls and the live cluster are the only verified ones, and say what was run', () => {
    const verified = PRESETS.filter((p) => readinessOf(p.id).level === 'VERIFIED').map((p) => p.id).sort();
    assert.deepEqual(verified, ['AGNOSHIN_NATS_RTA', 'DATABASE_POSTGRES_PULL']);
    for (const id of verified) assert.ok(readinessOf(id).note.length > 20);
  });
  it('Avaya AACC is built from docs, not verified, and says why', () => {
    const i = readinessOf('AVAYA_AACC');
    assert.equal(i.level, 'FROM_DOCS'); assert.match(i.note, /unconfirmed/);
  });
  it('Avaya CMS stays not ready: its reader is a placeholder', () => assert.equal(readinessOf('AVAYA_CMS').level, 'NOT_READY'));
  it('the structured guides name limits as well as steps', () => {
    for (const id of ['AVAYA_AACC', 'AGNOSHIN_NATS_RTA']) {
      const g = PRESETS.find((p) => p.id === id)!.guide!;
      assert.ok(g && g.what && g.needs.length >= 2 && g.limits.length >= 1, id);
    }
  });
});
