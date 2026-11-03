import { useEffect, useRef, useState } from 'react';
import { api, PayWeekInfo, VersionFull, VersionMeta } from '../../services/api';
import { fetchShared, peek } from '../../services/dataCache';

/** A version with its model summary and audit trail; reloads when the version or its revision changes. */
export function useVersionFull(version: VersionMeta | null) {
  const [full, setFull] = useState<VersionFull | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!version) { setFull(null); return; }
    let live = true;
    api<VersionFull>(`/forecast/versions/${version.id}`)
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
  const shownPath = useRef<string | null>(path);
  useEffect(() => {
    if (!path) { setData(null); setLoading(false); shownPath.current = null; return; }
    let live = true;
    const held = peek<T>(path);
    if (held !== undefined) { setData(held); setLoading(false); }
    else { if (shownPath.current !== path) setData(null); setLoading(true); }          // a different thing is being asked for: do not leave the previous one on screen
    shownPath.current = path;
    fetchShared<T>(path, () => api<T>(path))
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((e) => { if (live) { setData(null); setError(e.message); } })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [path, ...deps]);
  return { data, error, loading };
}
