import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBase, groupFamilies, horizonLabel, originOf, readColumns, rowActions, shortWhen, updatedAt } from '../../../src/services/forecastLineage.ts';

let n = 0;
const v = (over: any): any => ({ id: `id${++n}`, seq: 1, wfmGroupId: 'g1', name: 'Short-term v1', kind: 'SHORT', status: 'DRAFT', fromDay: '2026-11-04', toDay: '2026-12-15', parentVersionId: null, createdBy: 'Admin', createdAt: '2026-11-01T10:00:00Z', submittedAt: null, approvedAt: null, publishedAt: null, ...over });
const groupName = (id: string) => ({ g1: 'Sales', g2: 'Support', g3: 'Billing' } as Record<string, string>)[id] ?? '?';

describe('grouping versions into forecasts', () => {
  const all = [
    v({ id: 'a1', wfmGroupId: 'g1', seq: 1, status: 'ARCHIVED', createdAt: '2026-10-01T10:00:00Z' }),
    v({ id: 'a2', wfmGroupId: 'g1', seq: 2, status: 'PUBLISHED', publishedAt: '2026-10-05T10:00:00Z', createdAt: '2026-10-02T10:00:00Z' }),
    v({ id: 'a3', wfmGroupId: 'g1', seq: 3, status: 'DRAFT', parentVersionId: 'a2', name: 'Short-term v3 (copy of v2)', createdAt: '2026-11-08T10:00:00Z' }),
    v({ id: 'a4', wfmGroupId: 'g1', seq: 4, status: 'APPROVED', approvedAt: '2026-11-09T10:00:00Z', createdAt: '2026-11-07T10:00:00Z' }),
    v({ id: 'l1', wfmGroupId: 'g1', seq: 1, kind: 'LONG', status: 'PUBLISHED', publishedAt: '2026-09-01T10:00:00Z', createdAt: '2026-09-01T09:00:00Z' }),
    v({ id: 'b1', wfmGroupId: 'g2', seq: 1, status: 'DRAFT', createdAt: '2026-11-11T10:00:00Z' }),
    v({ id: 'c1', wfmGroupId: 'g3', seq: 1, status: 'PUBLISHED', publishedAt: '2026-11-10T10:00:00Z', createdAt: '2026-11-10T09:00:00Z' }),
  ];
  it('is one row per group and type, with its versions: the live one first, then drafts newest first, then archived', () => {
    const f = groupFamilies(all, { groupName });
    const sales = f.find((x) => x.key === 'g1|SHORT')!;
    assert.deepEqual(sales.versions.map((x) => x.id), ['a2', 'a4', 'a3', 'a1']);
    assert.equal(sales.live!.id, 'a2'); assert.equal(sales.headline.id, 'a2');
    assert.equal(sales.total, 4); assert.equal(sales.inProgress, 2);
    assert.equal(f.length, 4, 'Sales short-term, Sales long-term, Support, Billing: one row each');
  });
  it('pins the forecasts that are live to the top, newest change first, then the rest', () => {
    const order = groupFamilies(all, { groupName }).map((x) => x.key);
    assert.deepEqual(order, ['g3|SHORT', 'g1|SHORT', 'g1|LONG', 'g2|SHORT'].filter((k) => order.includes(k)).sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    assert.deepEqual(order.slice(0, 3), ['g3|SHORT', 'g1|SHORT', 'g1|LONG'], 'live ones first (Billing changed last), the draft-only forecast after');
    assert.equal(order.at(-1), 'g2|SHORT');
  });
  it('shows a forecast with no live version by its newest version still in play', () => {
    const f = groupFamilies(all, { groupName }).find((x) => x.key === 'g2|SHORT')!;
    assert.equal(f.live, null); assert.equal(f.headline.id, 'b1');
    const only = groupFamilies([v({ id: 'z1', seq: 1, status: 'ARCHIVED' }), v({ id: 'z2', seq: 2, status: 'ARCHIVED' })], { groupName })[0];
    assert.equal(only.headline.id, 'z2', 'the newest archived one when nothing else is left');
  });
  it('filters versions by status, group and words, and drops forecasts with nothing left', () => {
    const drafts = groupFamilies(all, { groupName, status: 'DRAFT' });
    assert.deepEqual(drafts.map((x) => [x.key, x.versions.map((y) => y.id)]), [['g2|SHORT', ['b1']], ['g1|SHORT', ['a3']]], 'nothing is live in this view, so newest change first');
    assert.equal(drafts[1].total, 4, 'the forecast still says how many versions it has');
    assert.deepEqual(groupFamilies(all, { groupName, groupId: 'g3' }).map((x) => x.key), ['g3|SHORT']);
    assert.deepEqual(groupFamilies(all, { groupName, query: 'support' }).map((x) => x.key), ['g2|SHORT']);
    assert.deepEqual(groupFamilies(all, { groupName, query: 'copy of v2' }).map((x) => x.versions.map((y) => y.id)), [['a3']]);
    assert.deepEqual(groupFamilies(all, { groupName, query: 'long-term' }).map((x) => x.key), ['g1|LONG']);
    assert.equal(groupFamilies(all, { groupName, query: 'zzz' }).length, 0);
  });
  it('says where a version came from, when that version is in the list', () => {
    const byId = new Map(all.map((x) => [x.id, x]));
    assert.equal(originOf(all[2], byId), 'from v2'); assert.equal(originOf(all[0], byId), null);
    assert.equal(originOf({ ...all[2], parentVersionId: 'gone' }, byId), null);
  });
  it('dates a version by its latest step', () => assert.equal(updatedAt(all[3]), '2026-11-09T10:00:00Z'));
});

describe('the horizon on one line', () => {
  const now = new Date('2026-11-12T12:00:00');
  const nb = (s: string) => s.replace(/ /g, ' ');
  it('is dates and a length, without the year when it is this year', () => {
    assert.equal(nb(horizonLabel('2026-11-04', '2026-12-15', now)), '4 Nov – 15 Dec · 6 wk');
    assert.equal(nb(horizonLabel('2026-11-09', '2027-03-14', now)), '9 Nov 2026 – 14 Mar 2027 · 18 wk');
    assert.equal(nb(horizonLabel('2026-11-09', '2026-11-15', now)), '9 Nov – 15 Nov · 1 wk');
  });
  it('uses days for odd lengths and months for long ones', () => {
    assert.equal(nb(horizonLabel('2026-11-09', '2026-11-17', now)), '9 Nov – 17 Nov · 9 d');
    assert.equal(nb(horizonLabel('2026-11-01', '2027-10-31', now)), '1 Nov 2026 – 31 Oct 2027 · 12 mo');
  });
  it('never breaks across lines (the spaces are non-breaking)', () => assert.ok(!/ /.test(horizonLabel('2026-11-04', '2026-12-15', now))));
});

describe('optional columns', () => {
  it('are all hidden until asked for, and a stored choice is read back safely', () => {
    assert.deepEqual(readColumns(null), { channel: false, interval: false, owner: false });
    assert.deepEqual(readColumns('{"owner":true,"channel":"yes"}'), { channel: false, interval: false, owner: true });
    assert.deepEqual(readColumns('not json'), { channel: false, interval: false, owner: false });
  });
});

describe('the row menu', () => {
  const all = (p: string) => p.startsWith('forecast:');
  const none = () => false;
  it('offers what the status allows', () => {
    assert.deepEqual(rowActions('DRAFT', all, { comparable: true }), ['open', 'compare', 'submit', 'export', 'archive', 'delete']);
    assert.deepEqual(rowActions('SUBMITTED', all, { comparable: true }), ['open', 'compare', 'approve', 'return', 'export', 'archive', 'delete']);
    assert.deepEqual(rowActions('APPROVED', all, { comparable: false }), ['open', 'publish', 'return', 'export', 'archive', 'delete']);
    assert.deepEqual(rowActions('PUBLISHED', all, { comparable: true }), ['open', 'compare', 'clone', 'export'], 'the live version cannot be archived or deleted');
    assert.deepEqual(rowActions('ARCHIVED', all, { comparable: true }), ['open', 'compare', 'clone', 'export', 'delete']);
  });
  it('offers only what the person may do', () => {
    assert.deepEqual(rowActions('DRAFT', none, { comparable: true }), ['open', 'compare', 'export']);
    const reviewer = (p: string) => p === 'forecast:approve';
    assert.deepEqual(rowActions('SUBMITTED', reviewer, { comparable: false }), ['open', 'approve', 'return', 'export', 'archive']);
    assert.deepEqual(rowActions('APPROVED', (p) => p === 'forecast:publish', { comparable: false }), ['open', 'publish', 'export']);
  });
});

describe('what a version is compared with first', () => {
  const live = v({ id: 'L', seq: 2, status: 'PUBLISHED' }), draft = v({ id: 'D', seq: 3, status: 'DRAFT', parentVersionId: 'A' }), old = v({ id: 'A', seq: 1, status: 'ARCHIVED' }), other = v({ id: 'O', seq: 4, status: 'DRAFT' });
  it('a version that is not live is compared with the live one', () => assert.equal(defaultBase(draft, [live, draft, old, other])!.id, 'L'));
  it('the live version is compared with what it was cloned from, else the newest one in play', () => {
    assert.equal(defaultBase({ ...live, parentVersionId: 'A' }, [live, draft, old, other])!.id, 'A');
    assert.equal(defaultBase(live, [live, old, other])!.id, 'O');
  });
  it('with no live version, the parent, else any other', () => {
    assert.equal(defaultBase(draft, [draft, old, other])!.id, 'A');
    assert.equal(defaultBase(other, [other, old])!.id, 'A');
    assert.equal(defaultBase(other, [other]), null, 'a forecast with one version has nothing to compare with');
  });
});

describe('a short "updated"', () => {
  const now = new Date(2026, 10, 12, 15, 30);
  it('says today with the time, yesterday, then the date', () => {
    assert.equal(shortWhen(new Date(2026, 10, 12, 9, 8).toISOString(), now), 'Today 09:08');
    assert.equal(shortWhen(new Date(2026, 10, 11, 23, 59).toISOString(), now), 'Yesterday');
    assert.equal(shortWhen(new Date(2026, 9, 5, 10, 0).toISOString(), now), '5 Oct');
    assert.equal(shortWhen(new Date(2025, 11, 30, 10, 0).toISOString(), now), '30 Dec 2025');
    assert.equal(shortWhen('nonsense', now), '–');
  });
});
