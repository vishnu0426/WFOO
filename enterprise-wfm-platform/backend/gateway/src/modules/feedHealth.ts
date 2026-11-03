/** The verdict for one data feed. Pure, so the rules can be tested without a database and reused for connectors. */
export type FeedState = 'WAITING' | 'HEALTHY' | 'LATE' | 'REJECTING' | 'FAILING' | 'PAUSED' | 'NOT_SET_UP' | 'CLOSED';

export interface Window { open: number; close: number }   // 15-minute slots of the day, [open, close)

/**
 * One verdict per feed, from how long it has been silent and how much of what it sent was turned away.
 * `minutesSilent` should already be counted in opening hours (see openMinutesBetween): a contact centre that is shut is not a late feed.
 * `closedNow` only matters when nothing is overdue: the feed is quiet because the queues are closed, which is expected.
 */
export function feedState(o: { everReceived: boolean; minutesSilent: number | null; lateAfterMin: number; received24h?: number; rejected24h?: number; closedNow?: boolean }): FeedState {
  if (!o.everReceived) return 'WAITING';
  if (o.minutesSilent === null || o.minutesSilent > o.lateAfterMin) return 'LATE';
  if ((o.received24h ?? 0) > 0 && (o.rejected24h ?? 0) / (o.received24h as number) >= 0.2) return 'REJECTING';
  return o.closedNow ? 'CLOSED' : 'HEALTHY';
}

const slotFormats = new Map<string, Intl.DateTimeFormat>();
/** 15-minute slot of the day (0-95) at instant `t` in the organisation's time zone. */
export function slotAt(t: Date, tz: string): number {
  let f = slotFormats.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); slotFormats.set(tz, f); }
  const parts = f.formatToParts(t);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0), m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return Math.floor((h * 60 + m) / 15);
}

/** No queues, or none with hours, means the feed is expected around the clock. */
export const isOpenAt = (t: Date, tz: string, windows: Window[]) => {
  if (!windows.length) return true;
  const s = slotAt(t, tz);
  return windows.some((w) => s >= w.open && s < w.close);
};

/**
 * Minutes between two instants during which at least one queue was open, so a feed is judged only on the time it was expected to send.
 * Stops counting past `cap` (the caller only needs to know whether the limit was exceeded), which keeps a feed silent for weeks cheap.
 */
export function openMinutesBetween(from: Date, to: Date, tz: string, windows: Window[], cap = Infinity): number {
  const STEP = 15 * 60_000;
  let total = 0;
  for (let t = from.getTime(); t < to.getTime() && total <= cap; t += STEP) {
    if (isOpenAt(new Date(t), tz, windows)) total += Math.min(15, (to.getTime() - t) / 60_000);
  }
  return total;
}

// ---------------------------------------------------------------- how a history source is described

export type SourceKind = 'PUSH' | 'DATABASE' | 'DATABASE_RELAY' | 'API' | 'FILES';

/** What sort of source a connector preset is, in the words the Data Feeds page uses. Anything not listed is pushed to us (a relay or the phone system). */
export function sourceKind(presetId: string): SourceKind {
  if (presetId === 'DATABASE_POSTGRES_PULL') return 'DATABASE';
  if (presetId === 'GENERIC_DATABASE') return 'DATABASE_RELAY';
  if (presetId === 'GENERIC_ACD_API') return 'API';
  if (presetId === 'GENERIC_SFTP') return 'FILES';
  return 'PUSH';
}

/** The one thing to do next to finish setting a history source up, or null when it is set up. */
export function nextStep(o: { kind: SourceKind; status: string; backfillStatus: string; scheduled: boolean; canPull: boolean; everReceived: boolean }): string | null {
  if (o.status === 'DRAFT') return 'Set it to Active to start it.';
  if (o.status === 'PAUSED' || o.status === 'ERROR') return null;
  if (o.kind === 'DATABASE' && o.backfillStatus === 'NOT_STARTED') return 'Test the query, then load history so forecasts have something to learn from.';
  if (o.canPull && !o.scheduled) return 'Choose when we should fetch it.';
  if (!o.canPull && !o.everReceived) return o.kind === 'DATABASE_RELAY' ? 'Waiting for the relay inside your network to send its first rows.' : 'Waiting for the first delivery. Give your IT team the key and the address.';
  return null;
}
