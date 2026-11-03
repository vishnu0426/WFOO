import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, parseCsv, type QueueRef } from '../src/modules/csv.ts';

const queues: QueueRef[] = [{ id: 'q1', name: 'Support Voice', code: 'SV', ahtDefault: 300, aliases: ['SUPPORT_V'] }];
const detect = (csv: string, name = 'file.csv') => detectFormat(parseCsv(csv), name, queues);

/** One day of a queue at a given step, so the interval detector has neighbours to compare. */
const day = (date: string, step: number, q = 'Support Voice') =>
  Array.from({ length: 12 }, (_, i) => `${q},${date},${String(Math.floor((i * step) / 60)).padStart(2, '0')}:${String((i * step) % 60).padStart(2, '0')},10,300`).join('\n');
const HEAD = 'queue,date,interval,volume,aht\n';

test('ISO dates, 15-minute rows and a known queue are all detected with confidence', () => {
  const d = detect(HEAD + day('2026-03-31', 15));
  assert.equal(d.dateFormat.value, 'iso');
  assert.equal(d.intervalMinutes.value, 15);
  assert.equal(d.intervalMinutes.confidence, 'high');
  assert.equal(d.queueId.value, '');
  assert.equal(d.queueId.confidence, 'high');
  assert.deepEqual(d.problems, []);
  assert.equal(d.preview[0].time, '00:00');
});

test('30 and 60 minute files are told apart from 15', () => {
  assert.equal(detect(HEAD + day('2026-03-31', 30)).intervalMinutes.value, 30);
  assert.equal(detect(HEAD + day('2026-03-31', 60)).intervalMinutes.value, 60);
});

test('a missing slot does not fool the interval detector', () => {
  const rows = day('2026-03-31', 15).split('\n');
  rows.splice(5, 1);
  assert.equal(detect(HEAD + rows.join('\n')).intervalMinutes.value, 15);
});

test('a day above 12 settles day/month versus month/day', () => {
  assert.equal(detect(HEAD + 'Support Voice,31/03/2026,09:00,10,300\nSupport Voice,01/04/2026,09:00,10,300').dateFormat.value, 'dmy');
  assert.equal(detect(HEAD + 'Support Voice,03/31/2026,09:00,10,300\nSupport Voice,04/01/2026,09:00,10,300').dateFormat.value, 'mdy');
});

test('dates that could be either order are not guessed', () => {
  const d = detect(HEAD + 'Support Voice,03/04/2026,09:00,10,300\nSupport Voice,05/04/2026,09:00,10,300');
  assert.equal(d.dateFormat.value, null);
  assert.equal(d.dateFormat.confidence, 'ask');
});

test('mixed date orders are reported as a problem', () => {
  const d = detect(HEAD + 'Support Voice,31/03/2026,09:00,10,300\nSupport Voice,03/31/2026,09:15,10,300');
  assert.equal(d.dateFormat.value, null);
  assert.ok(d.problems.some((p) => /mix/.test(p)));
});

test('5-minute data is flagged as unsupported instead of imported as 15', () => {
  const d = detect(HEAD + day('2026-03-31', 5));
  assert.equal(d.intervalMinutes.value, null);
  assert.ok(d.problems.some((p) => /5 minutes apart/.test(p)));
});

test('the file name fills in only when the rows cannot', () => {
  const d = detect(HEAD + 'Support Voice,2026-03-31,09:00,10,300', 'WFM_Import_30min_x.csv');
  assert.equal(d.intervalMinutes.value, 30);
  assert.equal(d.intervalMinutes.confidence, 'medium');
});

test('a file name that disagrees with the rows is called out', () => {
  const d = detect(HEAD + day('2026-03-31', 15), 'export_30min.csv');
  assert.equal(d.intervalMinutes.value, 15);
  assert.match(d.intervalMinutes.reason, /file name says 30/);
});

test('unknown queue names are listed; aliases count as known', () => {
  const d = detect(HEAD + 'Billing,2026-03-31,09:00,10,300\nSUPPORT_V,2026-03-31,09:15,10,300');
  assert.equal(d.queueId.confidence, 'medium');
  assert.ok(d.problems.some((p) => p.includes("'Billing'") && !p.includes('SUPPORT_V')));
});

test('a file with no queue column asks for one, or takes it from the file name', () => {
  const csv = 'date,interval,volume\n2026-03-31,09:00,10\n2026-03-31,09:15,12';
  assert.equal(detect(csv).queueId.value, null);
  assert.equal(detect(csv, 'Support_Voice_march.csv').queueId.value, 'q1');
});

test('missing required columns are reported in plain language', () => {
  const d = detect('queue,when\nSupport Voice,2026-03-31');
  assert.ok(d.problems.some((p) => /No volume column/.test(p)));
});

test('other export column names and a BOM are understood', () => {
  const d = detect('﻿Workgroup,Date,Time,Calls Offered,Avg Handle Time\nSupport Voice,2026-03-31,9:00 AM,10,4:30');
  assert.deepEqual(d.problems, []);
  assert.equal(d.preview[0].time, '09:00');
  assert.equal(d.preview[0].aht, 270);
});
