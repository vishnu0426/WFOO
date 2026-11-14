// Run: node --test test.mjs   (no database or network needed: the database and the gateway are faked)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { addDays, buildQuery, findGaps, ident, prepareRows } from './lib.mjs';
import { runBackfill, runLive } from './reader.mjs';

const row = (o) => ({ day: '2026-11-02', time: '09:00', queue: 'Support', offered: 100, answered: 90, abandoned: 10, handleSeconds: 27000, ...o });
const quiet = () => {};

describe('buildQuery', () => {
  it('reads the documented table with text day and time and only date parameters', () => {
    const q = buildQuery();
    assert.match(q, /FROM \[iSkillsetStat\]/);
    assert.match(q, /CONVERT\(char\(10\), \[Timestamp\], 23\) AS \[day\]/);
    assert.match(q, /CONVERT\(char\(5\), \[Timestamp\], 108\) AS \[time\]/);
    assert.match(q, /CAST\(@from AS date\)/);
    assert.match(q, /^SELECT /);
  });
  it('uses the columns the customer names', () => {
    const q = buildQuery({ columns: { timestamp: 'IntervalStart', skillset: 'Name', offered: 'Offered', answered: '', abandoned: 'Abn', handleSeconds: '' } });
    assert.match(q, /\[IntervalStart\]/); assert.match(q, /\[Name\] AS \[queue\]/); assert.doesNotMatch(q, /answered/);
  });
  it('takes an average-handle-time column in place of total handle time', () => {
    const q = buildQuery({ columns: { aht: 'AvgTalk' } });
    assert.match(q, /\[AvgTalk\] AS \[aht\]/); assert.doesNotMatch(q, /handleSeconds/);
  });
  it('refuses a table or column that is not a plain name', () => {
    assert.throws(() => buildQuery({ table: 'iSkillsetStat; DROP TABLE x' }), /not a plain name/);
    assert.throws(() => buildQuery({ columns: { offered: 'a] FROM b --' } }), /not a plain name/);
    assert.throws(() => ident('', 'Table'), /not a plain name/);
  });
});

describe('prepareRows', () => {
  it('turns a row into ours, with AHT as handle seconds per answered call', () => {
    const { rows, rejected, flags } = prepareRows([row()]);
    assert.deepEqual(rows, [{ queue: 'Support', day: '2026-11-02', time: '09:00', volume: 100, abandoned: 10, ahtSec: 300 }]);
    assert.equal(rejected.length + flags.length, 0);
  });
  it('uses an average-handle-time column as it is', () => {
    const { rows } = prepareRows([{ day: '2026-11-02', time: '09:00', queue: 'S', offered: 50, answered: 40, aht: 240 }]);
    assert.equal(rows[0].ahtSec, 240);
  });
  it('gives no AHT when nothing was answered, instead of dividing by zero', () => {
    const { rows } = prepareRows([row({ answered: 0, handleSeconds: 0 })]);
    assert.equal(rows[0].ahtSec, undefined);
  });
  it('rejects rows it cannot use and says why', () => {
    const { rows, rejected } = prepareRows([row({ queue: '' }), row({ day: '02/11/2026' }), row({ offered: -1 }), row({ offered: null }), row({ time: '9:00' })]);
    assert.equal(rows.length, 0);
    assert.equal(rejected.length, 5);
    assert.match(rejected[0].reason, /skillset/); assert.match(rejected[1].reason, /day\/time/); assert.match(rejected[2].reason, /offered/);
  });
  it('caps abandoned at offered and flags it', () => {
    const { rows, flags } = prepareRows([row({ offered: 10, abandoned: 25 })]);
    assert.equal(rows[0].abandoned, 10);
    assert.match(flags[0].issue, /more than offered/);
  });
  it('adds duplicate skillset-interval rows together and says so', () => {
    const { rows, flags } = prepareRows([row({ offered: 60, answered: 60, handleSeconds: 6000, abandoned: 0 }), row({ offered: 40, answered: 20, handleSeconds: 4000, abandoned: 5 })]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].volume, 100); assert.equal(rows[0].abandoned, 5); assert.equal(rows[0].ahtSec, 125);
    assert.equal(flags.length, 1); assert.match(flags[0].issue, /added together/);
  });
  it('keeps skillsets and days separate', () => {
    const { rows } = prepareRows([row(), row({ queue: 'Billing' }), row({ day: '2026-11-03' })]);
    assert.equal(rows.length, 3);
  });
  it('drops an unusable abandoned count but keeps the volume', () => {
    const { rows, flags } = prepareRows([row({ abandoned: 'n/a' })]);
    assert.equal(rows[0].volume, 100); assert.equal(rows[0].abandoned, undefined);
    assert.match(flags[0].issue, /abandoned count not usable/);
  });
});

describe('findGaps', () => {
  it('reports intervals missing in the middle of a day, such as an outage', () => {
    const rows = ['09:00', '09:30', '11:00', '11:30'].map((time) => ({ queue: 'Support', day: '2026-11-02', time, volume: 1 }));
    assert.deepEqual(findGaps(rows), [{ queue: 'Support', day: '2026-11-02', after: '09:30', before: '11:00', missingIntervals: 2 }]);
  });
  it('reports nothing for a complete day, or for edges (opening and closing)', () => {
    assert.deepEqual(findGaps(['08:00', '08:15', '08:30'].map((time) => ({ queue: 'Q', day: '2026-11-02', time, volume: 1 }))), []);
  });
});

describe('addDays', () => {
  it('counts whole days across month ends and daylight-saving changes', () => {
    assert.equal(addDays('2026-11-01', -2), '2026-10-30');
    assert.equal(addDays('2026-03-08', 1), '2026-03-09');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  });
});

describe('runLive', () => {
  it('reads the last two days and sends the cleaned rows to /live', async () => {
    const calls = [], sent = [];
    const db = { query: async (sql, p) => { calls.push(p); return [row(), row({ queue: '' })]; } };
    const post = async (path, body) => { sent.push({ path, body }); return { accepted: body.rows.length }; };
    const out = await runLive({ db, post, today: '2026-11-03', log: quiet });
    assert.deepEqual(calls, [{ from: '2026-11-01', to: '2026-11-03' }]);
    assert.equal(sent.length, 1); assert.equal(sent[0].path, '/live'); assert.equal(sent[0].body.rows.length, 1);
    assert.equal(out.read, 2); assert.equal(out.accepted, 1); assert.equal(out.rejected.length, 1);
  });
  it('sends nothing when the database returns nothing', async () => {
    const sent = [];
    await runLive({ db: { query: async () => [] }, post: async (...a) => sent.push(a), today: '2026-11-03', log: quiet });
    assert.equal(sent.length, 0);
  });
  it('splits a large read into posts of at most 5000 rows', async () => {
    const many = Array.from({ length: 5001 }, (_, i) => row({ day: addDays('2020-01-01', Math.floor(i / 48)), time: `${String(Math.floor((i % 48) / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}` }));
    const sizes = [];
    await runLive({ db: { query: async () => many }, post: async (_p, b) => { sizes.push(b.rows.length); return { accepted: b.rows.length }; }, today: '2026-11-03', log: quiet });
    assert.deepEqual(sizes, [5000, 1]);
  });
});

describe('runBackfill', () => {
  it('reads a week at a time and sends everything to /backfill for review', async () => {
    const ranges = [], sent = [];
    const db = { query: async (_s, p) => { ranges.push(p); return [row({ day: p.from, time: '10:00' })]; } };
    const post = async (path, body) => { sent.push({ path, body }); return { rowsMapped: body.rows.length, mappingErrorCount: 0 }; };
    const out = await runBackfill({ db, post, today: '2026-11-03', weeks: 2, log: quiet });
    assert.deepEqual(ranges.map((r) => r.from), ['2026-10-20', '2026-10-27', '2026-11-03']);
    assert.equal(ranges[1].to, '2026-11-02'); assert.equal(ranges[2].to, '2026-11-03');
    assert.equal(sent.length, 1); assert.equal(sent[0].path, '/backfill'); assert.equal(sent[0].body.through, '2026-11-03');
    assert.equal(out.staged, 3);
  });
  it('reports rows the gateway could not match to a queue', async () => {
    const out = await runBackfill({ db: { query: async () => [row()] }, post: async () => ({ rowsMapped: 0, mappingErrorCount: 1 }), today: '2026-11-03', weeks: 1, log: quiet });
    assert.equal(out.unmatched, 1);      // one post carries both weekly reads, and the gateway reported one problem for it
  });
  it('does not hide a database error', async () => {
    await assert.rejects(() => runBackfill({ db: { query: async () => { throw new Error('Login failed for user'); } }, post: async () => ({}), today: '2026-11-03', weeks: 1, log: quiet }), /Login failed/);
  });
});
