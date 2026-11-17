/**
 * What happened to each message a live connector received, kept for a day so an administrator can see events arrive and why one was turned away.
 * Held in Redis, not the database: a live feed is many messages a second and this is only for looking at. Ignored messages (heartbeats) are
 * counted, never listed, since they would bury the rest. Everything here is best effort and never slows or breaks ingest.
 */
import { redis } from '../../infra.ts';

export type FeedOutcome = 'ACCEPTED' | 'IGNORED' | 'WAITING' | 'REJECTED';
export interface FeedEvent { at: string; eventType: string | null; sourceId: string | null; outcome: FeedOutcome; state: string | null; reason: string | null; message: string | null; raw: unknown }

export const KEEP = 200, KEEP_SEC = 24 * 3600, BUCKET_SEC = 3600;
const listKey = (tenantId: string, connectorId: string) => `feed:${tenantId}:${connectorId}:events`;
const countKey = (tenantId: string, connectorId: string, hour: number) => `feed:${tenantId}:${connectorId}:count:${hour}`;
const hourOf = (ms: number) => Math.floor(ms / 1000 / BUCKET_SEC);

/** A raw message can be large; keep enough to see what it was. */
const slim = (raw: unknown) => { try { const s = JSON.stringify(raw); return s && s.length > 2000 ? { truncated: s.slice(0, 2000) } : raw; } catch { return null; } };

export async function recordFeedEvent(tenantId: string, connectorId: string, ev: Omit<FeedEvent, 'at'>, now = Date.now()): Promise<void> {
  try {
    const p = redis.pipeline();
    p.hincrby(countKey(tenantId, connectorId, hourOf(now)), ev.outcome, 1).expire(countKey(tenantId, connectorId, hourOf(now)), 3 * BUCKET_SEC);
    if (ev.outcome !== 'IGNORED') {
      p.lpush(listKey(tenantId, connectorId), JSON.stringify({ ...ev, raw: slim(ev.raw), at: new Date(now).toISOString() } satisfies FeedEvent)).ltrim(listKey(tenantId, connectorId), 0, KEEP - 1).expire(listKey(tenantId, connectorId), KEEP_SEC);
    }
    await p.exec();
  } catch { /* looking-at data only */ }
}

export interface FeedView { events: FeedEvent[]; lastHour: Record<FeedOutcome, number>; available: boolean }

/** The newest events (optionally one outcome) and how many messages of each outcome came in over roughly the last hour. */
export async function readFeed(tenantId: string, connectorId: string, outcome?: FeedOutcome, limit = 100, now = Date.now()): Promise<FeedView> {
  const lastHour: Record<FeedOutcome, number> = { ACCEPTED: 0, IGNORED: 0, WAITING: 0, REJECTED: 0 };
  try {
    const h = hourOf(now);
    const [rows, ...counts] = await Promise.all([redis.lrange(listKey(tenantId, connectorId), 0, KEEP - 1), ...[h, h - 1].map((x) => redis.hgetall(countKey(tenantId, connectorId, x)))]);
    // the current hour plus the share of the previous hour that is still inside "the last 60 minutes"
    const share = 1 - ((now / 1000) % BUCKET_SEC) / BUCKET_SEC;
    for (const k of Object.keys(lastHour) as FeedOutcome[]) lastHour[k] = Math.round(Number(counts[0]?.[k] ?? 0) + Number(counts[1]?.[k] ?? 0) * share);
    const events = rows.map((r) => { try { return JSON.parse(r) as FeedEvent; } catch { return null; } }).filter((e): e is FeedEvent => !!e && (!outcome || e.outcome === outcome)).slice(0, limit);
    return { events, lastHour, available: true };
  } catch { return { events: [], lastHour, available: false }; }
}
