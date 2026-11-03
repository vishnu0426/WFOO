/**
 * What the screens have already asked the gateway, kept so the next screen to ask gets the answer at once and checks for changes in the background
 * ("show what I have, then refresh"), and so that ten components asking for the same list at the same moment send one request, not ten.
 *
 *  - A second asker within FRESH_MS shares the answer and the request.
 *  - After any change made through the app (a save, a delete, an import) everything is marked stale: it is still shown instantly if a screen opens, but it is always
 *    fetched again, so nothing edited a moment ago is ever shown as current.
 *  - A handful of small lists that every screen needs (groups, queues, teams, templates, activities, roles) are also kept for the browser tab's lifetime, so even a
 *    full reload shows them straight away while the fresh copy arrives.
 *  - Everything is dropped on sign-out, and a copy kept for the tab is only used by the same sign-in that stored it.
 *
 * No imports: the request function is passed in, so this has no knowledge of the API client (which tells it about changes and sign-outs).
 */
type Entry = { data: unknown; at: number; inflight?: Promise<unknown>; staleMark?: boolean };

const FRESH_MS = 1500;
const MAX_ENTRIES = 300;
const SESSION_KEY = 'wfm_data_cache';
/** Exact paths worth keeping across a reload: small, needed almost everywhere, and cheap to re-check. */
const KEEP = new Set(['/config/groups', '/config/queues', '/workforce/teams?fields=pick', '/scheduling/templates', '/config/activities', '/rbac/matrix', '/config/groups/summary']);
const MAX_KEEP_BYTES = 600_000;

const store = new Map<string, Entry>();
let scope = '';
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const read = (): { s: string; e: Record<string, { data: unknown; at: number }> } | null => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { return null; } };

/** Called by the API client with an id for the current sign-in ('' when signed out). Changing it drops everything held for the previous one. */
export function setScope(id: string) {
  if (id === scope) return;
  scope = id; store.clear();
  if (!id) { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* storage unavailable */ } return; }
  const kept = read();
  if (kept && kept.s === id) for (const [path, v] of Object.entries(kept.e)) store.set(path, { data: v.data, at: 0 });   // shown first, always fetched again
}

const persistSoon = () => {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (!scope) return;
    try {
      const e: Record<string, { data: unknown; at: number }> = {};
      let bytes = 0;
      for (const [path, v] of store) if (KEEP.has(path) && v.data !== undefined) { const j = JSON.stringify(v.data); bytes += j.length; if (bytes <= MAX_KEEP_BYTES) e[path] = { data: v.data, at: v.at }; }
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ s: scope, e }));
    } catch { /* storage full or unavailable: the cache simply stays in memory */ }
  }, 400);
};

/** The answer already held for this path, if any (possibly stale). */
export function peek<T>(path: string): T | undefined { return store.get(path)?.data as T | undefined; }

/** One request per path at a time: asking again while it is running, or just after, shares it. `fetcher` makes the real request. */
export function fetchShared<T>(path: string, fetcher: () => Promise<T>, force = false): Promise<T> {
  const held = store.get(path);
  if (held?.inflight) return held.inflight as Promise<T>;
  if (held && held.data !== undefined && !force && Date.now() - held.at < FRESH_MS) return Promise.resolve(held.data as T);
  const entry: Entry = held ?? { data: undefined, at: 0 };
  if (!held) store.set(path, entry);
  const p = fetcher().then((data) => {
    entry.data = data; entry.inflight = undefined;
    // a change made while this was in flight means the answer may be old already: keep it to show, but call it stale
    entry.at = entry.staleMark ? 0 : Date.now(); entry.staleMark = false;
    store.delete(path); store.set(path, entry);                                 // most recently used last
    while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
    if (KEEP.has(path)) persistSoon();
    return data;
  }, (err) => { entry.inflight = undefined; if (entry.data === undefined) store.delete(path); throw err; });
  entry.inflight = p;
  return p;
}

/** Something was changed through the app: whatever is held may be out of date now. It stays available to show, but is fetched again whenever asked for. */
export function markStale() { for (const e of store.values()) { e.at = 0; if (e.inflight) e.staleMark = true; } persistSoon(); }

/** Warm a path so the screen that needs it next finds it ready (for example when the pointer is over its menu item). */
export function prefetch<T>(path: string, fetcher: () => Promise<T>) { if (!store.get(path)?.inflight) void fetchShared(path, fetcher).catch(() => {}); }
