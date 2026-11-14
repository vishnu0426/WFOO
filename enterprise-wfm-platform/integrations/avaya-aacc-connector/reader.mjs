/**
 * The reading loop of the AACC reader, with the database and the network passed in so a test can supply fakes.
 * `db.query(sql, { from, to })` returns the rows; `post(path, body)` sends to our gateway and returns its answer.
 */
import { addDays, buildQuery, chunk, prepareRows } from './lib.mjs';

const MAX_PER_POST = 5000;      // the gateway refuses more rows than this in one request

/** What the run found wrong, in a few lines a person can read. */
export function describeProblems({ rejected, flags, gaps }) {
  const out = [];
  if (rejected.length) out.push(`${rejected.length} row(s) rejected, first: ${rejected[0].reason}`);
  if (flags.length) out.push(`${flags.length} row(s) flagged, first: ${flags[0].queue ?? ''} ${flags[0].day ?? ''} ${flags[0].time ?? ''} ${flags[0].issue}`.replace(/\s+/g, ' '));
  if (gaps.length) out.push(`${gaps.length} gap(s) inside a day, first: ${gaps[0].queue} ${gaps[0].day} missing ${gaps[0].missingIntervals} interval(s) between ${gaps[0].after} and ${gaps[0].before}`);
  return out;
}

/** The recent days, saved to live history. Re-reading the same days is safe: an interval written again replaces itself. */
export async function runLive({ db, post, table, columns, today, days = 2, log = console.log }) {
  const sql = buildQuery({ table, columns });
  const raw = await db.query(sql, { from: addDays(today, -days), to: today });
  const prep = prepareRows(raw);
  for (const m of describeProblems(prep)) log(`  ${m}`);
  let accepted = 0;
  for (const part of chunk(prep.rows, MAX_PER_POST)) accepted += (await post('/live', { rows: part })).accepted ?? 0;
  log(`Read ${raw.length} row(s), sent ${prep.rows.length}, accepted ${accepted}.`);
  return { read: raw.length, sent: prep.rows.length, accepted, ...prep };
}

/** The last N weeks, a week at a time, sent for review (nothing reaches the forecasts until a person commits it). */
export async function runBackfill({ db, post, table, columns, today, weeks = 8, log = console.log }) {
  const sql = buildQuery({ table, columns });
  const all = { rows: [], rejected: [], flags: [], gaps: [] };
  let read = 0;
  for (let start = addDays(today, -weeks * 7); start <= today; start = addDays(start, 7)) {
    const end = addDays(start, 6) < today ? addDays(start, 6) : today;
    const raw = await db.query(sql, { from: start, to: end });
    read += raw.length;
    const p = prepareRows(raw);
    all.rows.push(...p.rows); all.rejected.push(...p.rejected); all.flags.push(...p.flags); all.gaps.push(...p.gaps);
  }
  for (const m of describeProblems(all)) log(`  ${m}`);
  let staged = 0, unmatched = 0;
  for (const part of chunk(all.rows, MAX_PER_POST)) {
    const out = await post('/backfill', { rows: part, through: today });
    staged += out.rowsMapped ?? 0; unmatched += out.mappingErrorCount ?? 0;
  }
  log(`Read ${read} row(s) over ${weeks} week(s), sent ${all.rows.length}, ${staged} staged for review${unmatched ? `, ${unmatched} could not be matched to a queue` : ''}.`);
  return { read, sent: all.rows.length, staged, unmatched, ...all };
}
