/** Pure rules for what the server can pull itself and how a file path is read. No database, so they can be tested on their own. */
import type { Preset } from './presets.ts';

/**
 * What the server can fetch for itself. Only a plain REST source (we are told the address and send its key) and an SFTP folder qualify:
 * the vendor presets (Genesys, NICE, Amazon Connect, ...) need their own query bodies and signing and have never been run against a live
 * account, so they are not offered as a scheduled pull rather than shipped unverified.
 */
export function pullSupport(preset: Preset | undefined, config: Record<string, any>): { canPull: boolean; note: string } {
  if (!preset) return { canPull: false, note: '' };
  if (preset.id === 'GENERIC_ACD_API') return { canPull: true, note: 'Fetches the historical volume endpoint with your key. Use {from} and {to} in the path for the date range (yesterday to today).' };
  if (preset.id === 'DATABASE_POSTGRES_PULL') return { canPull: true, note: 'Reads your PostgreSQL database with your read-only login. "Load history" stages the last weeks for review; scheduled runs then keep the recent days up to date.' };
  if (preset.id === 'GENERIC_SFTP') {
    return (config?.direction ?? 'they_host') === 'we_host'
      ? { canPull: false, note: 'We do not host an SFTP folder yet. Choose "They host" and give us the server details, or have your side push through the on-site relay.' }
      : { canPull: true, note: 'Signs in to your SFTP server, picks up new CSV files and stages each one for review. Nothing goes live until it is committed.' };
  }
  if (preset.method === 'API_PULL') return { canPull: false, note: `Scheduled pulls for ${preset.label} are not available yet: its requests are specific to the vendor and have not been verified against a live account. Use the generic REST connector, a webhook, or the on-site relay to send us the data.` };
  return { canPull: false, note: '' };
}

const LIST_KEYS = ['rows', 'data', 'items', 'results', 'records'];
/** The list of rows in a JSON response: the response itself, a well-known key, or the first list found. */
export function findRows(json: any): Record<string, unknown>[] {
  if (Array.isArray(json)) return json;
  for (const k of LIST_KEYS) if (Array.isArray(json?.[k])) return json[k];
  const any = Object.values(json ?? {}).find((v) => Array.isArray(v));
  if (any) return any as Record<string, unknown>[];
  throw new Error('The response did not contain a list of rows. Expected a JSON array, or an object with a "rows", "data" or "items" list.');
}

/** `exports/*.csv` -> folder `exports`, pattern /^.*\.csv$/i. A plain folder picks up every .csv and .txt. */
export function parseRemotePath(remotePath: string | undefined): { dir: string; match: RegExp } {
  const p = (remotePath ?? '').trim() || '/';
  if (!p.includes('*')) return { dir: p.replace(/\/+$/, '') || '/', match: /\.(csv|txt)$/i };
  const i = p.lastIndexOf('/');
  const dir = i > 0 ? p.slice(0, i) : '/', pat = p.slice(i + 1);
  return { dir, match: new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') };
}

// ---------------------------------------------------------------- database query

export const MAX_DB_ROWS = 150_000;

/** The admin's query must be one SELECT (or WITH ... SELECT). Anything else is refused up front; the read also runs in a read-only transaction. */
export function checkQuery(query: string | undefined): string {
  const q = String(query ?? '').trim().replace(/;+\s*$/, '').trim();
  if (!q) throw new Error('Write the query that returns the interval rows.');
  if (!/^(select|with)\b/i.test(q)) throw new Error('The query must start with SELECT (or WITH). Nothing else is allowed.');
  if (q.includes(';')) throw new Error('Use a single query with no semicolons inside it.');
  if (/--|\/\*/.test(q)) throw new Error('Leave comments out of the query.');
  return q;
}

/**
 * Turns {from} and {to} (inclusive dates) into numbered parameters, and caps the number of rows the database may send back.
 * Only the parameters actually used are passed, because PostgreSQL refuses a statement given more values than it has placeholders.
 */
export function prepareQuery(query: string | undefined, from: string, to: string, limit = MAX_DB_ROWS): { text: string; params: string[] } {
  const q = checkQuery(query);
  const params: string[] = [];
  const index: Record<string, number> = {};
  const body = q.replace(/\{(from|to)\}/g, (_m, name: 'from' | 'to') => {
    if (!index[name]) { params.push(name === 'from' ? from : to); index[name] = params.length; }
    return `$${index[name]}::date`;
  });
  return { text: `SELECT * FROM (${body}) AS wfm_pull LIMIT ${limit + 1}`, params };
}

/** A date/time that arrives as a JavaScript Date has lost its time zone: refuse it and say how to write the query instead. */
export function checkDbValue(field: 'day' | 'time', v: unknown): string | null {
  if (v instanceof Date) return `The ${field} column came back as a timestamp. Return it as text in your local time, for example to_char(ts, '${field === 'day' ? 'YYYY-MM-DD' : 'HH24:MI'}').`;
  return null;
}

/** Settings that only make sense together, checked when a connector is saved. */
export function checkPresetConfig(preset: Preset, config: Record<string, any>): void {
  if (preset.id === 'DATABASE_POSTGRES_PULL') {
    checkQuery(config.query);
    const w = config.backfillWeeks === undefined || config.backfillWeeks === '' ? 8 : Number(config.backfillWeeks);
    if (!Number.isInteger(w) || w < 1 || w > 104) throw new Error('"Weeks of history to load" must be a whole number from 1 to 104.');
  }
}
