/**
 * The Forecasts list as people think of it: one forecast per group and type, with its numbered versions underneath. Pure functions (no React, no browser), tested on their own.
 *
 * A "forecast" here is a WFM group's short-term or long-term forecast, and its versions are what it has been through: a draft cloned from the live one, an edit, a new build. Publishing
 * one version archives the one that was live, so there is never more than one live version per forecast; that is the one pinned to the top.
 */
export type VersionStatus = 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'PUBLISHED' | 'ARCHIVED';
/** What this module needs to know about a version (the screen's own version type has more, and is what comes back out). Kept free of the app's other modules so the gateway's tests can use it. */
export interface VersionLike {
  id: string; seq: number; wfmGroupId: string; name: string; kind: 'SHORT' | 'LONG'; status: VersionStatus; parentVersionId: string | null; fromDay: string; toDay: string;
  createdAt: string; submittedAt: string | null; approvedAt: string | null; publishedAt: string | null;
}

export interface Family<V extends VersionLike = VersionLike> {
  key: string; groupId: string; kind: 'SHORT' | 'LONG';
  /** Every version of the forecast, whatever the filters (what a comparison can be made with). */
  members: V[];
  /** The versions that match the current filters: the live one first, then drafts and reviews newest first, then archived ones. */
  versions: V[];
  /** The live (published) version among them, if any. */
  live: V | null;
  /** What the row shows: the live version, else the newest one still in play, else the newest archived one. */
  headline: V;
  updatedAt: string;
  /** How many versions the forecast has in all, whatever the filters, and how many of those are waiting for someone. */
  total: number; inProgress: number;
}

export const updatedAt = (v: VersionLike) => [v.publishedAt, v.approvedAt, v.submittedAt, v.createdAt].filter(Boolean).sort().at(-1) as string;
const rank = (v: VersionLike) => (v.status === 'PUBLISHED' ? 0 : v.status === 'ARCHIVED' ? 2 : 1);
export const byInterest = (a: VersionLike, b: VersionLike) => rank(a) - rank(b) || b.seq - a.seq;

export function groupFamilies<V extends VersionLike>(all: V[], o: { status?: VersionStatus | ''; groupId?: string; query?: string; groupName: (id: string) => string }): Family<V>[] {
  const q = (o.query ?? '').trim().toLowerCase();
  const matches = (v: V) =>
    (!o.status || v.status === o.status) && (!o.groupId || v.wfmGroupId === o.groupId)
    && (!q || v.name.toLowerCase().includes(q) || `v${v.seq}`.includes(q) || o.groupName(v.wfmGroupId).toLowerCase().includes(q) || (v.kind === 'SHORT' ? 'short-term' : 'long-term').includes(q));
  const byKey = new Map<string, V[]>();
  for (const v of all) byKey.set(`${v.wfmGroupId}|${v.kind}`, [...(byKey.get(`${v.wfmGroupId}|${v.kind}`) ?? []), v]);
  const out: Family<V>[] = [];
  for (const [key, every] of byKey) {
    const shown = every.filter(matches).sort(byInterest);
    if (!shown.length) continue;
    out.push({
      key, groupId: every[0].wfmGroupId, kind: every[0].kind, members: [...every].sort(byInterest), versions: shown, live: shown.find((v) => v.status === 'PUBLISHED') ?? null, headline: shown[0],
      updatedAt: shown.map(updatedAt).sort().at(-1)!, total: every.length, inProgress: every.filter((v) => v.status === 'DRAFT' || v.status === 'SUBMITTED' || v.status === 'APPROVED').length,
    });
  }
  // the forecasts that are live come first (newest change first), then the rest by newest change
  return out.sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.updatedAt.localeCompare(a.updatedAt) || (a.key < b.key ? -1 : 1));
}

/** "from v1" for a version cloned from another one that is in the list. */
export function originOf<V extends VersionLike>(v: V, byId: Map<string, V>): string | null {
  const p = v.parentVersionId ? byId.get(v.parentVersionId) : null;
  return p ? `from v${p.seq}` : null;
}

const NB = ' ';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const part = (s: string) => ({ y: Number(s.slice(0, 4)), m: Number(s.slice(5, 7)) - 1, d: Number(s.slice(8, 10)) });
export const daysBetween = (a: string, b: string) => Math.round((Date.UTC(part(b).y, part(b).m, part(b).d) - Date.UTC(part(a).y, part(a).m, part(a).d)) / 864e5) + 1;

/** One short line for a forecast's dates: "4 Nov – 15 Dec · 6 wk" (the year is added only when it is not this year). Never breaks across lines. */
export function horizonLabel(from: string, to: string, now = new Date()): string {
  const a = part(from), b = part(to), thisYear = now.getFullYear();
  const fmt = (p: ReturnType<typeof part>, withYear: boolean) => `${p.d}${NB}${MONTHS[p.m]}${withYear ? `${NB}${p.y}` : ''}`;
  const withYear = a.y !== thisYear || b.y !== thisYear;
  const n = daysBetween(from, to);
  const length = n % 7 === 0 && n <= 182 ? `${n / 7}${NB}wk` : n >= 60 ? `${Math.round(n / 30.44)}${NB}mo` : `${n}${NB}d`;
  return `${fmt(a, withYear)}${NB}–${NB}${fmt(b, withYear)}${NB}·${NB}${length}`;
}

// ---------------------------------------------------------------- columns

export type OptionalColumn = 'channel' | 'interval' | 'owner';
export const OPTIONAL_COLUMNS: { id: OptionalColumn; label: string }[] = [{ id: 'channel', label: 'Channel' }, { id: 'interval', label: 'Interval' }, { id: 'owner', label: 'Owner' }];
export const COLUMNS_KEY = 'wfm_forecasts_cols';
/** Channel, interval and owner are hidden until someone asks for them (the owner is the same person on nearly every row, the interval is set by the type). */
export function readColumns(raw: string | null): Record<OptionalColumn, boolean> {
  const d = { channel: false, interval: false, owner: false };
  try { const x = raw ? JSON.parse(raw) : null; if (x && typeof x === 'object') for (const k of Object.keys(d) as OptionalColumn[]) if (typeof x[k] === 'boolean') d[k] = x[k]; } catch { /* keep the defaults */ }
  return d;
}

// ---------------------------------------------------------------- what the row menu offers

export type RowAction = 'open' | 'compare' | 'submit' | 'approve' | 'publish' | 'return' | 'clone' | 'export' | 'archive' | 'delete';
/** The actions a version's menu offers: what its status allows and what the person may do (the gateway checks both again). */
export function rowActions(status: VersionStatus, can: (permission: string) => boolean, o: { comparable: boolean }): RowAction[] {
  const a: RowAction[] = ['open'];
  if (o.comparable) a.push('compare');
  if (status === 'DRAFT' && can('forecast:submit')) a.push('submit');
  if (status === 'SUBMITTED' && can('forecast:approve')) a.push('approve');
  if (status === 'APPROVED' && can('forecast:publish')) a.push('publish');
  if ((status === 'SUBMITTED' || status === 'APPROVED') && (can('forecast:approve') || can('forecast:submit'))) a.push('return');
  if ((status === 'PUBLISHED' || status === 'ARCHIVED') && can('forecast:create')) a.push('clone');
  a.push('export');
  if ((status === 'DRAFT' || status === 'SUBMITTED' || status === 'APPROVED') && (can('forecast:approve') || can('forecast:delete'))) a.push('archive');
  if (status !== 'PUBLISHED' && can('forecast:delete')) a.push('delete');
  return a;
}

/**
 * What to compare a version with first: a version that is not live is compared with the live one (what would change if it were published); the live one with the version it was
 * cloned from, else the newest one still in play; if there is none of those, any other version.
 */
export function defaultBase<V extends VersionLike>(v: V, members: V[]): V | null {
  const others = members.filter((m) => m.id !== v.id);
  if (!others.length) return null;
  const live = others.find((m) => m.status === 'PUBLISHED');
  if (v.status !== 'PUBLISHED' && live) return live;
  const parent = others.find((m) => m.id === v.parentVersionId);
  if (parent) return parent;
  return others.find((m) => m.status !== 'ARCHIVED') ?? others[0];
}

/** A short "updated" for a table cell: "Today 09:08", "Yesterday", "12 Nov", or "12 Nov 2025" for another year (the full time goes in the tooltip). */
export function shortWhen(iso: string, now = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '–';
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(d, now)) return `Today ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay(d, yesterday)) return 'Yesterday';
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === now.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}
