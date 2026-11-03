/**
 * A short memory of each group's adherence for a day, shared by everyone looking at it. Judging 50,000 people takes seconds, and a screen asks every few
 * seconds from many supervisors: they all get the same answer, at most a few seconds old, and one person's request refreshes it for the rest.
 */
const TODAY_TTL_MS = Math.max(1, Number(process.env.ADHERENCE_CACHE_SEC ?? 5)) * 1000;
const PAST_TTL_MS = 10 * 60_000;           // a finished day changes only when someone adds an exception, which drops it
const MAX_ENTRIES = 12;

interface Entry<T> { at: number; value: T; ms: number; refreshing?: Promise<void> }
const cache = new Map<string, Entry<any>>();
const inFlight = new Map<string, Promise<any>>();

const utcDay = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** A day clearly in the past (whatever the zone) is kept longer than one that may still be filling up. */
const ttlFor = (day: string) => (day < utcDay(-2) ? PAST_TTL_MS : TODAY_TTL_MS);

/**
 * The cached value if it is fresh. If it is a little old it is returned at once and refreshed in the background (so a poll never waits for a recalculation
 * that someone else's poll already started); only a miss, or something much too old, waits.
 */
export async function cached<T>(key: string, day: string, compute: () => Promise<T>): Promise<{ value: T; ageMs: number }> {
  const now = Date.now();
  const e = cache.get(key) as Entry<T> | undefined;
  // a group that takes seconds to judge is not judged again straight away: never more often than every other time it takes (so a huge group cannot keep the server busy for ever)
  const ttl = Math.max(ttlFor(day), (e?.ms ?? 0) * 2);
  const refresh = () => {
    const t0 = Date.now();
    return compute().then((value) => { cache.delete(key); cache.set(key, { at: Date.now(), value, ms: Date.now() - t0 }); while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string); });
  };
  if (e && now - e.at <= ttl) return { value: e.value, ageMs: now - e.at };
  if (e && now - e.at <= ttl * 6 + 30_000) {
    if (!e.refreshing) e.refreshing = refresh().catch((err) => console.error('[adherence] refresh failed:', err?.message)).finally(() => { e.refreshing = undefined; });
    return { value: e.value, ageMs: now - e.at };
  }
  let p = inFlight.get(key);
  if (!p) { p = refresh().finally(() => inFlight.delete(key)); inFlight.set(key, p); }
  await p;
  const fresh = cache.get(key) as Entry<T>;
  return { value: fresh.value, ageMs: Date.now() - fresh.at };
}

/** Forget a group's days (after someone adds or removes an exception) so the next look is up to date. Without a group, everything for the tenant. */
export function dropAdherence(tenantId: string, groupId?: string) {
  const prefix = groupId ? `${tenantId}|${groupId}|` : `${tenantId}|`;
  for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k);
}

export const _clearAdherenceCacheForTests = () => { cache.clear(); inFlight.clear(); };
