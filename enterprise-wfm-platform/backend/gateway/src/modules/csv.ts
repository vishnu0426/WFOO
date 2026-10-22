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

export interface QueueRef { id: string; name: string; code: string; ahtDefault: number }
export interface StagedRecord { line: number; queueId: string; day: string; slot: number; volume: number; ahtSec: number; abandoned: number }
export interface RowIssue { line: number; message: string }

export interface NormaliseOptions { queue?: string; intervalMin?: number; dateFormat?: DateFormat; queues: QueueRef[] }
export interface NormaliseResult {
  records: StagedRecord[]; errors: RowIssue[]; rowsRead: number; rowsOk: number;
  columns: { field: string; source: string | null; required: boolean }[];
}

export function normalise(matrix: string[][], o: NormaliseOptions): NormaliseResult {
  const header = matrix[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const col: Record<keyof typeof ALIASES, number> = { queue: -1, day: -1, time: -1, volume: -1, aht: -1, abandoned: -1 };
  for (const k of Object.keys(ALIASES) as (keyof typeof ALIASES)[]) col[k] = header.findIndex((h) => (ALIASES[k] as readonly string[]).includes(h));
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
  const find = (v: string) => byName.get(v.toLowerCase()) ?? byCode.get(v.toLowerCase()) ?? byId.get(v);
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
      if (!q) { fail(`Unknown queue '${name}'`); continue; }
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

export const TEMPLATE_CSV = `queue,date,interval,volume,aht,abandoned
Support Voice,2026-01-05,09:00,42,301,1
Support Voice,2026-01-05,09:15,47,296,2
Support Chat,2026-01-05,09:00,18,540,0
`;
