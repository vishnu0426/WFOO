/**
 * Employee self-service end to end: agent logins, own schedule, time off with balances and automatic approval, availability,
 * the inbox, and shift swaps / giveaways with manager approval. Builds a group, a published schedule and people first.
 *   BASE_URL=http://localhost:4001 ADMIN_PASSWORD=... TENANT=ACME npm test
 */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const TENANT = process.env.TENANT || 'ACME';
const PASSWORD = process.env.ADMIN_PASSWORD || '';
const RUN = Date.now().toString(36);

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, json, text };
}
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const CURVE = [2, 1, 1, 1, 2, 5, 12, 30, 55, 70, 78, 74, 62, 66, 72, 70, 60, 48, 32, 20, 12, 8, 5, 3];
function historyCsv(queue: string) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const rows = ['queue,date,interval,volume,aht'];
  for (let n = 70; n >= 1; n--) { const d = addDays(today, -n), f = ((d.getDay() + 6) % 7) >= 5 ? 0.45 : 1;
    for (let s = 0; s < 96; s++) rows.push(`${queue},${iso(d)},${String(Math.floor(s / 4)).padStart(2, '0')}:${String((s % 4) * 15).padStart(2, '0')},${Math.round((CURVE[Math.floor(s / 4)] * f * 0.6) / 4)},400`); }
  return rows.join('\n');
}

const ctx: Record<string, any> = {};
let admin = '';
const login = async (username: string, password: string) => { const r = await call(null, 'POST', '/auth/login', { username, password, tenant: TENANT }); assert.equal(r.status, 200, r.text); return r.json.token as string; };
async function agentFor(employeeId: string) {
  if (ctx.agents?.[employeeId]) return ctx.agents[employeeId];
  const c = await call(admin, 'POST', '/self-service/logins', { employeeId });
  assert.equal(c.status, 201, c.text);
  const a = { token: await login(c.json.username, c.json.password), username: c.json.username };
  (ctx.agents ??= {})[employeeId] = a;
  return a;
}
const setPolicy = async (patch: Record<string, unknown>) => { const cur = (await call(admin, 'GET', '/self-service/policy')).json; const r = await call(admin, 'PUT', '/self-service/policy', { ...cur, ...patch }); assert.equal(r.status, 200, r.text); };

describe('self-service', () => {
  before(async () => { assert.ok(PASSWORD, 'set ADMIN_PASSWORD'); admin = await login('admin', PASSWORD); });

  it('prepares a group with a published schedule and thirty people', async () => {
    const g = await call(admin, 'POST', '/config/groups', { name: `Self ${RUN}`, serviceLevelGoal: 80, serviceLevelThresholdSec: 20, shrinkagePercent: 20, targetOccupancy: 85 });
    assert.equal(g.status, 201, g.text); ctx.group = g.json;
    const q = await call(admin, 'POST', '/config/queues', { name: `Self voice ${RUN}`, channel: 'VOICE', wfmGroupId: g.json.id, ahtDefault: 400 });
    const up = await call(admin, 'POST', '/data/imports', { dataType: 'HISTORICAL_VOLUME', fileName: 'h.csv', csv: historyCsv(q.json.name) });
    assert.equal((await call(admin, 'POST', `/data/imports/${up.json.id}/commit`)).json.status, 'COMPLETED');
    const f = await call(admin, 'POST', '/forecast/versions', { groupId: g.json.id, kind: 'SHORT', weeks: 4 });
    for (const s of ['submit', 'approve', 'publish']) assert.equal((await call(admin, 'POST', `/forecast/versions/${f.json.id}/${s}`, {})).status, 200);
    assert.equal((await call(admin, 'POST', '/workforce/teams', { name: `Team ${RUN}` })).status, 201);
    for (const [n, a, b] of [['Early', '06:00', '08:00'], ['Day', '08:30', '10:30'], ['Late', '11:30', '13:30']]) await call(admin, 'POST', '/scheduling/templates', { name: `${n} ${RUN}`, workDays: [0, 1, 2, 3, 4, 5, 6], earliestStart: a, latestStart: b, startStepMinutes: 30, durationHours: 8.5, mealMinutes: 30, breakCount: 2, breakMinutes: 15, flexMinutes: 30 });
    const lines = ['employee_number,first_name,last_name,team,wfm_group,employment_type,weekly_hours,days_per_week'];
    for (let i = 1; i <= 30; i++) lines.push(`S${RUN}-${i},Agent${i},Self${i},Team ${RUN},Self ${RUN},FULL_TIME,40,5`);
    assert.equal((await call(admin, 'POST', '/workforce/employees/import', { csv: lines.join('\n'), dryRun: false })).json.committed, true);
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: g.json.id, from: iso(addDays(new Date(), 4)), weeks: 1, timeLimitSec: 45 });
    assert.equal(v.status, 201, v.text); ctx.version = v.json;
    assert.equal((await call(admin, 'POST', `/scheduling/versions/${v.json.id}/publish`)).status, 200);
    ctx.shifts = (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts`)).json;
    assert.ok(ctx.shifts.length > 30);
    await setPolicy({ swapMinNoticeHours: 0, swapMaxExtraGapSlots: 96, swapAutoApprove: false, timeOffAutoApprove: false });
  });

  it('gives an employee a login that sees only their own things', async () => {
    const mine = ctx.shifts[0];
    ctx.a = { employeeId: mine.employeeId, ...(await agentFor(mine.employeeId)) };
    const home = await call(ctx.a.token, 'GET', '/me/home');
    assert.equal(home.status, 200, home.text);
    assert.ok(home.json.nextShift, 'a next shift on the published schedule');
    // an agent must not be able to read the whole schedule or the staff list
    assert.equal((await call(ctx.a.token, 'GET', '/scheduling/versions')).status, 403);
    assert.equal((await call(ctx.a.token, 'GET', '/workforce/employees')).status, 403);
    assert.equal((await call(ctx.a.token, 'GET', '/audit')).status, 403);
    const sched = await call(ctx.a.token, 'GET', `/me/schedule?from=${iso(new Date())}&to=${iso(addDays(new Date(), 14))}`);
    const shifts = sched.json.days.filter((d: any) => d.shift).map((d: any) => d.shift);
    assert.ok(shifts.length > 0 && shifts.length <= 7);
    assert.ok(shifts.every((s: any) => ctx.shifts.some((x: any) => x.id === s.id && x.employeeId === mine.employeeId)));
    assert.equal((await call(ctx.a.token, 'GET', '/me/profile')).json.group, `Self ${RUN}`);
    assert.equal((await call(admin, 'POST', '/self-service/logins', { employeeId: mine.employeeId })).status, 409);   // one login per person
    assert.equal((await call(null, 'GET', '/me/home')).status, 401);
  });

  it('decides simple time off by the rules and sends the rest to a manager', async () => {
    const far = iso(addDays(new Date(), 40)), farEnd = iso(addDays(new Date(), 41));
    await setPolicy({ timeOffAutoApprove: true, timeOffMinNoticeDays: 7, timeOffMaxOffPercent: 50 });
    const check = await call(ctx.a.token, 'POST', '/me/time-off/check', { type: 'VACATION', startDate: far, endDate: farEnd });
    assert.equal(check.json.willBeApprovedAutomatically, true, check.text);
    const made = await call(ctx.a.token, 'POST', '/me/time-off', { type: 'VACATION', startDate: far, endDate: farEnd, reason: 'Family visit' });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.request.status, 'APPROVED'); assert.equal(made.json.request.autoDecided, true);
    assert.equal((await call(ctx.a.token, 'POST', '/me/time-off', { type: 'VACATION', startDate: far, endDate: farEnd })).status, 400);       // overlaps
    const list = await call(ctx.a.token, 'GET', '/me/time-off');
    assert.equal(list.json.balances.find((b: any) => b.type === 'VACATION').usedDays, 2);
    // too close, so it goes to a manager
    const soon = iso(addDays(new Date(), 2));
    const near = await call(ctx.a.token, 'POST', '/me/time-off', { type: 'PERSONAL', startDate: soon, endDate: soon });
    assert.equal(near.json.request.status, 'REQUESTED'); assert.match(near.json.decision.reasons.join(' '), /notice/);
    // the manager decides, and the person hears about it
    assert.equal((await call(admin, 'POST', `/workforce/time-off/${near.json.request.id}/decide`, { status: 'APPROVED' })).status, 200);
    const inbox = await call(ctx.a.token, 'GET', '/me/notifications');
    assert.ok(inbox.json.items.some((n: any) => n.kind === 'TIME_OFF' && /approved/i.test(n.title)));
    assert.equal((await call(ctx.a.token, 'POST', `/me/time-off/${made.json.request.id}/cancel`)).json.status, 'CANCELLED');
    // sick leave can be recorded for a day already gone; other types cannot
    const past = iso(addDays(new Date(), -1));
    assert.equal((await call(ctx.a.token, 'POST', '/me/time-off', { type: 'SICK', startDate: past, endDate: past })).status, 201);
    assert.equal((await call(ctx.a.token, 'POST', '/me/time-off', { type: 'VACATION', startDate: iso(addDays(new Date(), -5)), endDate: iso(addDays(new Date(), -4)) })).status, 400);
  });

  it('lets people add preferred hours, and hard limits only when the organisation allows it', async () => {
    const okPref = await call(ctx.a.token, 'PUT', '/me/availability', { windows: [{ dayOfWeek: 0, startTime: '08:00', endTime: '16:00', kind: 'PREFERRED' }] });
    assert.equal(okPref.status, 200, okPref.text);
    assert.equal((await call(ctx.a.token, 'PUT', '/me/availability', { windows: [{ dayOfWeek: 1, startTime: '08:00', endTime: '16:00', kind: 'UNAVAILABLE' }] })).status, 400);
    await setPolicy({ agentCanEditAvailability: true });
    assert.equal((await call(ctx.a.token, 'PUT', '/me/availability', { windows: [{ dayOfWeek: 1, startTime: '08:00', endTime: '16:00', kind: 'UNAVAILABLE' }] })).status, 200);
    await call(ctx.a.token, 'PUT', '/me/availability', { windows: [] });
    await setPolicy({ agentCanEditAvailability: false });
  });

  it('swaps two shifts: the colleague accepts, a manager approves, both schedules change', async () => {
    const mine = ctx.shifts.find((s: any) => s.employeeId === ctx.a.employeeId);
    const cands = await call(ctx.a.token, 'GET', `/me/swaps/candidates?shiftId=${mine.id}`);
    assert.equal(cands.status, 200, cands.text);
    assert.ok(cands.json.length > 0, 'at least one colleague can swap');
    const pick = cands.json[0];
    assert.equal(pick.verdict.ok, true);
    const b = { employeeId: pick.employeeId, ...(await agentFor(pick.employeeId)) };
    const made = await call(ctx.a.token, 'POST', '/me/swaps', { kind: 'SWAP', shiftId: mine.id, partnerShiftId: pick.shiftId, note: 'Doctor visit' });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.status, 'PENDING_PARTNER');
    assert.equal((await call(ctx.a.token, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: mine.id })).status, 409);                       // already in a request
    assert.equal((await call(ctx.a.token, 'POST', `/me/swaps/${made.json.id}/accept`)).status, 409);                                          // not the requester's to answer
    const incoming = await call(b.token, 'GET', '/me/swaps');
    assert.equal(incoming.json.incoming.length, 1);
    const accepted = await call(b.token, 'POST', `/me/swaps/${made.json.id}/accept`);
    assert.equal(accepted.status, 200, accepted.text);
    assert.equal(accepted.json.status, 'PENDING_APPROVAL');                                                                                    // auto-approval is off
    const queue = await call(admin, 'GET', '/scheduling/swaps?status=PENDING_APPROVAL');
    assert.ok(queue.json.some((s: any) => s.id === made.json.id));
    assert.equal((await call(admin, 'POST', `/scheduling/swaps/${made.json.id}/decide`, { approve: false, reason: '' })).status, 400);       // a reason is needed to decline
    const done = await call(admin, 'POST', `/scheduling/swaps/${made.json.id}/decide`, { approve: true, reason: 'Fine by me' });
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.status, 'APPROVED');
    const after = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`);
    const has = (emp: string, day: string, start: number) => after.json.some((s: any) => s.employeeId === emp && s.day === day && s.startSlot === start);
    assert.ok(has(ctx.a.employeeId, pick.day, ctx.shifts.find((s: any) => s.id === pick.shiftId).startSlot), 'the requester has the colleague\'s shift');
    assert.ok(has(b.employeeId, mine.day, mine.startSlot), 'the colleague has the requester\'s shift');
    const inbox = await call(b.token, 'GET', '/me/notifications');
    assert.ok(inbox.json.items.some((n: any) => n.kind === 'SWAP'));
    const replay = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/revisions`);
    assert.ok(replay.json.revisions.some((r: any) => /Swap/.test(r.summary)), 'recorded for replay');
    ctx.shifts = after.json;
  });

  it('lets someone give a shift away on the board and a colleague take it, automatically when the rules allow', async () => {
    ctx.shifts = (await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`)).json;
    await setPolicy({ swapAutoApprove: true, swapMaxExtraGapSlots: 96 });
    const giver = ctx.shifts.find((s: any) => s.employeeId === ctx.a.employeeId && s.day > iso(new Date()));
    // pick a colleague with no shift that day
    const busy = new Set(ctx.shifts.filter((s: any) => s.day === giver.day).map((s: any) => s.employeeId));
    const load = new Map<string, number>();
    for (const s of ctx.shifts) load.set(s.employeeId, (load.get(s.employeeId) ?? 0) + 1);
    const takers = [...load.keys()].filter((e) => !busy.has(e) && e !== ctx.a.employeeId).sort((x, y) => load.get(x)! - load.get(y)!);   // people with room in their week first
    const offered = await call(ctx.a.token, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: giver.id, note: 'Cannot make it' });
    assert.equal(offered.status, 201, offered.text); assert.equal(offered.json.status, 'OPEN');
    let t: any = null, taken: any = null;
    for (const cand of takers) {              // a refused attempt (for example too little rest) leaves the shift on the board, so try the next person
      const c = { employeeId: cand, ...(await agentFor(cand)) };
      if (t === null) assert.ok((await call(c.token, 'GET', '/me/swaps')).json.board.some((s: any) => s.id === offered.json.id));
      const r = await call(c.token, 'POST', `/me/swaps/${offered.json.id}/take`);
      if (r.status === 200) { t = c; taken = r; break; }
      assert.equal(r.status, 409, r.text);
      assert.equal((await call(ctx.a.token, 'GET', '/me/swaps')).json.mine.find((x: any) => x.id === offered.json.id).status, 'OPEN');
    }
    assert.ok(t, 'someone can take it');
    assert.equal((await call(ctx.a.token, 'POST', `/me/swaps/${offered.json.id}/take`)).status, 409);                                          // it is taken now
    assert.equal(taken.json.status, 'APPROVED'); assert.equal(taken.json.autoApproved, true);
    const mineAfter = await call(t.token, 'GET', `/me/schedule?from=${giver.day}&to=${giver.day}`);
    assert.equal(mineAfter.json.days[0].shift.startTime, giver.startTime);
  });

  it('will not make a change that breaks a rule, and lets the requester withdraw a request', async () => {
    ctx.shifts = (await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`)).json;
    await setPolicy({ swapAutoApprove: false });
    // someone already working the same day cannot take a shift that day
    const giver = ctx.shifts.find((s: any) => s.employeeId === ctx.a.employeeId && s.day > iso(new Date()));
    const other = ctx.shifts.find((s: any) => s.day === giver.day && s.employeeId !== ctx.a.employeeId);
    const o = { employeeId: other.employeeId, ...(await agentFor(other.employeeId)) };
    const offered = await call(ctx.a.token, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: giver.id });
    const blocked = await call(o.token, 'POST', `/me/swaps/${offered.json.id}/take`);
    assert.equal(blocked.status, 409, blocked.text);
    assert.match(blocked.json.error.message, /two shifts|overlap|already/i);
    // the refused attempt leaves the shift on the board for someone else; the requester can still withdraw it
    assert.equal((await call(ctx.a.token, 'GET', '/me/swaps')).json.mine.find((x: any) => x.id === offered.json.id).status, 'OPEN');
    assert.equal((await call(ctx.a.token, 'POST', `/me/swaps/${offered.json.id}/cancel`)).json.status, 'CANCELLED');
    const again = await call(ctx.a.token, 'POST', '/me/swaps', { kind: 'GIVEAWAY', shiftId: giver.id });
    assert.equal(again.status, 201, again.text);
    assert.equal((await call(ctx.a.token, 'POST', `/me/swaps/${again.json.id}/cancel`)).json.status, 'CANCELLED');
  });

  it('applies the labour-law pack assigned to the group when the scheduler builds a schedule', async () => {
    const india = (await call(admin, 'GET', '/compliance/packs')).json.find((p: any) => p.code === 'IN_OSH_2020');
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'GROUP', scopeId: ctx.group.id, packId: india.id })).status, 200);
    // nobody here has agreed to night work, so no shift may run into the 19:00 to 06:00 window
    const v = await call(admin, 'POST', '/scheduling/versions', { groupId: ctx.group.id, from: iso(addDays(new Date(), 12)), weeks: 1, timeLimitSec: 45 });
    assert.equal(v.status, 201, v.text);
    const shifts = (await call(admin, 'GET', `/scheduling/versions/${v.json.id}/shifts`)).json;
    assert.ok(shifts.length > 0);
    assert.ok(shifts.every((x: any) => x.startSlot + x.lengthSlots <= 19 * 4), 'no shift reaches the night window');
    const val = await call(admin, 'GET', `/scheduling/versions/${v.json.id}/validate`);
    assert.equal(val.json.ok, true, val.text);
    assert.equal(v.json.stats.hours.premium, 0);
    // once a person consents to night work, the late shifts are open to them again
    const emp = shifts[0].employeeId;
    assert.equal((await call(admin, 'PUT', `/workforce/employees/${emp}`, { nightShiftConsent: true })).status, 200);
    assert.equal((await call(admin, 'GET', `/workforce/employees/${emp}`)).json.nightShiftConsent, true);
    assert.equal((await call(admin, 'PUT', '/compliance/assignments', { scopeType: 'GROUP', scopeId: ctx.group.id, packId: null })).status, 200);
  });

  const hh = (slot: number) => `${String(Math.floor(slot / 4)).padStart(2, '0')}:${String((slot % 4) * 15).padStart(2, '0')}`;
  const offer = async (body: Record<string, unknown>) => call(admin, 'POST', '/scheduling/offers', { groupId: ctx.group.id, spots: 1, ...body });
  const detail = async (id: string) => (await call(admin, 'GET', `/scheduling/offers/${id}`)).json;

  it('stores how offers are ordered, and suggests offers from the forecast', async () => {
    const pol = { vtoOrdering: 'SENIORITY', overtimeOrdering: 'FEWEST_HOURS', reverseSeniority: false, waveSize: 0, waveMinutes: 10, offerMinutes: 120 };
    assert.equal((await call(admin, 'PUT', '/self-service/offer-policy', pol)).status, 200);
    assert.equal((await call(admin, 'GET', '/self-service/offer-policy')).json.vtoOrdering, 'SENIORITY');
    assert.equal((await call(admin, 'PUT', '/self-service/offer-policy', { ...pol, vtoOrdering: 'BY_HEIGHT' })).status, 400);
    ctx.shifts = (await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`)).json;
    const day = ctx.shifts[0].day;
    const sug = await call(admin, 'GET', `/scheduling/offers/suggestions?groupId=${ctx.group.id}&day=${day}`);
    assert.equal(sug.status, 200, sug.text);
    assert.ok(Array.isArray(sug.json.vto) && Array.isArray(sug.json.overtime));
    assert.equal((await call(admin, 'GET', `/scheduling/offers/suggestions?groupId=${ctx.group.id}&day=2020-01-01`)).status, 400);        // no schedule that day
  });

  it('offers time off to the people whose shift can give it, in the chosen order, and the first to accept gets it', async () => {
    const base = ctx.shifts.find((x: any) => x.lengthSlots >= 30);
    const end = base.startSlot + base.lengthSlots;
    const made = await offer({ kind: 'VTO', day: base.day, startTime: hh(end - 8), endTime: hh(end), ordering: 'SENIORITY', note: 'Quiet afternoon' });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.status, 'OPEN'); assert.ok(made.json.invited >= 1);
    const d = await detail(made.json.id);
    const order = d.invites.map((i: any) => i.employeeNumber);
    assert.deepEqual(order, [...order].sort(), 'no hire dates are set, so seniority falls back to employee number');
    assert.ok(d.invites.every((i: any) => i.status === 'INVITED'));
    const [first, second] = d.invites;
    const a = await agentFor(first.employeeId);
    const b = second ? await agentFor(second.employeeId) : null;
    assert.equal((await call(a.token, 'GET', '/me/offers')).json.open.some((o: any) => o.id === made.json.id), true);
    assert.equal((await call(a.token, 'GET', '/me/home')).json.offersOpen >= 1, true);
    const taken = await call(a.token, 'POST', `/me/offers/${made.json.id}/accept`);
    assert.equal(taken.status, 200, taken.text);
    assert.equal((await detail(made.json.id)).status, 'FILLED');
    const after = (await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`)).json;
    const now = after.find((x: any) => x.employeeId === first.employeeId && x.day === base.day);
    const was = ctx.shifts.find((x: any) => x.employeeId === first.employeeId && x.day === base.day);
    assert.ok(!now || now.startSlot + now.lengthSlots < was.startSlot + was.lengthSlots, 'their shift is shorter');
    if (b) assert.equal((await call(b.token, 'POST', `/me/offers/${made.json.id}/accept`)).status, 409);                  // no place left
    assert.equal((await call(a.token, 'GET', '/me/offers')).json.recent.some((o: any) => o.id === made.json.id && o.myStatus === 'ACCEPTED'), true);
    const replay = await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/revisions`);
    assert.ok(replay.json.revisions.some((r: any) => /Time off taken/.test(r.summary)));
    ctx.shifts = after;
  });

  it('offers overtime in waves: the next person is asked when the first says no', async () => {
    const base = ctx.shifts.find((x: any) => x.lengthSlots >= 30);
    const end = base.startSlot + base.lengthSlots;
    const made = await offer({ kind: 'OVERTIME', day: base.day, startTime: hh(end), endTime: hh(end + 8), ordering: 'FEWEST_HOURS', waveSize: 1, waveMinutes: 60 });
    assert.equal(made.status, 201, made.text);
    assert.equal(made.json.invited, 1); assert.ok(made.json.queued >= 1, 'the rest wait their turn');
    let d = await detail(made.json.id);
    const first = d.invites.find((i: any) => i.status === 'INVITED');
    assert.equal(first.rank, 1);
    const a = await agentFor(first.employeeId);
    assert.equal((await call(a.token, 'POST', `/me/offers/${made.json.id}/decline`)).status, 200);
    d = await detail(made.json.id);
    assert.equal(d.invites.find((i: any) => i.employeeId === first.employeeId).status, 'DECLINED');
    const next = d.invites.find((i: any) => i.status === 'INVITED');
    assert.ok(next && next.rank === 2, 'the second person is invited as soon as the wave has answered');
    const b = await agentFor(next.employeeId);
    const ok = await call(b.token, 'POST', `/me/offers/${made.json.id}/accept`);
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await detail(made.json.id)).status, 'FILLED');
    const after = (await call(admin, 'GET', `/scheduling/versions/${ctx.version.id}/shifts`)).json;
    const mine = after.find((x: any) => x.employeeId === next.employeeId && x.day === base.day);
    assert.ok(mine, 'they now work that day');
    ctx.shifts = after;
  });

  it('can be cancelled, and refuses a window nobody can take', async () => {
    const base = ctx.shifts.find((x: any) => x.lengthSlots >= 30);
    const made = await offer({ kind: 'OVERTIME', day: base.day, startTime: '19:00', endTime: '21:00', ordering: 'FIRST_COME' });
    if (made.status === 201) {
      assert.equal((await call(admin, 'POST', `/scheduling/offers/${made.json.id}/cancel`)).status, 200);
      assert.equal((await call(admin, 'POST', `/scheduling/offers/${made.json.id}/cancel`)).status, 409);
      assert.equal((await detail(made.json.id)).status, 'CANCELLED');
    }
    const none = await offer({ kind: 'VTO', day: base.day, startTime: '03:00', endTime: '04:00' });
    assert.equal(none.status, 400, none.text);
    assert.match(none.json.error.message, /Nobody can take/);
    assert.equal((await offer({ kind: 'VTO', day: base.day, startTime: '10:00', endTime: '09:00' })).status, 400);
    assert.equal((await offer({ kind: 'VTO', day: iso(new Date()), startTime: '00:00', endTime: '01:00' })).status, 400);              // no published schedule today, or already started
  });

  it('runs a shift bid: patterns, rankings, closing, allocation and a draft schedule from the result', async () => {
    const tpls = (await call(admin, 'GET', '/scheduling/templates')).json.filter((t: any) => t.name.endsWith(RUN));
    const early = tpls.find((t: any) => t.name.startsWith('Early')), day = tpls.find((t: any) => t.name.startsWith('Day')), late = tpls.find((t: any) => t.name.startsWith('Late'));
    const monday = (() => { const d = addDays(new Date(), 14); d.setDate(d.getDate() + ((8 - d.getDay()) % 7)); return iso(d); })();
    const round = { groupId: ctx.group.id, name: `Winter bid ${RUN}`, method: 'SENIORITY', periodStart: monday, weeks: 2, patterns: [
      { name: 'Early, Mon to Fri', templateId: early.id, startTime: '06:00', workDays: [0, 1, 2, 3, 4], capacity: 8 },
      { name: 'Day, Wed to Sun', templateId: day.id, startTime: '08:30', workDays: [2, 3, 4, 5, 6], capacity: 8 },
      { name: 'Late, Tue to Sat', templateId: late.id, startTime: '12:00', workDays: [1, 2, 3, 4, 5], capacity: 8 },
    ] };
    assert.equal((await call(admin, 'POST', '/scheduling/bids', { ...round, periodStart: iso(addDays(new Date(monday), 1)) })).status, 400);      // must start on a Monday
    const made = await call(admin, 'POST', '/scheduling/bids', round);
    assert.equal(made.status, 201, made.text);
    const id = made.json.id, [pE, pD, pL] = made.json.patterns.map((p: any) => p.id);
    assert.equal(made.json.status, 'DRAFT'); assert.equal(made.json.patterns.length, 3); assert.ok(made.json.eligible >= 30);

    const emps = [...new Set(ctx.shifts.map((x: any) => x.employeeId))] as string[];
    const agents = [];
    for (const e of emps.slice(0, 6)) agents.push({ employeeId: e, ...(await agentFor(e)) });
    assert.equal((await call(agents[0].token, 'PUT', `/me/bids/${id}/ranking`, { patternIds: [pD] })).status, 409);                           // not open yet
    assert.equal((await call(admin, 'POST', `/scheduling/bids/${id}/award`, {})).status, 409);                                                 // not closed yet
    assert.equal((await call(admin, 'POST', `/scheduling/bids/${id}/open`)).json.status, 'OPEN');
    assert.ok((await call(agents[0].token, 'GET', '/me/notifications')).json.items.some((n: any) => n.kind === 'BID'));

    const list0 = await call(agents[0].token, 'GET', '/me/bids');
    assert.equal(list0.status, 200, list0.text);
    const mine = list0.json.find((r: any) => r.id === id);
    assert.equal(mine.patterns.length, 3); assert.ok(mine.patterns.every((p: any) => typeof p.fits === 'boolean'));
    assert.equal((await call(agents[0].token, 'PUT', `/me/bids/${id}/ranking`, { patternIds: [pD, pD] })).status, 400);                        // ranked twice
    assert.equal((await call(agents[0].token, 'PUT', `/me/bids/${id}/ranking`, { patternIds: ['00000000-0000-4000-8000-000000000000'] })).status, 400);
    for (const a of agents) assert.equal((await call(a.token, 'PUT', `/me/bids/${id}/ranking`, { patternIds: [pD, pE] })).status, 200);         // everyone wants the day pattern
    assert.deepEqual((await call(agents[0].token, 'GET', '/me/bids')).json.find((r: any) => r.id === id).myRanking, [pD, pE]);
    const open = (await call(admin, 'GET', `/scheduling/bids/${id}`)).json;
    assert.equal(open.submitted, 6); assert.equal(open.patterns.find((p: any) => p.id === pD).firstChoices, 6);

    assert.equal((await call(admin, 'POST', `/scheduling/bids/${id}/close`)).json.status, 'CLOSED');
    assert.equal((await call(agents[0].token, 'PUT', `/me/bids/${id}/ranking`, { patternIds: [pE] })).status, 409);                           // final once closed
    const prev = await call(admin, 'GET', `/scheduling/bids/${id}/preview?method=BALANCED`);
    assert.equal(prev.status, 200, prev.text);
    assert.ok(prev.json.summary.assigned <= 24 && prev.json.summary.assigned >= 6);

    const won = await call(admin, 'POST', `/scheduling/bids/${id}/award`, {});
    assert.equal(won.status, 200, won.text);
    assert.equal(won.json.round.status, 'AWARDED');
    const perPattern = (name: string) => won.json.round.awards.filter((a: any) => a.patternName === name).length;
    assert.ok(perPattern('Day, Wed to Sun') <= 8 && perPattern('Early, Mon to Fri') <= 8 && perPattern('Late, Tue to Sat') <= 8, 'capacity is respected');
    assert.equal(perPattern('Day, Wed to Sun'), 8, 'six people asked for it and two more were given it');
    const built = (await call(admin, 'GET', `/scheduling/versions/${won.json.versionId}/shifts`)).json;
    assert.equal(built.length, won.json.summary.assigned * 5 * 2, 'five days a week for two weeks for everyone who got a pattern');
    const version = (await call(admin, 'GET', `/scheduling/versions/${won.json.versionId}`)).json;
    assert.equal(version.status, 'DRAFT'); assert.ok(version.stats.shifts === built.length);
    const result = (await call(agents[0].token, 'GET', '/me/bids')).json.find((r: any) => r.id === id);
    assert.equal(result.status, 'AWARDED'); assert.equal(result.myAward.patternName, 'Day, Wed to Sun'); assert.equal(result.myAward.rank, 1);
    assert.ok((await call(agents[0].token, 'GET', '/me/notifications')).json.items.some((n: any) => n.kind === 'BID' && /Your shift pattern/.test(n.title)));
    assert.equal((await call(admin, 'POST', `/scheduling/bids/${id}/award`, {})).status, 409);                                                 // already awarded
  });
});
