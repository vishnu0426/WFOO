/**
 * Pure parts of the Avaya AACC reader: building the query, turning database rows into the rows our ingest endpoints take, and checking
 * them. No network and no database here, so all of it is tested on its own (test.mjs).
 *
 * What is and is not known about AACC: Avaya's manuals name the interval statistics tables (iSkillsetStat, with daily, weekly and
 * monthly versions) and say they are keyed by a timestamp. The column names are in Avaya's Historical Reporting Data Dictionary, which
 * we do not have. DEFAULT_COLUMNS below are therefore assumptions, not facts: every one can be changed with a --col-* option, and
 * `--check-columns` lists what the customer's table really contains.
 */

export const DEFAULT_COLUMNS = {
  timestamp: 'Timestamp',
  skillset: 'SkillsetName',
  offered: 'CallsOffered',
  answered: 'CallsAnswered',
  abandoned: 'CallsAbandoned',
  handleSeconds: 'HandleTime',   // total seconds spent handling in the interval; AHT = handleSeconds / answered
  aht: '',                       // use instead of handleSeconds when the table already holds an average
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Table and column names go into the SQL text, so only plain identifiers are accepted (everything else is a parameter). */
export function ident(name, what) {
  if (!IDENT.test(String(name ?? ''))) throw new Error(`${what} '${name}' is not a plain name (letters, digits and underscores only).`);
  return `[${name}]`;
}

/**
 * One SELECT over the interval table. Day and time are produced by the database as text in its own local time, the same rule our
 * other database connectors follow, so no time zone is lost on the way. Only {from} and {to} (inclusive dates) are parameters.
 */
export function buildQuery({ table = 'iSkillsetStat', columns = {} } = {}) {
  const c = { ...DEFAULT_COLUMNS, ...columns };
  const t = ident(table, 'Table');
  const ts = ident(c.timestamp, 'Timestamp column');
  const cols = [
    `CONVERT(char(10), ${ts}, 23) AS [day]`,
    `CONVERT(char(5), ${ts}, 108) AS [time]`,
    `${ident(c.skillset, 'Skillset column')} AS [queue]`,
    `${ident(c.offered, 'Offered column')} AS [offered]`,
  ];
  if (c.answered) cols.push(`${ident(c.answered, 'Answered column')} AS [answered]`);
  if (c.abandoned) cols.push(`${ident(c.abandoned, 'Abandoned column')} AS [abandoned]`);
  if (c.aht) cols.push(`${ident(c.aht, 'AHT column')} AS [aht]`);
  else if (c.handleSeconds) cols.push(`${ident(c.handleSeconds, 'Handle-time column')} AS [handleSeconds]`);
  return `SELECT ${cols.join(', ')} FROM ${t} WHERE ${ts} >= CAST(@from AS date) AND ${ts} < DATEADD(day, 1, CAST(@to AS date)) ORDER BY ${ts}`;
}

/** The query that shows a table's real column names, so the options above can be set from fact rather than assumption. */
export const COLUMNS_QUERY = 'SELECT COLUMN_NAME AS name, DATA_TYPE AS type FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = @table ORDER BY ORDINAL_POSITION';

const num = (v) => (v === null || v === undefined || v === '' ? undefined : Number(v));

/**
 * Database rows -> rows for /live and /backfill, plus what was wrong with them. Nothing is dropped or changed without being listed:
 * a row with no usable queue, day, time or volume is rejected, an abandoned count above the offered count is capped and flagged,
 * and rows for the same skillset and interval are added together (and said so).
 */
export function prepareRows(raw) {
  const rejected = [], flags = [];
  const merged = new Map();
  raw.forEach((r, i) => {
    const queue = String(r.queue ?? '').trim(), day = String(r.day ?? '').trim(), time = String(r.time ?? '').trim();
    if (!queue) return rejected.push({ index: i, reason: 'no skillset name' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time)) return rejected.push({ index: i, reason: `day/time not readable ('${day}' '${time}')` });
    const offered = num(r.offered);
    if (offered === undefined || !Number.isFinite(offered) || offered < 0) return rejected.push({ index: i, reason: `offered count not usable (${r.offered})` });
    let abandoned = num(r.abandoned);
    if (abandoned !== undefined && (!Number.isFinite(abandoned) || abandoned < 0)) { flags.push({ index: i, queue, day, time, issue: `abandoned count not usable (${r.abandoned}); left out` }); abandoned = undefined; }
    const answered = num(r.answered);
    let handle = num(r.handleSeconds);
    if (r.aht !== undefined && r.aht !== null && r.aht !== '') handle = Number(r.aht) * (answered && answered > 0 ? answered : 1);
    const key = `${queue}|${day}|${time}`;
    const seen = merged.get(key);
    if (seen) {
      seen.offered += offered; seen.answered = (seen.answered ?? 0) + (answered ?? 0);
      if (abandoned !== undefined) seen.abandoned = (seen.abandoned ?? 0) + abandoned;
      if (handle !== undefined && Number.isFinite(handle)) seen.handle = (seen.handle ?? 0) + handle;
      if (!seen.duplicate) { seen.duplicate = true; flags.push({ index: i, queue, day, time, issue: 'more than one row for this skillset and interval; added together' }); }
    } else merged.set(key, { queue, day, time, offered, answered, abandoned, handle: Number.isFinite(handle) ? handle : undefined });
  });

  const rows = [];
  for (const m of merged.values()) {
    let abandoned = m.abandoned;
    if (abandoned !== undefined && abandoned > m.offered) { flags.push({ queue: m.queue, day: m.day, time: m.time, issue: `abandoned (${abandoned}) is more than offered (${m.offered}); capped at offered` }); abandoned = m.offered; }
    const row = { queue: m.queue, day: m.day, time: m.time, volume: m.offered };
    if (abandoned !== undefined) row.abandoned = abandoned;
    if (m.handle !== undefined && m.answered && m.answered > 0) row.ahtSec = Math.round(m.handle / m.answered);
    rows.push(row);
  }
  return { rows, rejected, flags, gaps: findGaps(rows) };
}

const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Intervals missing in the middle of a skillset's day (between its first and last interval that day). An outage or a statistics restart
 * looks like this. Only reported: a skillset that closes for lunch also has gaps, so it is a question for a person, not something to fill.
 */
export function findGaps(rows, intervalMin = 0) {
  const byDay = new Map();
  for (const r of rows) { const k = `${r.queue}|${r.day}`; (byDay.get(k) ?? byDay.set(k, []).get(k)).push(mins(r.time)); }
  const gaps = [];
  for (const [k, list] of byDay) {
    list.sort((a, b) => a - b);
    const step = intervalMin || list.slice(1).map((v, i) => v - list[i]).filter((d) => d > 0).reduce((a, b) => Math.min(a, b), 1440) || 30;
    const [queue, day] = k.split('|');
    for (let i = 1; i < list.length; i++) {
      const missing = Math.round((list[i] - list[i - 1]) / step) - 1;
      if (missing >= 1) gaps.push({ queue, day, after: fmt(list[i - 1]), before: fmt(list[i]), missingIntervals: missing });
    }
  }
  return gaps;
}
const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Days as YYYY-MM-DD, counted in whole days with no time zone involved. */
export const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
