import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultZone, localTime, offsetLabel, offsetMinutes, splitZone, zoneChoices, zoneNote } from '../../../src/services/timeZones.ts';

const winter = new Date('2026-11-18T18:45:00Z');

describe('time zones', () => {
  it('knows the offset from UTC, with daylight saving', () => {
    assert.equal(offsetMinutes('Africa/Nairobi', winter), 180);
    assert.equal(offsetMinutes('Asia/Kolkata', winter), 330);
    assert.equal(offsetMinutes('UTC', winter), 0);
    assert.equal(offsetMinutes('America/New_York', winter), -300);
    assert.equal(offsetMinutes('America/New_York', new Date('2026-07-01T12:00:00Z')), -240);
    assert.equal(offsetMinutes('Not/AZone', winter), 0);
  });
  it('writes offsets and names the way people say them', () => {
    assert.equal(offsetLabel(180), 'UTC+3'); assert.equal(offsetLabel(330), 'UTC+5:30'); assert.equal(offsetLabel(-300), 'UTC-5'); assert.equal(offsetLabel(0), 'UTC');
    assert.deepEqual(splitZone('Africa/Nairobi'), { city: 'Nairobi', region: 'Africa' });
    assert.deepEqual(splitZone('America/Argentina/Buenos_Aires'), { city: 'Buenos Aires', region: 'America' });
    assert.deepEqual(splitZone('UTC'), { city: 'UTC', region: 'Other' });
  });
  it('lists zones by region then offset, labelled with the city and offset', () => {
    const c = zoneChoices(['Africa/Nairobi', 'Africa/Lagos', 'Africa/Cairo', 'Asia/Kolkata', 'UTC', 'Africa/Nairobi'], winter);
    assert.deepEqual(c.map((z) => z.label), ['Lagos (UTC+1)', 'Cairo (UTC+2)', 'Nairobi (UTC+3)', 'Kolkata (UTC+5:30)', 'UTC']);
    assert.equal(c.length, 5, 'a repeated zone is listed once');
  });
  it('shows the local time there', () => {
    assert.equal(localTime('Africa/Nairobi', winter), '21:45');
    assert.equal(localTime('Asia/Kolkata', winter), '00:15');
    assert.equal(localTime('Nope/Nope', winter), '');
  });
  it('starts a new group on its site\'s zone, else the organisation\'s, else UTC', () => {
    assert.equal(defaultZone('Africa/Nairobi', 'UTC'), 'Africa/Nairobi');
    assert.equal(defaultZone(null, 'Asia/Kolkata'), 'Asia/Kolkata');
    assert.equal(defaultZone(undefined, undefined), 'UTC');
  });
  it('cautions about UTC when the site or the organisation is elsewhere, and about a site mismatch', () => {
    const a = zoneNote({ zone: 'UTC', siteZone: 'Africa/Nairobi', siteName: 'KCB HQ' });
    assert.equal(a.kind, 'check'); assert.equal(a.suggest, 'Africa/Nairobi'); assert.match(a.text, /runs on UTC but its site KCB HQ is on Africa\/Nairobi/);
    assert.match(zoneNote({ zone: 'UTC', orgZone: 'Asia/Kolkata' }).text, /the organisation is on Asia\/Kolkata/);
    assert.equal(zoneNote({ zone: 'UTC', orgZone: 'UTC' }).kind, 'ok', 'everything on UTC is fine');
    assert.equal(zoneNote({ zone: 'Africa/Nairobi', siteZone: 'Africa/Nairobi' }).kind, 'ok');
    assert.equal(zoneNote({ zone: 'Africa/Nairobi', siteZone: 'Africa/Lagos' }).suggest, 'Africa/Lagos');
    assert.equal(zoneNote({ zone: 'Africa/Nairobi', orgZone: 'UTC' }).kind, 'ok', 'a group may differ from the organisation when it has its own place');
  });
});

import { ZONES, ZONE_ALIASES } from '../../../src/services/zoneTable.ts';
import { canonicalZone, countryName, intlName, zoneList } from '../../../src/services/timeZones.ts';
import { filterGroups, flatten } from '../../../src/services/comboFilter.ts';

describe('the full zone list', () => {
  it('has every IANA zone once, each with a country', () => {
    const ids = ZONES.map((z) => z[0]);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 400, `${ids.length} zones`);
    assert.ok(ZONES.every((z) => /^[A-Z]{2}$/.test(z[1])));
    assert.ok(ids.includes('Asia/Kolkata') && ids.includes('Europe/Kyiv') && ids.includes('Asia/Ho_Chi_Minh') && ids.includes('Africa/Nairobi'));
  });
  it('knows every zone it lists (or an old name for it), so no zone shows a wrong offset', () => {
    for (const [id] of ZONES) { const n = intlName(id); assert.doesNotThrow(() => new Intl.DateTimeFormat('en', { timeZone: n }), id); }
  });
  it('turns old names into current ones and leaves current ones alone', () => {
    assert.equal(canonicalZone('Asia/Calcutta'), 'Asia/Kolkata'); assert.equal(canonicalZone('Europe/Kiev'), 'Europe/Kyiv'); assert.equal(canonicalZone('Asia/Saigon'), 'Asia/Ho_Chi_Minh');
    assert.equal(canonicalZone('Africa/Nairobi'), 'Africa/Nairobi'); assert.equal(canonicalZone('Mars/Base'), 'Mars/Base');
    assert.ok(Object.values(ZONE_ALIASES).every((v) => ZONES.some((z) => z[0] === v)), 'every old name points at a listed zone');
  });
  it('labels a zone with its city, country and offset', () => {
    const list = zoneList(winter), by = (id: string) => list.find((z) => z.id === id)!;
    assert.equal(by('Africa/Nairobi').label, 'Nairobi, Kenya (UTC+3)');
    assert.equal(by('Asia/Kolkata').label, 'Kolkata, India (UTC+5:30)');
    assert.equal(by('America/New_York').label, 'New York, United States (UTC-5)');
    assert.equal(by('Africa/Nairobi').time, '21:45');
    assert.equal(list[0].id, 'UTC');
    assert.equal(countryName('KE'), 'Kenya');
  });
  it('can be searched by country as well as by city', () => {
    const items = zoneList(winter).map((z) => ({ value: z.id, label: z.label, right: z.time, keywords: `${z.id} ${z.region} ${z.city} ${z.countryName} ${z.country}` }));
    const find = (q: string) => flatten(filterGroups([{ label: 'all', items }], q)).map((i) => i.value);
    assert.ok(find('kenya').includes('Africa/Nairobi'));
    assert.ok(find('india').includes('Asia/Kolkata'));
    assert.ok(find('united states').length >= 10, 'a country with many zones lists them together');
    assert.ok(find('brazil').includes('America/Sao_Paulo'));
    assert.deepEqual(find('nairobi'), ['Africa/Nairobi']);
  });
  it('treats an old name for the same zone as no mismatch', () => {
    assert.equal(zoneNote({ zone: 'Asia/Calcutta', siteZone: 'Asia/Kolkata' }).kind, 'ok');
  });
});
