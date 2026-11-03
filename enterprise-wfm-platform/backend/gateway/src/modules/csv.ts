/**
 * CSV parsing and row normalisation for interval history. Accepts the column names common ACD/CCaaS exports use.
 * Nothing is written here: the caller stages the result and shows the planner a diff before anything goes live.
 */

const ALIASES = {
  queue: ['queue', 'queue_name', 'queuename', 'skill', 'workgroup', 'queue_id', 'queue_code'],
  day: ['date', 'day', 'interval_date', 'start_date'],
  time: ['interval', 'time', 'interval_start', 'start', 'start_time', 'slot', 'timestamp', 'datetime'],
  volume: ['volume', 'offered', 'contacts', 'calls', 'received', 'presented', 'contacts_offered', 'contacts_handled', 'handled', 'incoming_calls', 'incoming', 'calls_offered', 'offered_calls'],
  aht: ['aht', 'aht_sec', 'aht_seconds', 'handle_time', 'avg_handle_time', 'average_handle_time', 'talk_duration_(avg)', 'talk_duration', 'avg_talk_time'],
  abandoned: ['abandoned', 'abandons', 'abandon', 'contacts_abandoned', 'abandoned_calls'],
} as const;

/** Minimal RFC 4180 parser: quoted fields, escaped quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', q = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip a UTF-8 byte-order mark
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const pad = (n: number | string) => String(n).padStart(2, '0');
const validDate = (y: number, m: number, d: number) => { const t = new Date(y, m - 1, d); return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d; };

export type DateFormat = 'iso' | 'mdy' | 'dmy';

export function parseDay(raw: string, fmt: DateFormat = 'iso'): string | null {
  const s = String(raw).trim().split(/[ T]/)[0];
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s))) return validDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad(m[2])}-${pad(m[3])}` : null;
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s))) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    const [mo, d] = fmt === 'dmy' ? [b, a] : [a, b];
    return validDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null;
}

/** "09:15", "9:15 AM", "09:15:00", "2026-01-05 09:15" or (for a `slot` column) an interval index -> minute of day. */
export function parseMinute(raw: string, allowSlotIndex = false): number | null {
  const s = String(raw).trim();
  const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/.exec(s);
  if (m) {
    let h = +m[1];
    if (m[3]) { h %= 12; if (/p/i.test(m[3])) h += 12; }
    return h < 24 && +m[2] < 60 ? h * 60 + +m[2] : null;
  }
  if (allowSlotIndex && /^\d+$/.test(s) && +s < 96) return +s * 15;
  return null;
}

/** Seconds from "213", "2:14" (m:ss) or "00:02:14" (h:mm:ss); NaN when it is none of those. */
export function parseSeconds(raw: string): number {
  const s = String(raw).trim();
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(s);
  if (m) return (m[1] ? +m[1] * 3600 : 0) + +m[2] * 60 + +m[3];
  return Number(s);
}

export interface QueueRef { id: string; name: string; code: string; ahtDefault: number; aliases?: string[] }
export interface StagedRecord { line: number; queueId: string; day: string; slot: number; volume: number; ahtSec: number; abandoned: number }
export interface RowIssue { line: number; message: string }

export interface NormaliseOptions { queue?: string; intervalMin?: number; dateFormat?: DateFormat; queues: QueueRef[] }
export interface NormaliseResult {
  records: StagedRecord[]; errors: RowIssue[]; rowsRead: number; rowsOk: number;
  columns: { field: string; source: string | null; required: boolean }[];
}

function mapColumns(rawHeader: string[]) {
  const header = rawHeader.map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col: Record<keyof typeof ALIASES, number> = { queue: -1, day: -1, time: -1, volume: -1, aht: -1, abandoned: -1 };
  for (const k of Object.keys(ALIASES) as (keyof typeof ALIASES)[]) col[k] = header.findIndex((h) => (ALIASES[k] as readonly string[]).includes(h));
  return { header, col };
}

export function normalise(matrix: string[][], o: NormaliseOptions): NormaliseResult {
  const { header, col } = mapColumns(matrix[0]);
  const columns = (Object.keys(ALIASES) as (keyof typeof ALIASES)[]).map((k) => ({
    field: k, source: col[k] >= 0 ? matrix[0][col[k]].trim() : null, required: k !== 'aht' && k !== 'abandoned' && !(k === 'queue' && !!o.queue),
  }));
  const errors: RowIssue[] = [];
  const fatal = (msg: string) => errors.push({ line: 1, message: msg });
  if (col.day < 0) fatal(`No date column (expected one of: ${ALIASES.day.join(', ')}). Every row needs the date it happened on: this file only has ${matrix[0].slice(0, 3).map((h) => `'${h.trim()}'`).join(', ')}${matrix[0].length > 3 ? '…' : ''}.`);
  if (col.volume < 0) fatal(`No volume column (expected one of: ${ALIASES.volume.join(', ')})`);
  if (col.time < 0 && !(col.day >= 0 && matrix.slice(1, 6).every((r) => /\d:\d\d/.test(r[col.day] || '')))) fatal(`No interval/time column (expected one of: ${ALIASES.time.join(', ')})`);
  if (col.queue < 0 && !o.queue) fatal('No queue column and no default queue selected');
  if (errors.length) return { records: [], errors, rowsRead: matrix.length - 1, rowsOk: 0, columns };

  const byName = new Map(o.queues.map((q) => [q.name.toLowerCase(), q]));
  const byCode = new Map(o.queues.map((q) => [q.code.toLowerCase(), q]));
  const byId = new Map(o.queues.map((q) => [q.id, q]));
  const byAlias = new Map(o.queues.flatMap((q) => (q.aliases ?? []).map((a) => [a.toLowerCase(), q] as const)));   // the names the phone system or the file uses
  const find = (v: string) => byName.get(v.toLowerCase()) ?? byCode.get(v.toLowerCase()) ?? byAlias.get(v.toLowerCase()) ?? byId.get(v);
  const def = o.queue ? find(o.queue) : undefined;
  if (o.queue && !def) return { records: [], errors: [{ line: 0, message: `Unknown queue '${o.queue}'` }], rowsRead: matrix.length - 1, rowsOk: 0, columns };

  const step = o.intervalMin === 30 ? 2 : o.intervalMin === 60 ? 4 : 1;   // 15-minute slots per source interval
  const records: StagedRecord[] = [];
  const seen = new Set<string>();
  let rowsOk = 0;
  for (let i = 1; i < matrix.length; i++) {
    const r = matrix[i], line = i + 1;
    const fail = (message: string) => { errors.push({ line, message }); };
    let q = def;
    if (col.queue >= 0) {
      const name = (r[col.queue] || '').trim();
      q = find(name);
      if (!q) { fail(`Unknown queue '${name}'. Add it as an alias of a queue in Configuration › WFM Groups, or create the queue.`); continue; }
    }
    if (!q) { fail('No queue'); continue; }
    const day = parseDay(r[col.day] || '', o.dateFormat);
    if (!day) { fail(`Bad date '${r[col.day]}'`); continue; }
    const tsrc = col.time >= 0 ? r[col.time] : r[col.day];
    const min = parseMinute(tsrc || '', col.time >= 0 && header[col.time] === 'slot');
    if (min === null) { fail(`Bad time '${tsrc}'`); continue; }
    const volume = Number(String(r[col.volume]).replace(/,/g, ''));
    if (!Number.isFinite(volume) || volume < 0) { fail(`Bad volume '${r[col.volume]}'`); continue; }
    const aht = col.aht >= 0 && (r[col.aht] ?? '') !== '' ? parseSeconds(r[col.aht]) : q.ahtDefault;
    if (!Number.isFinite(aht) || aht <= 0) { fail(`Bad AHT '${r[col.aht]}'`); continue; }
    const ab = col.abandoned >= 0 && (r[col.abandoned] ?? '') !== '' ? Math.max(0, Math.round(Number(r[col.abandoned]) || 0)) : 0;
    const first = Math.floor(min / 15);
    if (first + step > 96) { fail(`Interval ${tsrc} runs past midnight`); continue; }
    let dup = false;
    for (let k = 0; k < step; k++) {        // a 30/60-minute row is spread evenly over its 15-minute slots
      const key = `${q.id}|${day}|${first + k}`;
      if (seen.has(key)) { dup = true; if (k === 0) fail(`Duplicate row for ${q.name} ${day} ${tsrc}`); break; }
      seen.add(key);
      records.push({ line, queueId: q.id, day, slot: first + k, volume: Math.round(volume / step), ahtSec: Math.round(aht), abandoned: Math.round(ab / step) });
    }
    if (!dup) rowsOk++;
  }
  return { records, errors, rowsRead: matrix.length - 1, rowsOk, columns };
}

// ---------------------------------------------------------------- format detection

/** 'high' = the file itself settles it; 'medium' = a best guess (few rows, or only the filename says so); 'ask' = we will not guess. */
export interface Detected<T> { value: T | null; confidence: 'high' | 'medium' | 'ask'; reason: string }
export interface Detection {
  sampleRows: number;
  dataType: Detected<'HISTORICAL_VOLUME' | 'ACTUALS'>;
  intervalMinutes: Detected<15 | 30 | 60>;
  dateFormat: Detected<DateFormat>;
  queueId: Detected<string>;            // '' means "use the queue column"
  problems: string[];                   // things that will stop the import or reject rows, in plain language
  preview: { queue: string; day: string; time: string; volume: number; aht: number | null }[];
}

const hhmm = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

/** Works out the import settings from the first rows of a file. Reads only; the real import still validates every row. */
export function detectFormat(matrix: string[][], fileName: string, queues: QueueRef[]): Detection {
  const rows = matrix.slice(1);
  const { header, col } = mapColumns(matrix[0] ?? []);
  const problems: string[] = [];
  const out: Detection = {
    sampleRows: rows.length, problems, preview: [],
    dataType: { value: 'HISTORICAL_VOLUME', confidence: 'high', reason: 'The file has contacts per interval' },
    intervalMinutes: { value: null, confidence: 'ask', reason: '' },
    dateFormat: { value: null, confidence: 'ask', reason: '' },
    queueId: { value: null, confidence: 'ask', reason: '' },
  };
  if (col.day < 0) problems.push('No date column found. Expected a column named date or day.');
  if (col.volume < 0) problems.push('No volume column found. Expected a column named volume, offered, contacts or calls.');
  if (col.time < 0 && !(col.day >= 0 && rows.slice(0, 5).every((r) => /\d:\d\d/.test(r[col.day] || '')))) problems.push('No interval/time column found. Expected a column named interval or time.');
  if (/actual/i.test(fileName)) out.dataType = { value: 'ACTUALS', confidence: 'medium', reason: 'The file name says "actual"' };

  // date format: a day above 12 in the first slot fixes the order; ISO dates need no guessing
  if (col.day >= 0) {
    let iso = 0, dmy = 0, mdy = 0, flat = 0;
    for (const r of rows) {
      const s = String(r[col.day] ?? '').trim().split(/[ T]/)[0];
      if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) { iso++; continue; }
      const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
      if (!m) continue;
      if (+m[1] > 12 && +m[2] <= 12) dmy++; else if (+m[2] > 12 && +m[1] <= 12) mdy++; else flat++;
    }
    const d = out.dateFormat;
    if (iso && !dmy && !mdy && !flat) Object.assign(d, { value: 'iso', confidence: 'high', reason: 'Dates are written year-month-day' });
    else if (dmy && !mdy) Object.assign(d, { value: 'dmy', confidence: 'high', reason: 'A date has a day above 12 in the first position, so it is day/month' });
    else if (mdy && !dmy) Object.assign(d, { value: 'mdy', confidence: 'high', reason: 'A date has a day above 12 in the second position, so it is month/day' });
    else if (dmy && mdy) { d.reason = 'The dates mix day/month and month/day'; problems.push('The dates mix day/month and month/day. Fix the export so one order is used.'); }
    else if (flat) d.reason = 'Every date has both numbers 12 or under (like 03/04/2026), so the order cannot be told from the file. Please choose.';
    else if (iso) { Object.assign(d, { value: 'iso', confidence: 'medium', reason: 'Most dates are year-month-day' }); }
    else d.reason = 'No readable dates in the first rows';
  }

  // interval length: the usual gap between consecutive times for one queue on one day
  const fromName = /(?:^|[^0-9])(15|30|60)\s*-?\s*min/i.exec(fileName)?.[1];
  if (col.time >= 0 || col.day >= 0) {
    const groups = new Map<string, number[]>();
    for (const r of rows) {
      const src = col.time >= 0 ? r[col.time] : r[col.day];
      const mn = parseMinute(src || '', col.time >= 0 && header[col.time] === 'slot');
      if (mn === null) continue;
      const k = `${col.queue >= 0 ? r[col.queue] : ''}|${r[col.day]}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(mn);
    }
    const gaps = new Map<number, number>();
    for (const t of groups.values()) {
      const u = [...new Set(t)].sort((a, b) => a - b);
      for (let i = 1; i < u.length; i++) gaps.set(u[i] - u[i - 1], (gaps.get(u[i] - u[i - 1]) ?? 0) + 1);
    }
    const total = [...gaps.values()].reduce((a, b) => a + b, 0);
    const [gap, n] = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
    const iv = out.intervalMinutes;
    if (gap === 15 || gap === 30 || gap === 60) {
      const share = n / total;
      if (total >= 8 && share >= 0.6) Object.assign(iv, { value: gap, confidence: 'high', reason: `Rows are ${gap} minutes apart (${Math.round(share * 100)}% of ${total} neighbouring rows)` });
      else Object.assign(iv, { value: gap, confidence: 'medium', reason: `Rows look ${gap} minutes apart, but there are too few rows or too many gaps to be sure` });
    } else if (gap > 0) {
      iv.reason = `Rows are ${gap} minutes apart; only 15, 30 or 60 minute data can be imported`;
      problems.push(iv.reason + '.');
    }
    if (iv.value === null && gap === 0 && (fromName === '15' || fromName === '30' || fromName === '60')) Object.assign(iv, { value: +fromName, confidence: 'medium', reason: `Only the file name says ${fromName} minutes` });
    else if (iv.value === null && !iv.reason) iv.reason = 'Not enough rows to tell the interval length. Please choose.';
    if (fromName && iv.value && +fromName !== iv.value) iv.reason += `. The file name says ${fromName} minutes, but the rows say ${iv.value}`;
  }

  // queue
  const q = out.queueId;
  const byKey = new Map<string, QueueRef>();
  for (const x of queues) for (const k of [x.name, x.code, x.id, ...(x.aliases ?? [])]) byKey.set(k.toLowerCase(), x);
  if (col.queue >= 0) {
    const names = [...new Set(rows.map((r) => (r[col.queue] || '').trim()).filter(Boolean))];
    const unknown = names.filter((n) => !byKey.has(n.toLowerCase()));
    if (!unknown.length) Object.assign(q, { value: '', confidence: 'high', reason: `${names.length} queue${names.length === 1 ? '' : 's'} in the file, all matched` });
    else {
      Object.assign(q, { value: '', confidence: 'medium', reason: `${unknown.length} of ${names.length} queue names are not known yet` });
      problems.push(`Queue name${unknown.length === 1 ? '' : 's'} not recognised: ${unknown.slice(0, 5).map((n) => `'${n}'`).join(', ')}${unknown.length > 5 ? ` and ${unknown.length - 5} more` : ''}. Add as an alias in Configuration › WFM Groups, or those rows will be rejected.`);
    }
  } else {
    const hit = queues.find((x) => fileName.toLowerCase().replace(/[^a-z0-9]/g, '').includes(x.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    if (hit) Object.assign(q, { value: hit.id, confidence: 'medium', reason: `No queue column; the file name matches ${hit.name}` });
    else q.reason = 'The file has no queue column. Please choose the queue it belongs to.';
  }

  // preview of the first rows as they will be read
  if (!problems.some((p) => /^No (date|volume|interval)/.test(p))) {
    for (const r of rows.slice(0, 5)) {
      const src = col.time >= 0 ? r[col.time] : r[col.day];
      const mn = parseMinute(src || '', col.time >= 0 && header[col.time] === 'slot');
      const day = parseDay(r[col.day] || '', out.dateFormat.value ?? 'iso');
      const aht = col.aht >= 0 && (r[col.aht] ?? '') !== '' ? parseSeconds(r[col.aht]) : null;
      out.preview.push({ queue: col.queue >= 0 ? (r[col.queue] || '').trim() : '', day: day ?? `? ${r[col.day]}`, time: mn === null ? `? ${src}` : hhmm(mn), volume: Number(String(r[col.volume]).replace(/,/g, '')), aht: aht !== null && Number.isFinite(aht) ? aht : null });
    }
  }
  return out;
}

export const TEMPLATE_CSV =`queue,date,interval,volume,aht,abandoned
Support Voice,2026-01-05,09:00,42,301,1
Support Voice,2026-01-05,09:15,47,296,2
Support Chat,2026-01-05,09:00,18,540,0
`;
