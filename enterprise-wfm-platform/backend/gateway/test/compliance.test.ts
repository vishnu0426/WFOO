/**
 * Labour-law rules: each rule type on its own, the ready-made packs, and the API for packs and where they apply.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BUILT_INS, checkPerson, limitsFrom, noticeFinding, normaliseRule, premiumHours, shiftBlocked, touchesNight, type Rule } from '../src/modules/compliance/rules.ts';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const rule = (type: any, params: any, severity: 'BLOCK' | 'WARN' = 'BLOCK'): Rule => normaliseRule({ type, params, severity });
const asha = { id: 'e1', name: 'Asha', nightConsent: false };
const shift = (day: string, start: string, hours: number, mealMin = 30) => { const [h, m] = start.split(':').map(Number); return { day, startSlot: h * 4 + m / 15, lengthSlots: hours * 4, mealSlots: mealMin / 15 }; };

describe('compliance rules', () => {
  it('limits paid hours in a day and spread-over, counting meal time correctly', () => {
    const r = [rule('MAX_DAILY_HOURS', { hours: 8 }), rule('MAX_SPREAD_HOURS', { hours: 10 })];
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '09:00', 8.5)]).length, 0);          // 8.5h shift, 30 min meal = 8.0 paid
    const f = checkPerson(r, asha, [shift('2026-10-05', '09:00', 11)]);
    assert.deepEqual(f.map((x) => x.rule).sort(), ['MAX_DAILY_HOURS', 'MAX_SPREAD_HOURS']);
  });

  it('checks weekly hours per Monday-to-Sunday week', () => {
    const r = [rule('MAX_WEEKLY_HOURS', { hours: 40 })];
    const week = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'].map((d) => shift(d, '09:00', 8.5));   // 6 x 8h = 48h
    assert.equal(checkPerson(r, asha, week).length, 1);
    assert.equal(checkPerson(r, asha, week.slice(0, 5)).length, 0);                                                                          // 40h exactly
  });

  it('needs enough rest between one shift and the next', () => {
    const r = [rule('MIN_DAILY_REST_HOURS', { hours: 11 })];
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '14:00', 9), shift('2026-10-06', '06:00', 9)]).length, 1);   // ends 23:00, next starts 06:00 = 7h
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '08:00', 9), shift('2026-10-06', '08:00', 9)]).length, 0);   // 15h
  });

  it('limits days in a row', () => {
    const r = [rule('MAX_CONSECUTIVE_DAYS', { days: 6 })];
    const days = Array.from({ length: 7 }, (_, i) => shift(`2026-10-${String(5 + i).padStart(2, '0')}`, '09:00', 8));
    assert.equal(checkPerson(r, asha, days).length, 1);
    assert.equal(checkPerson(r, asha, days.slice(0, 6)).length, 0);
  });

  it('wants a meal or rest interval for long shifts', () => {
    const r = [rule('MEAL_BREAK', { afterHours: 5, minutes: 30 })];
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '09:00', 8, 0)]).length, 1);
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '09:00', 8, 30)]).length, 0);
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '09:00', 4, 0)]).length, 0);       // short shift needs none
  });

  it('allows night work only with consent, including shifts that cross midnight', () => {
    const r = [rule('NIGHT_WORK', { from: '19:00', to: '06:00', requiresConsent: true })];
    assert.ok(touchesNight({ startSlot: 22 * 4, lengthSlots: 32 }, '19:00', '06:00'));         // 22:00 to 06:00 next day
    assert.ok(!touchesNight({ startSlot: 8 * 4, lengthSlots: 32 }, '19:00', '06:00'));         // 08:00 to 16:00
    assert.equal(checkPerson(r, asha, [shift('2026-10-05', '22:00', 8)]).length, 1);
    assert.equal(checkPerson(r, { ...asha, nightConsent: true }, [shift('2026-10-05', '22:00', 8)]).length, 0);
  });

  it('WARN rules are reported with their severity, and only BLOCK rules stop the generator', () => {
    const warn = [rule('MAX_DAILY_HOURS', { hours: 6 }, 'WARN')], block = [rule('MAX_DAILY_HOURS', { hours: 6 }, 'BLOCK')];
    assert.equal(checkPerson(warn, asha, [shift('2026-10-05', '09:00', 8.5)])[0].severity, 'WARN');
    assert.equal(shiftBlocked(warn, asha, { startSlot: 36, lengthSlots: 34, mealSlots: 2 }), null);
    assert.match(shiftBlocked(block, asha, { startSlot: 36, lengthSlots: 34, mealSlots: 2 })!, /6 paid hours/);
  });

  it('turns BLOCK rules into limits for the generator, and works out overtime premium hours', () => {
    assert.deepEqual(limitsFrom([rule('MIN_DAILY_REST_HOURS', { hours: 11 }), rule('MAX_WEEKLY_HOURS', { hours: 48 }), rule('MAX_CONSECUTIVE_DAYS', { days: 6 }), rule('MAX_DAILY_HOURS', { hours: 8 }, 'WARN')]),
      { minRestHours: 11, maxWeeklyHours: 48, maxConsecutiveDays: 6 });
    const ot = [rule('OVERTIME_PREMIUM', { afterDailyHours: 8, afterWeeklyHours: 48, multiplier: 2 }, 'WARN')];
    assert.deepEqual(premiumHours(ot, [shift('2026-10-05', '09:00', 11), shift('2026-10-06', '09:00', 8.5)]), { hours: 2.5, multiplier: 2 });   // 10.5 paid on day one
  });

  it('flags a change to a published shift that comes too late', () => {
    const r = [rule('MIN_NOTICE_DAYS', { days: 14 }, 'WARN')];
    assert.ok(noticeFinding(r, asha, '2026-10-05', '2026-10-01'));
    assert.equal(noticeFinding(r, asha, '2026-10-30', '2026-10-01'), null);
  });

  it('fills in and limits rule parameters, and rejects nonsense', () => {
    assert.equal(normaliseRule({ type: 'MAX_WEEKLY_HOURS', params: { hours: 500 } }).params.hours, 168);
    assert.equal(normaliseRule({ type: 'NIGHT_WORK', params: {} }).params.from, '19:00');
    assert.throws(() => normaliseRule({ type: 'NIGHT_WORK', params: { from: 'evening' } }));
    assert.throws(() => normaliseRule({ type: 'MADE_UP' as any }));
  });

  it('ships India, EU and US packs that hold together', () => {
    assert.deepEqual(BUILT_INS.map((b) => b.code), ['IN_OSH_2020', 'EU_WTD', 'US_PREDICTIVE']);
    const india = BUILT_INS[0].rules;
    assert.equal(india.find((r) => r.type === 'MAX_SPREAD_HOURS')!.params.hours, 12);
    assert.equal(india.find((r) => r.type === 'OVERTIME_PREMIUM')!.params.multiplier, 2);
    // a normal 8.5 hour day with a 30 minute meal is clean under the Indian pack
    assert.equal(checkPerson(india, { ...asha, nightConsent: true }, [shift('2026-10-05', '09:00', 8.5)]).length, 0);
  });
});

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json };
}

describe('compliance packs API', { skip: PASSWORD ? false : 'set ADMIN_PASSWORD to run the API tests' }, () => {
  let token = '';
  before(async () => { const r = await call(null, 'POST', '/auth/login', { username: 'admin', password: PASSWORD, tenant: TENANT }); token = r.json.token; });

  it('lists the ready-made packs and the rule catalogue', async () => {
    const packs = await call(token, 'GET', '/compliance/packs');
    assert.equal(packs.status, 200);
    assert.ok(['IN_OSH_2020', 'EU_WTD', 'US_PREDICTIVE'].every((c) => packs.json.some((p: any) => p.code === c && p.builtIn)));
    const cat = await call(token, 'GET', '/compliance/catalog');
    assert.ok(cat.json.some((c: any) => c.type === 'NIGHT_WORK'));
  });

  it('cannot change a ready-made pack, but can copy and edit a custom one', async () => {
    const india = (await call(token, 'GET', '/compliance/packs')).json.find((p: any) => p.code === 'IN_OSH_2020');
    assert.equal((await call(token, 'PUT', `/compliance/packs/${india.id}`, { name: 'Renamed', rules: [] })).status, 409);
    const made = await call(token, 'POST', '/compliance/packs', { name: `Mine ${Date.now().toString(36)}`, region: 'India', rules: india.rules.map((r: any) => (r.type === 'MAX_SPREAD_HOURS' ? { ...r, params: { hours: 10 } } : r)) });
    assert.equal(made.status, 201);
    assert.equal(made.json.rules.find((r: any) => r.type === 'MAX_SPREAD_HOURS').params.hours, 10);
    assert.equal((await call(token, 'POST', '/compliance/packs', { name: 'bad', rules: [{ type: 'NIGHT_WORK', params: { from: 'nope' } }] })).status, 400);
    assert.equal((await call(token, 'DELETE', `/compliance/packs/${made.json.id}`)).status, 200);
  });

  it('assigns a pack to the organisation, and will not delete a pack that is in use', async () => {
    const packs = (await call(token, 'GET', '/compliance/packs')).json;
    const custom = (await call(token, 'POST', '/compliance/packs', { name: `In use ${Date.now().toString(36)}`, rules: [{ type: 'MAX_CONSECUTIVE_DAYS', params: { days: 5 } }] })).json;
    assert.equal((await call(token, 'PUT', '/compliance/assignments', { scopeType: 'TENANT', packId: custom.id })).status, 200);
    const list = (await call(token, 'GET', '/compliance/assignments')).json;
    assert.equal(list.find((a: any) => a.scopeType === 'TENANT').packId, custom.id);
    assert.equal((await call(token, 'DELETE', `/compliance/packs/${custom.id}`)).status, 409);
    assert.equal((await call(token, 'PUT', '/compliance/assignments', { scopeType: 'TENANT', packId: null })).status, 200);
    assert.equal((await call(token, 'DELETE', `/compliance/packs/${custom.id}`)).status, 200);
    assert.ok(packs.length >= 3);
  });

  it('needs sign-in', async () => { assert.equal((await call(null, 'GET', '/compliance/packs')).status, 401); });
});
