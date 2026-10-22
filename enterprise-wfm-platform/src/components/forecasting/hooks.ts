import { useEffect, useState } from 'react';
import { api, VersionFull, VersionMeta } from '../../services/api';

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

/** Fetch helper that ignores stale responses and exposes loading / error state. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) { setData(null); return; }
    let live = true;
    setLoading(true);
    api<T>(path)
      .then((d) => { if (live) { setData(d); setError(''); } })
      .catch((e) => { if (live) { setData(null); setError(e.message); } })
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [path, ...deps]);
  return { data, error, loading };
}
