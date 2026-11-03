/**
 * Shared forecasting state: which WFM group and forecast version the planner is working on,
 * what the signed-in user may do, plus a notice banner. Data itself is fetched by each section from the gateway.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, Group, GroupDto, Queue, Session, VersionKind, VersionMeta } from './api';
import { fetchShared, peek } from './dataCache';

const withQueues = (gs: GroupDto[], qs: Queue[]): Group[] => gs.filter((x) => x.status === 'ACTIVE').map((x) => ({ ...x, queues: qs.filter((q) => q.wfmGroupId === x.id) }));
/** The groups and queues from the last visit to this tab (shown at once while the fresh ones are fetched), so every screen can start its own requests straight away. */
const heldGroups = (): Group[] | null => { const gs = peek<GroupDto[]>('/config/groups'), qs = peek<Queue[]>('/config/queues'); return gs && qs ? withQueues(gs, qs) : null; };
const versionsPath = (groupId: string | null) => (groupId ? `/forecast/versions?groupId=${groupId}` : null);

export type Notice = { kind: 'ok' | 'err' | 'info'; text: string } | null;

type Ctx = {
  groups: Group[];
  group: Group | null;
  setGroupId: (id: string, selectVersionId?: string) => void;
  versions: VersionMeta[];
  version: VersionMeta | null;
  setVersionId: (id: string | null) => void;
  kind: VersionKind;
  setKind: (k: VersionKind) => void;
  reload: (selectId?: string) => Promise<void>;
  reloadGroups: () => Promise<void>;
  ready: boolean;
  session: Session;
  can: (permission: string) => boolean;
  go: (subSection: string, module?: string) => void;
  notice: Notice;
  setNotice: (n: Notice) => void;
};

const StoreCtx = createContext<Ctx>(null as unknown as Ctx);
export const useForecast = () => useContext(StoreCtx);

export const ForecastProvider: React.FC<{
  session: Session;
  onNavigate: (module: string, subSection?: string) => void;
  children: React.ReactNode;
}> = ({ session, onNavigate, children }) => {
  const [groups, setGroups] = useState<Group[]>(() => heldGroups() ?? []);
  const [groupId, setGroupId] = useState<string | null>(() => localStorage.getItem('wfm_group'));
  const pendingSelect = useRef<string | undefined>(undefined);
  const [versions, setVersions] = useState<VersionMeta[]>(() => { const p = versionsPath(localStorage.getItem('wfm_group')); return (p && peek<VersionMeta[]>(p)) || []; });
  const [kind, setKind] = useState<VersionKind>('SHORT');
  const [versionId, setVersionId] = useState<string | null>(null);
  const [ready, setReady] = useState(() => heldGroups() !== null);
  const [notice, setNotice] = useState<Notice>(null);

  const reloadGroups = useCallback(async () => {
    try {
      // shared with every screen that asks for the same lists, so they are fetched once, not once each
      const [gs, qs] = await Promise.all([fetchShared('/config/groups', () => api<GroupDto[]>('/config/groups')), fetchShared('/config/queues', () => api<Queue[]>('/config/queues'))]);
      const g = withQueues(gs, qs);
      setGroups(g);
      setGroupId((cur) => (cur && g.some((x) => x.id === cur) ? cur : g[0]?.id ?? null));
    } catch (e: any) {
      setNotice({ kind: 'err', text: e.message });
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => { reloadGroups(); }, [reloadGroups]);

  // keep the current version if it still fits the chosen kind; otherwise the published one, otherwise the newest
  const pick = (vs: VersionMeta[], k: VersionKind, cur: string | null) => {
    const keep = vs.find((v) => v.id === cur && v.kind === k);
    if (keep) return keep.id;
    const ofKind = vs.filter((v) => v.kind === k);
    return (ofKind.find((v) => v.status === 'PUBLISHED') || ofKind[0] || null)?.id ?? null;
  };

  const reload = useCallback(async (selectId?: string) => {
    if (groupId === null) { setVersions([]); setVersionId(null); return; }
    const path = versionsPath(groupId)!;
    const vs = await fetchShared(path, () => api<VersionMeta[]>(path));
    setVersions(vs);
    const chosen = selectId ? vs.find((v) => v.id === selectId) : undefined;
    if (chosen) setKind(chosen.kind);
    setVersionId((cur) => (chosen ? chosen.id : pick(vs, kind, cur)));
  }, [groupId, kind]);

  useEffect(() => {
    if (groupId !== null) localStorage.setItem('wfm_group', groupId);
    const held = versionsPath(groupId) ? peek<VersionMeta[]>(versionsPath(groupId)!) : undefined;
    if (held) { setVersions(held); setVersionId((cur) => pick(held, kind, cur)); }          // the versions seen last time, shown at once; the fresh list replaces them
    else setVersionId(null);
    const sel = pendingSelect.current; pendingSelect.current = undefined;   // a forecast opened from the All Forecasts list
    reload(sel).catch((e) => setNotice({ kind: 'err', text: e.message }));
  }, [groupId]);
  useEffect(() => { setVersionId((cur) => pick(versions, kind, cur)); }, [kind]);

  const group = groups.find((g) => g.id === groupId) || null;
  const version = versions.find((v) => v.id === versionId) || null;
  const perms = useMemo(() => new Set(session.permissions), [session]);

  const value = useMemo<Ctx>(() => ({
    groups, group, setGroupId: (id, sel) => { pendingSelect.current = sel; setGroupId(id); }, versions, version,
    setVersionId: (id) => { const v = versions.find((x) => x.id === id); if (v) setKind(v.kind); setVersionId(id); },
    kind, setKind, reload, reloadGroups, ready, session, can: (p) => perms.has(p),
    go: (sub, module = 'forecasting') => onNavigate(module, sub), notice, setNotice,
  }), [groups, group, versions, version, kind, reload, reloadGroups, ready, session, perms, onNavigate, notice]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
};
