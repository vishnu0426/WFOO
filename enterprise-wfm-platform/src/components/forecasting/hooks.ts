import { useCallback, useEffect, useRef, useState } from 'react';
import { api, PayWeekInfo, VersionFull, VersionMeta } from '../../services/api';
import { fetchShared, peek } from '../../services/dataCache';

/** A version with its model summary and audit trail; reloads when the version or its revision changes. */
export function useVersionFull(version: VersionMeta | null) {
  const [full, setFull] = useState<VersionFull | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!version) { setFull(null); return; }
    let live = true;
    // the dashboard and the version actions both ask for this: one request, shared (the revision and status in the address keep a changed forecast from being served from the held copy)
    const path = `/forecast/versions/${version.id}?rev=${version.rev}&status=${version.status}`;
    fetchShared<VersionFull>(path, () => api<VersionFull>(path))
      .then((v) => { if (live) { setFull(v); setError(''); } })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [version?.id, version?.rev, version?.status]);
  return { full, error };
}

/** The weekday a group's pay week starts on (Monday 0 ... Sunday 6), so a screen can show weeks the way people are paid. Monday until it loads. */
export function usePayWeek(groupId: string | null | undefined): number {
  const r = useApi<PayWeekInfo>(groupId ? `/scheduling/pay-week?groupId=${groupId}` : null, [groupId]);
  return r.data?.start ?? 0;
}

/**
 * Fetch helper with loading / error state. It shows the last answer for this path at once (and fetches again behind it), shares one request between components that ask for
 * the same thing at the same moment, and ignores a response that arrives after the screen has moved on. See services/dataCache.ts.
 * `loading` is true only while there is nothing to show yet; a refresh behind a shown answer does not flash a "Loading…" state.
 */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(() => (path ? peek<T>(path) ?? null : null));
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(() => !!path && peek<T>(path) === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);
  const shownPath = useRef<string | null>(path);
  const dataRef = useRef<T | null>(data);
  const force = useRef(false);
  /** Ask again now, even if the last answer is fresh (a "Try again" button). */
  const reload = useCallback(() => { force.current = true; setNonce((n) => n + 1); }, []);
  useEffect(() => {
    if (!path) { setData(null); dataRef.current = null; setLoading(false); setRefreshing(false); setError(''); shownPath.current = null; return; }
    let live = true;
    const held = peek<T>(path);
    if (held !== undefined) { setData(held); dataRef.current = held; }
    else if (shownPath.current !== path) { setData(null); dataRef.current = null; }       // a different thing is being asked for: do not leave the previous one on screen
    if (shownPath.current !== path) setError('');
    const showing = dataRef.current !== null;
    setLoading(!showing); setRefreshing(showing);                                         // first load, or a refresh behind what is already shown
    shownPath.current = path;
    const forced = force.current; force.current = false;
    fetchShared<T>(path, () => api<T>(path), forced)
      .then((d) => { if (live) { setData(d); dataRef.current = d; setError(''); setUpdatedAt(Date.now()); } })
      .catch((e) => { if (live) setError(e.message); })                                    // what was shown stays shown: the screen says the refresh failed
      .finally(() => { if (live) { setLoading(false); setRefreshing(false); } });
    return () => { live = false; };
  }, [path, nonce, ...deps]);
  return { data, error, loading, refreshing, reload, updatedAt };
}
