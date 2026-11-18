import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPack, readPack, PACK_VERSION } from '../src/modules/configPack.ts';

const act = { name: 'Coaching', code: 'COACHING', shortCode: 'CO', category: 'COACHING', countsAsWork: false, paid: true, shrinkage: true, ignoreAdherence: false, color: '#F8DDDD', textColor: null, status: 'ACTIVE' };

describe('configuration pack', () => {
  it('reads back what it wrote', () => {
    const pack = buildPack([act], [{ state: 'TRAINING', reason: '', activityCode: 'COACHING' }], 'Main', new Date('2026-11-18T10:00:00Z'));
    const back = readPack(JSON.parse(JSON.stringify(pack)));
    assert.equal(back.activities[0].code, 'COACHING');
    assert.equal(back.rtaMapping[0].activityCode, 'COACHING');
    assert.equal(back.source?.workspace, 'Main');
  });
  it('refuses a file that is not ours, in plain words', () => {
    assert.throws(() => readPack({ hello: 1 }), /not an AgnoWFM configuration file/);
    assert.throws(() => readPack(null), /not an AgnoWFM configuration file/);
  });
  it('refuses a file from a newer version', () => {
    assert.throws(() => readPack({ format: 'agnowfm-config', version: PACK_VERSION + 1, activities: [] }), /newer version/);
  });
  it('says which activity and field is wrong', () => {
    const bad = buildPack([{ ...act, color: 'red' }], [], 'Main');
    assert.throws(() => readPack(bad), /activities › #1 › color/);
  });
  it('refuses a repeated code and a mapping row that points at nothing', () => {
    assert.throws(() => readPack(buildPack([act, { ...act, name: 'Other' }], [], 'Main')), /twice/);
    assert.throws(() => readPack(buildPack([act], [{ state: 'X', reason: '', activityCode: 'NOPE' }], 'Main')), /not in the file/);
  });
  it('fills a missing short label from the name', () => {
    const p = buildPack([{ ...act, shortCode: '' }], [], 'Main');
    assert.equal(readPack(p).activities[0].shortCode, 'CO');
  });
});
